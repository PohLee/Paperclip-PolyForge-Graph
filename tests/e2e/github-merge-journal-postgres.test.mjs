import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphEngine } from '../../src/core/index.mjs';
import { PaperclipStore } from '../../src/plugin/store.mjs';
import { createGitHubMergeJournal } from '../../src/plugin/github-merge-journal.mjs';
import { createPostgresShadowDatabase, postgresShadowAvailable } from '../helpers/postgres-shadow.mjs';
import { commit, descendant, fakeGitHub, mutations, nodeId, request, scope, secret, signal, writer } from '../helpers/github-journal-fixture.mjs';

const options = { skip: !postgresShadowAvailable };
const authorize = async () => ({ revision: '9007199254740993' });
const receiptFor = input => {
  const { runId, ...fields } = input;
  return { ...fields, mergeCommitSha: commit };
};

async function fixture(t) {
  const db = await createPostgresShadowDatabase(t, { full: true });
  const a = createGitHubMergeJournal(db.db);
  const b = createGitHubMergeJournal(db.independentDatabase());
  const github = fakeGitHub();
  const binding = scope(db.companyId);
  const counterpart = scope(db.otherCompanyId);
  const journalTable = db.namespace + '.github_merge_journal';
  const queue = db.namespace + '.adlc_merge_requests';
  async function expire(column) {
    assert.ok(['claim_until', 'observe_after'].includes(column));
    await db.sql.unsafe(`UPDATE ${journalTable} SET ${column}=now()-interval '1 second'`);
  }
  async function projectAndAck(row, receipt) {
    await db.sql.unsafe(`INSERT INTO ${queue}
      (company_id,run_id,node_id,attempt_index,kind,request_json,disposition,observed_revision,operation_key,execution_state,receipt_json)
      VALUES ($1,$2,$3,$4,$5,'{}','admitted',0,$6,'recorded',$7::jsonb)`,
    [row.company_id, row.run_id, row.node_id, row.attempt_index, row.kind, row.operation_key, JSON.stringify(receipt)]);
    assert.equal(await b.acked(row, receipt), true);
  }
  return { ...db, a, b, github, binding, counterpart, expire, projectAndAck,
    first: writer(a, github, binding), second: writer(b, github, counterpart) };
}

test('a shared repository has one writer, exact permanent receipts and fenced slot turnover', options, async t => {
  const h = await fixture(t);
  const input = request();
  const atIntent = signal(), resume = signal();
  const result = h.first.merge({ ...input, untrusted: secret }, async phase => {
    if (phase === 'intent') {
      atIntent.release();
      await resume.pending;
    }
    return authorize();
  });
  await atIntent.pending;
  try {
    await assert.rejects(h.second.merge(input, authorize), /github-merge-repository-busy/);
    await assert.rejects(writer(h.b, h.github, { ...h.counterpart, installationId: 99 }).merge(input, authorize),
      /github-merge-repository-binding-conflict/);
    assert.deepEqual(mutations(h.github), []);
  } finally { resume.release(); }
  assert.equal(await result, commit);
  assert.deepEqual(mutations(h.github), ['POST', 'POST', 'PATCH']);
  const receipt = receiptFor(input);
  const recorded = await h.first.record(input, receipt);
  assert.equal(recorded.authorization_revision, '9007199254740993');
  assert.deepEqual(await h.b.bySubject(recorded), [recorded]);
  assert.deepEqual(await h.b.due('recorded', 1), [recorded]);
  assert.equal((await h.b.pendingCleanup(1))[0].operation_key, recorded.operation_key);
  assert.deepEqual(recorded.publication_json, Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'mergeCommitSha')));
  assert.equal(await h.b.acked(recorded, receipt), false);
  await h.projectAndAck(recorded, receipt);
  await assert.rejects(h.second.merge(input, authorize), /github-merge-pull-already-recorded/);
  await assert.rejects(writer(h.b, h.github, { ...h.counterpart, installationId: 99 }).merge(request({ pullNumber: 43 }), authorize),
    /github-merge-repository-binding-conflict/);
  await assert.rejects(h.second.merge(request({ pullNumber: 43 }), async () => { throw new Error(secret); }),
    /github-merge-intent-unavailable/);
  const reused = await h.b.byRepository(nodeId);
  assert.equal(reused.fence, '2');
  assert.equal(reused.company_id, h.otherCompanyId);
  assert.deepEqual(await h.first.getMergeReceipt(input), receipt);
  assert.deepEqual((await h.a.receiptByOperation(recorded.operation_key)).receipt_json, receipt);
  assert.doesNotMatch(JSON.stringify([recorded, reused, await h.b.receipt(nodeId, 42)]), /fixture-secret/);
});

