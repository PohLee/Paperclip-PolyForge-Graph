import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubMergeJournal } from '../../src/plugin/github-merge-journal.mjs';
import { validatePluginRuntimeExecute, validatePluginRuntimeQuery } from '../helpers/paperclip-sql-validator.mjs';
import { base, head, commit, fakeGitHub, mutations, nodeId, request, scope, secret, writer } from '../helpers/github-journal-fixture.mjs';

const namespace = 'plugin_journal_test';
const companyId = 'ca57aae0-4f50-42fc-a7ed-77018de9439c';
const row = {
  repository_node_id: nodeId, repository_id: 101n, app_id: 10n, installation_id: 20n, fence: 2n,
  company_id: companyId, run_id: 'run', node_id: 'publisher', attempt_index: 1, kind: scope(companyId).kind,
  pull_number: 42, operation_key: '1'.repeat(64), state: 'claimed',
  claim_id: 'ca57aae0-4f50-42fc-a7ed-77018de9439d', merge_sha: commit,
  authorization_revision: 3n, publication_json: '{"baseSha":"test"}',
};

test('every runtime statement passes the Paperclip validators and bigint reads are RPC-safe', async () => {
  let writes = 0, reads = 0;
  const journal = createGitHubMergeJournal({
    namespace,
    query: async (sql, params) => {
      validatePluginRuntimeQuery(sql, namespace);
      assert.ok(params.every(param => param !== undefined));
      return ++reads === 1 ? [row] : [];
    },
    execute: async (sql, params) => {
      validatePluginRuntimeExecute(sql, namespace);
      assert.doesNotMatch(sql, /\bRETURNING\b/i);
      const placeholders = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
      assert.equal(Math.max(...placeholders), params.length);
      assert.ok(params.every(param => param !== undefined));
      return { rowCount: writes++ % 2 };
    },
  });
  const decoded = await journal.byRepository(nodeId);
  assert.equal(decoded.fence, '2');
  assert.equal(decoded.repository_id, '101');
  assert.equal(decoded.authorization_revision, '3');
  assert.deepEqual(decoded.publication_json, { baseSha: 'test' });
  assert.doesNotThrow(() => JSON.stringify(decoded));
  await journal.byRepositoryId('101');
  await journal.bySubject(decoded);
  await journal.receipt(nodeId, 42);
  await journal.receiptByOperation(decoded.operation_key);
  await journal.due('intent', 10);
  await journal.observationDue(decoded);
  await journal.pendingCleanup(10);
  const publication = { baseSha: base, headSha: head };
  const receipt = { ...publication, mergeCommitSha: commit };
  assert.equal(await journal.claim(decoded, 60), false);
  assert.equal(await journal.takeover(decoded, decoded, 60), true);
  await journal.abandon(decoded);
  await journal.intent(decoded, publication, '3', 'refs/heads/temp');
  await journal.mergeSha(decoded, commit);
  await journal.patched(decoded);
  await journal.unresolved(decoded, 'main-ancestry-unproven');
  await journal.insertReceipt(decoded, receipt);
  await journal.recorded(decoded, receipt);
  await journal.acked(decoded, receipt);
  await journal.cleanup(decoded, 'complete');
  assert.equal(reads, 8);
  assert.equal(writes, 11);
});

for (const stage of ['claim', 'intent', 'sha']) {
  for (const ambiguous of [false, true]) {
    test(`a ${ambiguous ? 'lost acknowledgment' : 'CAS miss'} at ${stage} grants no subsequent GitHub write`, async () => {
      const github = fakeGitHub();
      let current;
      const journal = createGitHubMergeJournal({
        namespace,
        async query(sql) {
          validatePluginRuntimeQuery(sql, namespace);
          return current && sql.includes('FROM ' + namespace + '.github_merge_journal') ? [current] : [];
        },
        async execute(sql, params) {
          validatePluginRuntimeExecute(sql, namespace);
          assert.doesNotMatch(JSON.stringify(params), /fixture-secret|injected-private-data/);
          const miss = () => {
            if (ambiguous) throw new Error(secret);
            return { rowCount: 0 };
          };
          if (sql.startsWith('INSERT')) {
            if (stage !== 'claim' || ambiguous) current = { ...row, fence: '1', operation_key: params[10],
              claim_id: params[11], merge_sha: null };
            return stage === 'claim' ? miss() : { rowCount: 1 };
          }
          if (sql.includes("SET state='intent'")) {
            if (stage !== 'intent' || ambiguous) current = { ...current, state: 'intent', publication_json: params[7] };
            return stage === 'intent' ? miss() : { rowCount: 1 };
          }
          if (sql.includes('SET merge_sha=')) {
            if (ambiguous) current.merge_sha = commit;
            return miss();
          }
          if (sql.includes("SET state='unresolved'")) current.state = 'unresolved';
          return { rowCount: 1 };
        },
      });
      const adapter = writer(journal, github, scope(companyId));
      await assert.rejects(adapter.merge({ ...request(), untrusted: 'injected-private-data' }, () => ({ revision: 3 })),
        error => /^github-/.test(error.message) && !error.message.includes(secret));
      assert.deepEqual(mutations(github), stage === 'sha' ? ['POST', 'POST'] : []);
    });
  }
}
