import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { GraphEngine } from '../../src/core/engine.mjs';
import { createAdlcContractPublication } from '../../src/plugin/adlc-contract-publication.mjs';
import { githubHostTransportReadiness } from '../../src/plugin/github-http-transport.mjs';
import { createGitHubMergeJournal } from '../../src/plugin/github-merge-journal.mjs';
import { PaperclipStore, saveMergeRequest } from '../../src/plugin/store.mjs';
import { advanced, app, attestation, base, head, merge, publicationGitHub, repositoryId, versions } from '../helpers/g2-publication-fixture.mjs';
import { createPostgresShadowDatabase, postgresShadowAvailable } from '../helpers/postgres-shadow.mjs';

const skip = !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL';
const kind = 'contract_publication_request';
const repository = 'example/app';
const actor = { id: 'owner', kind: 'human' };
const fingerprint = 'f'.repeat(64);

async function harness(t) {
  const data = await createPostgresShadowDatabase(t, { full: true });
  const { db, companyId } = data;
  const store = new PaperclipStore(db, companyId);
  const engine = new GraphEngine({ store });
  const github = publicationGitHub(repository, new Map());
  const config = { githubApp: app, githubTransportAttestation: attestation, adlcProjects: { project: { ownerId: actor.id } } };
  const service = createAdlcContractPublication({
    host: { db, config: { get: async () => config }, http: { fetch: github.fetch }, secrets: { resolve: github.resolve } },
    engineFor: async () => ({ engine }), transportReadiness: value => githubHostTransportReadiness(value, versions),
  });
  return { ...data, store, engine, github, service, journal: createGitHubMergeJournal(db) };
}

async function seed(h, id, state, { rowRepoId = repositoryId, repoNodeId = h.github.repo.node_id,
  mergeSha = merge, marked = false, age = 30, execution } = {}) {
  const { sql, namespace, companyId, store } = h;
  const runId = 'run-' + id, issueId = 'issue-' + id, decisionId = 'decision-' + id, pullNumber = id + 100;
  const row = { companyId, issueId, runId, nodeId: 'publish-baseline', attemptIndex: 1, kind };
  const manifest = { id: 'manifest', revisionId: 'v1' };
  const publication = { repository, pullNumber, section: 'product', decisionId, manifestId: manifest.id, revisionId: manifest.revisionId,
    manifestDigest: fingerprint, mode: 'manual', baseSha: base, headSha: head, contractId: 'PRC-000000000007', supersedes: null };
  const snapshot = await store.read() ?? { revision: 0, runs: {}, packs: {}, decisions: [], audit: [], idempotency: {} };
  snapshot.runs[runId] = { id: runId, status: 'completed', input: { paperclipIssueId: issueId, paperclipCompanyId: companyId, projectId: 'project' } };
  await store.write({ ...snapshot, revision: snapshot.revision + 1 }, snapshot.revision);
  await saveMergeRequest(h.db, companyId, snapshot.revision + 1, { ...row, fingerprint, disposition: 'admitted', reason: null,
    request: { kind, projectId: 'project', repository, payload: { runId, decisionId, pullNumber, manifest } } });
  const op = id.toString(16).padStart(64, '0');
  const temp = 'refs/heads/polyforge-merge-' + randomUUID();
  await sql.unsafe('INSERT INTO ' + namespace + '.github_merge_journal ' +
    '(repository_node_id,repository_id,app_id,installation_id,company_id,run_id,node_id,attempt_index,kind,pull_number,operation_key,' +
    'fence,claim_id,claim_until,state,base_sha,head_sha,temp_ref,merge_sha,publication_json,authorization_revision,observe_after,' +
    'missing_fact,updated_at,patch_send_started) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,1,$11,now(),$12,$13,$14,$15,$16,$17,1,' +
    "now()-interval '1 hour',$18,now()-$19 * interval '1 second',$20)",
  [repoNodeId, rowRepoId, app.appId, app.installationId, companyId, runId, row.nodeId, kind, pullNumber, op, randomUUID(), state,
    base, head, temp, mergeSha, JSON.stringify(publication), state === 'unresolved' ? 'main-ancestry-unproven' : null, age, marked]);
  if (execution) {
    await sql.unsafe('UPDATE ' + namespace + '.adlc_merge_requests SET execution_state=$1, operation_key=$2 WHERE run_id=$3',
      [execution, op, runId]);
  }
  return { ...row, op, temp, publication, repoNodeId, rowRepoId };
}