test('a paused intent sender stops after a competing worker and reschedule observation', options, async t => {
  const h = await fixture(t);
  const paused = signal(), resume = signal();
  const interrupted = writer({ ...h.a, async intent(...args) {
    const result = await h.a.intent(...args);
    paused.release();
    await resume.pending;
    return result;
  } }, h.github, h.binding);
  const pending = interrupted.merge(request(), authorize);
  const rejected = assert.rejects(pending, /github-merge-unresolved/);
  await paused.pending;
  try {
    await assert.rejects(writer(h.b, h.github, h.binding).getMergeReceipt(request()), /github-merge-reconciling/);
    await h.expire('claim_until');
    await h.expire('observe_after');
    assert.equal((await h.b.due('intent', 1)).length, 1);
    await assert.rejects(h.second.merge(request(), authorize), /github-merge-repository-busy/);
    // The reschedule command is PR-B2. Exercise its read-only reconciliation path.
    await assert.rejects(writer(h.b, h.github, h.binding).getMergeReceipt(request()), /github-merge-unresolved/);
  } finally { resume.release(); }
  await rejected;
  assert.deepEqual(mutations(h.github), []);
  assert.equal((await h.b.byRepository(nodeId)).state, 'unresolved');
  assert.equal(await h.b.receipt(nodeId, 42), undefined);
});

for (const [name, method, path, count] of [
  ['after the ref POST', 'POST', '/git/refs', 1],
  ['after the merge POST before the SHA CAS', 'POST', '/merges', 2],
  ['after PATCH before its journal acknowledgment', 'PATCH', '/git/refs/heads/main', 3],
]) {
  test(`recovers an interruption ${name}`, options, async t => {
    const h = await fixture(t);
    h.github.after = (verb, tail) => {
      if (verb === method && tail === path) {
        throw new Error(secret);
      }
    };
    if (method === 'PATCH') {
      h.github.after = verb => { if (verb === 'PATCH') h.github.main = descendant; };
      let interrupted = false;
      const sender = writer({ ...h.a, async patched(row) {
        if (!interrupted) {
          interrupted = true;
          throw new Error(secret);
        }
        return h.a.patched(row);
      } }, h.github, h.binding);
      assert.equal(await sender.merge(request(), authorize), commit);
      assert.equal(interrupted, true);
      assert.equal((await h.b.byRepository(nodeId)).state, 'patched');
      assert.deepEqual(await writer(h.b, h.github, h.binding).getMergeReceipt(request()), receiptFor(request()));
      assert.ok(h.github.calls.some(call => call.tail === '/compare/' + commit + '...' + descendant));
    } else {
      await assert.rejects(h.first.merge(request(), authorize), /github-merge-unresolved/);
      const row = await h.b.byRepository(nodeId);
      assert.equal(row.missing_fact, 'merge-sha-not-persisted');
      assert.ok(h.github.refs.has(row.temp_ref));
      await assert.rejects(h.first.getMergeReceipt(request()), /github-merge-unresolved/);
    }
    assert.equal(mutations(h.github).length, count);
  });
}

