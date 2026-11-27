import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { pack } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';
import { GraphEngine } from '../../src/core/index.mjs';
import { PaperclipStore } from '../../src/plugin/store.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import plugin from '../../src/plugin/worker.mjs';

test('the worker starts assisted verification and checks current project config on an agent decision', async t => {
  const priorEntries = process.env.POLYFORGE_PACK_ENTRIES;
  process.env.POLYFORGE_PACK_ENTRIES = fileURLToPath(new URL('../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs', import.meta.url));
  t.after(() => {
    if (priorEntries === undefined) delete process.env.POLYFORGE_PACK_ENTRIES;
    else process.env.POLYFORGE_PACK_ENTRIES = priorEntries;
  });
  const companyId = 'automation-company';
  const projectId = 'project';
  const runtimes = new Map();
  const project = { automationMode: 'assisted' };
  let document;
  let issueProjectId = projectId;
  let verificationId;
  const db = {
    namespace: 'plugin_test',
    async query(sql, [company, issue, runId, nodeId] = []) {
      if (sql.includes('graph_state') && document) return [{ revision: document.revision, document: structuredClone(document) }];
      if (sql.includes('FROM plugin_test.graph_pack_runtime WHERE')) return runtimes.has(issue) ? [runtimes.get(issue)] : [];
      if (sql.includes('FROM plugin_test.graph_dispatch') && company === companyId && issue === 'gate-issue'
          && runId === verificationId && nodeId === 'g5') {
        return [{ attempt: 1, phase: 'work', state: 'woken', issueId: issue, agentId: 'reviewer', agentRunId: 'execution' }];
      }
      return [];
    },
    async execute(sql, [company, key, value, expectedRevision, ...identity] = []) {
      if (sql.includes('INSERT INTO plugin_test.graph_pack_runtime')) {
        const [packDigest, adapterId, adapterVersion, adapterBundleDigest] = identity;
        runtimes.set(key, { packId: value, packVersion: expectedRevision, packDigest, adapterId, adapterVersion, adapterBundleDigest });
        return { rowCount: 1 };
      }
      if (sql.includes('DELETE FROM plugin_test.graph_dispatch_slot')) return { rowCount: 0 };
      if (sql.includes('UPDATE plugin_test.graph_dispatch SET checkout_verified_at')) return { rowCount: 1 };
      assert.ok(sql.includes('graph_state'), sql);
      if (document?.revision !== expectedRevision) return { rowCount: 0 };
      document = JSON.parse(value);
      return { rowCount: 1 };
    },
  };
  await plugin.definition.setup({ manifest, db, logger: { warn() {} },
    config: { get: async scope => {
      assert.equal(scope, companyId);
      return { adlcProjects: { [projectId]: project } };
    } },
    issues: { get: async id => ({ id, projectId: issueProjectId }),
      assertCheckoutOwner: async () => ({ checkoutRunId: 'execution', assigneeAgentId: 'reviewer' }) },
    access: { members: { list: async () => [{ principalType: 'user', principalId: 'owner', status: 'active', membershipRole: 'owner' }] } },
    events: { on() {} }, jobs: { register() {} }, actions: { register() {} }, tools: { register() {} },
  });

  const owner = { actorType: 'user', userId: 'owner' };
  const command = async (body, actor = owner, issueId = 'root', routeKey = 'graph-command') =>
    (await plugin.definition.onApiRequest({ routeKey, companyId, params: { issueId }, actor, body })).body;
  const enabled = await command({ operation: 'enable-pack', companyId, packId: pack.id, version: pack.version,
    reason: 'Install the verification workflow', idempotencyKey: 'enable' }, owner, 'root', 'company-command');
  assert.equal(enabled.error, undefined);

  const start = (graphId, options) => command({ operation: 'start', packId: pack.id, packVersion: pack.version, graphId, ...options });
  const publication = await start('retro-correct', { mode: 'manual', input: {
    retro_evidence: { run_logs: [], decision_records: [], review_findings: [], reverts: [], bugs: [], human_intervention_ledger: [] },
  } });
  assert.ok(publication.run, publication.error);
  const engine = new GraphEngine({ store: new PaperclipStore(db, companyId) });
  const headSha = 'a'.repeat(40);
  const pr_head = { id: 'pr:org/repo#1', version: headSha, repository: 'org/repo', pullNumber: 1, headSha };
  const contract_pins = ['product', 'technical'].map(section => ({ section, contractId: 'C1', commit: headSha }));
  for (const [index, pin] of contract_pins.entries()) {
    await engine.recordContractMerge(publication.run.id, { ...pin, mergeCommitSha: headSha,
      supersedes: null, repository: pr_head.repository, pullNumber: index + 2 });
  }
  const options = { graphVersion: '0.1.9', mode: 'assisted', input: { pr_head, contract_pins,
    verification_scope: { id: 'scope', version: '1', expectedScenarios: ['BDD-1'], dimensions: [] } } };
  issueProjectId = undefined;
  assert.match((await start('verification', options)).error, /requires projectId/);
  issueProjectId = 'unconfigured';
  assert.match((await start('verification', options)).error, /project (?:automation )?ceiling/);
  issueProjectId = projectId;
  const started = await start('verification', options);
  assert.equal(started.run?.mode, 'assisted', started.error);
  verificationId = started.run.id;

  const agent = { actorType: 'agent', agentId: 'reviewer', runId: 'execution' };
  const decide = () => command({ operation: 'decide', runId: verificationId, nodeId: 'g5', outcome: 'accept',
    reason: 'Review the current PR' }, agent, 'gate-issue');
  project.automationMode = 'manual';
  assert.match((await decide()).error, /project (?:automation )?ceiling/);
  project.automationMode = 'assisted';
  assert.match((await decide()).error, /G5 approval must bind the PR head and verification manifest/);
});