test('owner recovery is audited, idempotent and requires positive proof', { skip }, async t => {
  const h = await harness(t);
  const recover = (row, owner = actor) => h.service.recover({ ...row, actor: owner, recoveryAction: 'reschedule' });
  const ancestry = await seed(h, 1, 'unresolved', { execution: 'unresolved', marked: true });
  h.github.main = merge;
  await assert.rejects(recover(ancestry, { ...actor, id: 'admin' }), /requires-project-owner/);
  assert.deepEqual(await recover(ancestry), { outcome: 'ancestry' });
  assert.deepEqual(await recover(ancestry), { outcome: 'ancestry' });
  assert.equal((await h.journal.byRepository(ancestry.repoNodeId)).state, 'acked');
  assert.equal((await h.engine.getRun(ancestry.runId)).contractMerges.length, 1);

  // Make another operation in the same repository so GitHub identity stays constant.
  await h.sql.unsafe('DELETE FROM ' + h.namespace + '.github_merge_receipts WHERE operation_key=$1', [ancestry.op]);
  await h.sql.unsafe('DELETE FROM ' + h.namespace + '.github_merge_journal WHERE operation_key=$1', [ancestry.op]);
  const abandoned = await seed(h, 2, 'unresolved', { execution: 'unresolved' });
  h.github.main = base;
  h.github.refs.set(abandoned.temp, merge);
  await assert.rejects(recover(abandoned), /proof-unavailable/);
  assert.equal((await h.journal.byRepository(abandoned.repoNodeId)).state, 'unresolved');
  h.github.main = advanced;
  await h.sql.unsafe('UPDATE ' + h.namespace + '.github_merge_journal SET patch_send_started=true WHERE operation_key=$1', [abandoned.op]);
  await assert.rejects(recover(abandoned), /proof-unavailable/);
  assert.equal(h.github.refs.get(abandoned.temp), merge);
  await h.sql.unsafe('UPDATE ' + h.namespace + '.github_merge_journal SET patch_send_started=false WHERE operation_key=$1', [abandoned.op]);
  assert.deepEqual(await recover(abandoned), { outcome: 'abandoned' });
  assert.deepEqual(await recover(abandoned), { outcome: 'abandoned' });
  assert.equal(h.github.refs.has(abandoned.temp), false);
  assert.equal(h.github.calls.filter(call => call.method === 'PATCH').length, 0);
  const archive = await h.sql.unsafe('SELECT proof_json FROM ' + h.namespace + '.github_merge_recovery ORDER BY operation_key');
  assert.deepEqual(archive.map(row => row.proof_json.outcome), ['ancestry', 'abandoned']);
  assert.ok(archive.every(row => row.proof_json.actorId === actor.id));
  const attempts = await h.sql.unsafe('SELECT outcome,actor_id,reason FROM ' + h.namespace + '.github_merge_recovery_attempts ORDER BY id');
  assert.deepEqual([...attempts], Array.from({ length: 2 }, () => ({
    outcome: 'refused', actor_id: actor.id, reason: 'publication-recovery-proof-unavailable',
  })));
  const released = await h.journal.byRepository(abandoned.repoNodeId);
  assert.equal(released.state, 'abandoned');
  assert.equal(await h.journal.takeover({ ...released, operation_key: 'f'.repeat(64), claim_id: randomUUID() }, released, 60), true);
  assert.deepEqual(await recover(abandoned), { outcome: 'abandoned' });
});

for (const [label, mergeSha, marked, target, main, expected] of [
  ['both SHA and ref absent', null, false, null, advanced, 'abandoned'],
  ['saved SHA and absent ref', merge, false, null, advanced, 'abandoned'],
  ['absent ref after send boundary', merge, true, null, advanced, 'refused'],
  ['unsaved merge commit already on main', null, false, merge, merge, 'refused'],
  ['unsaved merge commit on the temp ref', null, false, merge, advanced, 'abandoned'],
  ['guarded temp ref moved to another eligible commit', null, false, merge, advanced, 'abandoned'],
]) {
  test('owner recovery handles ' + label, { skip }, async t => {
    const h = await harness(t);
    const row = await seed(h, 1, 'unresolved', { mergeSha, marked, execution: 'unresolved' });
    h.github.main = main;
    if (target) h.github.refs.set(row.temp, target);
    if (label.startsWith('guarded')) {
      assert.equal(await h.journal.authorizeRecoveryDelete(await h.journal.byRepository(row.repoNodeId), base), true);
    }
    const action = h.service.recover({ ...row, actor, recoveryAction: 'reschedule' });
    if (expected === 'refused') {
      await assert.rejects(action, /proof-unavailable/);
      assert.equal((await h.journal.byRepository(row.repoNodeId)).state, 'unresolved');
      assert.equal(h.github.calls.filter(call => call.method === 'DELETE').length, 0);
      return;
    }
    assert.deepEqual(await action, { outcome: 'abandoned' });
    const { proof_json: proof } = await h.journal.recoveryBySubject({
      company_id: row.companyId, run_id: row.runId, node_id: row.nodeId, attempt_index: 1, kind,
    });
    assert.deepEqual(proof, { outcome: 'abandoned', actorId: actor.id, mainSha: main, tempSha: target });
    assert.equal(h.github.refs.has(row.temp), false);
    assert.equal(h.github.calls.filter(call => call.path.endsWith(row.temp.slice('refs/'.length))
      && call.method === 'GET').length, target ? 3 : 2);
  });
}