test('Core receipt recovery and empty-204 DELETE ambiguity preserve one PATCH', options, async t => {
  const h = await fixture(t);
  const input = request();
  assert.equal(await h.first.merge(input, authorize), commit);
  const store = new PaperclipStore(h.db, h.companyId);
  await store.write({ revision: 1, packs: {}, decisions: [], audit: [], idempotency: {},
    runs: { [input.runId]: { id: input.runId, input: { projectId: h.binding.projectId } } },
  }, 0);
  const engine = new GraphEngine({ store });
  const expected = receiptFor(input);
  assert.deepEqual(await engine.recordContractMerge(input.runId, expected), expected);
  assert.equal((await h.b.byRepository(nodeId)).state, 'patched');
  assert.equal(await h.b.receipt(nodeId, input.pullNumber), undefined);

  const recovered = writer(h.b, h.github, h.binding);
  const restarted = new GraphEngine({ store: new PaperclipStore(h.independentDatabase(), h.companyId) });
  const proof = await recovered.getMergeReceipt(input);
  assert.deepEqual(proof, expected);
  const receipt = await restarted.recordContractMerge(input.runId, proof);
  assert.deepEqual(receipt, expected);
  assert.equal((await restarted.getAudit({ runId: input.runId })).filter(event => event.kind === 'contract.merged').length, 1);
  const recorded = await recovered.record(input, receipt);
  assert.equal(recorded.state, 'recorded');
  assert.deepEqual(await recovered.record(input, receipt), recorded);
  await h.projectAndAck(recorded, receipt);
  h.github.after = method => { if (method === 'DELETE') throw new TypeError(secret); };
  assert.equal(await recovered.cleanup(input), 'complete');
  assert.equal(await recovered.cleanup(input), 'complete');
  assert.deepEqual(mutations(h.github), ['POST', 'POST', 'PATCH', 'DELETE']);
  assert.equal(h.github.calls.filter(call => call.method === 'GET' && call.tail.endsWith(recorded.temp_ref.slice(5))).length, 2);
});

test('an expired claim is taken over and its original fence cannot grant intent', options, async t => {
  const h = await fixture(t);
  const paused = signal(), resume = signal();
  const result = h.first.merge(request(), async () => {
    paused.release();
    await resume.pending;
    return authorize();
  });
  const rejected = assert.rejects(result, /github-merge-intent-unavailable/);
  await paused.pending;
  try {
    await h.expire('claim_until');
    assert.equal(await h.second.merge(request({ pullNumber: 43 }), authorize), commit);
  } finally { resume.release(); }
  await rejected;
  assert.equal((await h.b.byRepository(nodeId)).fence, '2');
  assert.deepEqual(mutations(h.github), ['POST', 'POST', 'PATCH']);
});

test('a lost intent acknowledgment leaves durable intent and never sends', options, async t => {
  const h = await fixture(t);
  const writerA = writer({ ...h.a, async intent(...args) {
    assert.equal(await h.a.intent(...args), true);
    throw new Error(secret);
  } }, h.github, h.binding);
  await assert.rejects(writerA.merge(request(), authorize), /github-merge-intent-unavailable/);
  assert.equal((await h.b.byRepository(nodeId)).state, 'intent');
  await h.expire('observe_after');
  await assert.rejects(writer(h.b, h.github, h.binding).getMergeReceipt(request()), /github-merge-unresolved/);
  assert.deepEqual(mutations(h.github), []);
});

test('a late original PATCH is resolved by positive ancestry after an unresolved observation', options, async t => {
  const h = await fixture(t);
  const paused = signal(), resume = signal();
  h.github.before = async method => {
    if (method === 'PATCH') {
      paused.release();
      await resume.pending;
    }
  };
  h.github.after = method => { if (method === 'PATCH') h.github.main = descendant; };
  const result = h.first.merge(request(), authorize);
  await paused.pending;
  try {
    await h.expire('observe_after');
    await assert.rejects(writer(h.b, h.github, h.binding).getMergeReceipt(request()), /github-merge-unresolved/);
    assert.equal((await h.b.byRepository(nodeId)).state, 'unresolved');
  } finally { resume.release(); }
  assert.equal(await result, commit);
  assert.equal((await h.b.byRepository(nodeId)).state, 'patched');
  assert.deepEqual(mutations(h.github), ['POST', 'POST', 'PATCH']);
});


for (const status of [401, 422]) {
  test(`PATCH HTTP ${status} remains unresolved without replay`, options, async t => {
    const h = await fixture(t);
    h.github.patchStatus = status;
    const hooks = [];
    await assert.rejects(h.first.merge(request(), phase => {
      hooks.push(phase);
      return authorize();
    }), /github-merge-unresolved/);
    assert.deepEqual(hooks, ['intent', 'patch']);
    await assert.rejects(writer(h.b, h.github, h.binding).merge(request(), authorize), /github-merge-unresolved/);
    assert.equal((await h.b.byRepository(nodeId)).missing_fact, 'main-ancestry-unproven');
    assert.deepEqual(mutations(h.github), ['POST', 'POST', 'PATCH']);
  });
}