test('owner command returns acknowledged state after reconciling a patched row', { skip }, async t => {
  const h = await harness(t);
  const row = await seed(h, 1, 'patched');
  assert.deepEqual(await h.service.recover({ ...row, actor, recoveryAction: 'reschedule' }), { state: 'acked' });
});

test('intent rejects a recovered operation key after the repository slot has turned over', { skip }, async t => {
  const h = await harness(t);
  const row = await seed(h, 1, 'unresolved', { mergeSha: null, execution: 'unresolved' });
  h.github.main = advanced;
  assert.deepEqual(await h.service.recover({ ...row, actor, recoveryAction: 'reschedule' }), { outcome: 'abandoned' });
  const abandoned = await h.journal.byRepository(row.repoNodeId);
  const intervening = { ...abandoned, operation_key: 'a'.repeat(64), claim_id: randomUUID() };
  assert.equal(await h.journal.takeover(intervening, abandoned, 60), true);
  const current = await h.journal.byRepository(row.repoNodeId);
  await h.journal.abandon(current);
  assert.equal(await h.journal.takeover({ ...abandoned, claim_id: randomUUID() }, current, 60), true);
  const reused = await h.journal.byRepository(row.repoNodeId);
  assert.equal(reused.operation_key, row.op);
  assert.equal(await h.journal.intent(reused, row.publication, 1, row.temp), false);
  assert.equal((await h.journal.byRepository(row.repoNodeId)).state, 'claimed');
});

test('the periodic scanner rotates limit + 1 rows in every state, including failed cleanup', { skip }, async t => {
  const h = await harness(t);
  const { sql, namespace } = h;
  const states = ['intent', 'patched', 'recorded', 'unresolved', 'abandoned'];
  const entries = [];
  for (const [i, state] of states.entries()) {
    for (const [j, age] of [60, 30].entries()) {
      const id = i * 2 + j + 10;
      entries.push(await seed(h, id, state, { rowRepoId: id, repoNodeId: 'node-' + id, age }));
    }
  }
  // All observations and the preexisting recorded rows fail. Force the oldest patched row's Core write to fail as well.
  let cleaning = false;
  h.github.fail = (method, tail) => method === 'DELETE' || (!cleaning && method === 'GET' && tail === '');
  const originalRecord = h.engine.recordContractMerge.bind(h.engine);
  h.engine.recordContractMerge = (...args) => {
    if (args[0] === 'run-12') throw new Error('simulated Core recording failure');
    return originalRecord(...args);
  };
  // Keep intent failure rows in their scan phase to exercise the ordering under repeated failures.
  const real = h.db.execute.bind(h.db);
  h.db.execute = (statement, args) => {
    if (statement.includes("SET state='unresolved'")) throw new Error('simulated observation persistence failure');
    if (statement.includes('.github_merge_recovery') && statement.startsWith('INSERT')) {
      throw new Error('simulated abandoned archival failure');
    }
    if (statement.includes('SET cleanup_attempt_at=')) cleaning = true;
    return real(statement, args);
  };
  const cleanup = [];
  for (const [i, age] of [60, 30].entries()) {
    const data = await seed(h, 30 + i, 'acked', { rowRepoId: repositoryId + i, repoNodeId: i ? 'node-cleanup-2' : h.github.repo.node_id });
    cleanup.push(data);
    await sql.unsafe('INSERT INTO ' + namespace + '.github_merge_receipts ' +
      '(repository_node_id,pull_number,operation_key,company_id,run_id,receipt_json,temp_ref,created_at) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,now()-$8 * interval '1 second')",
    [data.repoNodeId, data.publication.pullNumber, data.op, data.companyId, data.runId,
      JSON.stringify({ ...data.publication, mergeCommitSha: merge }), data.temp, age]);
  }
  h.github.refs.set(cleanup[0].temp, merge);
  const timestamp = async entry => (await h.journal.byRepository(entry.repoNodeId)).updated_at;
  const before = await Promise.all(entries.map(timestamp));
  cleaning = false;
  await h.service.scan(1);
  const first = await Promise.all(entries.map(timestamp));
  assert.equal(h.github.calls.filter(call => call.method === 'DELETE').length, 1);
  for (let i = 0; i < entries.length; i++) {
    assert.equal(first[i] !== before[i], i % 2 === 0);
  }
  cleaning = false;
  await h.service.scan(1);
  const second = await Promise.all(entries.map(timestamp));
  for (let i = 1; i < entries.length; i += 2) assert.notEqual(second[i], first[i]);
  const receipts = await sql.unsafe('SELECT cleanup_attempt_at,cleanup_state FROM ' + namespace +
    '.github_merge_receipts WHERE operation_key IN ($1,$2) ORDER BY operation_key', cleanup.map(row => row.op));
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every(row => row.cleanup_attempt_at && row.cleanup_state === 'pending'));
});
