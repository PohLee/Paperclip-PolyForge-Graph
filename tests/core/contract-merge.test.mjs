import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GraphEngine, MemoryStore, runValidationDigest } from '../../src/core/index.mjs';
import { mergeContract } from '../../src/host/contract-merge.mjs';

const main = 'a'.repeat(40);
const head = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const prd = '# Billing';
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture({ actor = { id: 'owner', kind: 'human', roles: ['human-owner'] }, type = 'requirements-acceptance', outcome = 'accept', area = 'product', candidateRevision = 'rev1', contractsRoot } = {}) {
  const store = new MemoryStore();
  const engine = new GraphEngine({ store });
  const decision = { id: 'g2', runId: 'run', nodeId: 'gate', type, actor,
    status: 'decided', outcome, evidence: [{ subjectRefs: [{ artifactId: 'manifest', version: 'rev1' }] }] };
  await store.write({ revision: 1, packs: {}, audit: [], idempotency: {}, decisions: [decision], runs: {
    run: { id: 'run', status: 'completed', input: { projectId: 'project' },
      graph: { nodes: [{ id: 'gate', decisionType: decision.type, candidateNodes: ['prepare'], candidateKinds: ['manifest'] }] },
      nodeStates: { prepare: { status: 'completed', artifacts: ['rev1', candidateRevision].map(version =>
        ({ id: 'manifest', version, kind: 'manifest' })) }, gate: { status: 'completed', attempts: [{ decisionId: decision.id }] } } }
  } }, 0);
  const manifest = { id: 'manifest', revisionId: 'rev1', bytes: JSON.stringify({
    deliverables: [{ key: 'prd', digest: digest(prd) }]
  }) };
  const root = contractsRoot ?? 'docs/contracts';
  const folder = root + '/2026/11/2026-11-26-billing-PRD-0042';
  const changes = new Map([
    [folder + `/${area}/prd.md`, prd], [folder + `/${area}/criteria.json`, '[]'],
    [folder + '/contract.lock.json', '{}'], [root + '/INDEX.json', '[]']
  ]);
  const plan = { contractId: 'billing-PRD-0042', supersedes: null, currentRevision: null, changes, deliverables: new Map([['prd', prd]]) };
  const snapshot = { headSha: head, baseSha: main, baseRef: 'main',
    changes: [...changes].map(([path, bytes]) => ({ path, bytes, mode: '100644', status: 'added' })) };
  const refs = [];
  let calls = 0;
  const github = {
    getRef: async ({ ref }) => { assert.equal(ref, 'refs/heads/main'); return main; },
    getPullSnapshot: async () => snapshot,
    getMergeReceipt: async () => null,
    loadValidator: async ({ ref }) => {
      refs.push(ref);
      return ref === main ? { recompute: async () => plan } : { recompute: () => assert.fail('Untrusted validator ran') };
    },
    merge: async ({ baseSha, headSha }) => {
      calls++;
      assert.equal(baseSha, main);
      assert.equal(headSha, head);
      return merged;
    }
  };
  return { args: { engine, github, project: { id: 'project', ownerId: 'owner', repository: 'org/repo', contractsRoot },
    runId: 'run', pullNumber: 42, section: 'product', decisionId: 'g2', manifest },
    store, folder, snapshot, plan, refs, calls: () => calls };
}

test('merges the approved publication and durably records the SHA and event once', async () => {
  const { args, calls } = await fixture();
  const receipt = await mergeContract(args);
  assert.equal(receipt.mergeCommitSha, merged);
  assert.deepEqual(await mergeContract(args), receipt);
  assert.deepEqual((await args.engine.getRun('run')).contractMerges, [receipt]);
  const events = await args.engine.getAudit({ runId: 'run' });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'contract.merged');
  assert.equal(events[0].mergeCommitSha, merged);
  assert.equal(calls(), 1);
});

test('rejects a non-contract path', async () => {
  const { args, snapshot, calls } = await fixture();
  snapshot.changes[0].path = 'src/index.js';
  await assert.rejects(mergeContract(args), /path is forbidden/);
  assert.equal(calls(), 0);
});

test('rejects stale supersedes', async () => {
  const { args, plan, calls } = await fixture();
  plan.currentRevision = 'current';
  await assert.rejects(mergeContract(args), /supersedes is stale/);
  assert.equal(calls(), 0);
});

test('rejects a digest mismatch in an approved deliverable', async () => {
  const { args, plan, calls } = await fixture();
  plan.deliverables.set('prd', 'tampered');
  await assert.rejects(mergeContract(args), /deliverable digest mismatch/);
  assert.equal(calls(), 0);
});

test('rejects a modified generated lock', async () => {
  const { args, snapshot, calls } = await fixture();
  snapshot.changes.find(file => file.path.endsWith('/contract.lock.json')).bytes = '{"tampered":true}';
  await assert.rejects(mergeContract(args), /file digest mismatch/);
  assert.equal(calls(), 0);
});

test('rejects a missing approver and a human who is not the configured owner', async () => {
  for (const actor of [null, { id: 'other', kind: 'human', roles: ['human-owner'] }]) {
    const { args, calls } = await fixture({ actor });
    await assert.rejects(mergeContract(args), /approver is unauthorized/);
    assert.equal(calls(), 0);
  }
});

test('rejects a technical contract without a G4 decision', async () => {
  const { args, calls } = await fixture();
  await assert.rejects(mergeContract({ ...args, section: 'technical' }), /gate approval is required/);
  assert.equal(calls(), 0);
});

test('loads main validation even when the candidate modifies the validator path', async () => {
  const { args, folder, snapshot, refs, calls } = await fixture();
  snapshot.changes.push({ path: folder + '/product/validator.mjs', bytes: 'tampered head validator',
    mode: '100644', status: 'modified' });
  await assert.rejects(mergeContract(args), /differs from the approved publication/);
  assert.deepEqual(refs, [main]);
  assert.equal(calls(), 0);
});

test('recovers a trusted merge receipt after a run write failure', async () => {
  const { args, calls } = await fixture();
  args.github.getMergeReceipt = async () => ({ baseSha: main, headSha: head, mergeCommitSha: merged, contractId: 'billing-PRD-0042', supersedes: null });
  assert.equal((await mergeContract(args)).mergeCommitSha, merged);
  assert.equal(calls(), 0);
});

test('product publication may include the G2 interaction design but no other design files', async () => {
  const { args, folder, snapshot, plan } = await fixture();
  const interaction = folder + '/design/interaction.md';
  plan.changes.set(interaction, '# Flow');
  snapshot.changes.push({ path: interaction, bytes: '# Flow', mode: '100644', status: 'added' });
  assert.equal((await mergeContract(args)).mergeCommitSha, merged);
  const other = await fixture();
  other.snapshot.changes.push({ path: other.folder + '/design/manifest.yml', bytes: 'x', mode: '100644', status: 'added' });
  await assert.rejects(mergeContract(other.args), /path is forbidden/);
});

test('merges a design contract on the owner G3 approval and keeps interaction design out of it', async () => {
  const g3 = { type: 'g3-visual-approval', outcome: 'approve', area: 'design' };
  const { args } = await fixture(g3);
  assert.equal((await mergeContract({ ...args, section: 'design' })).mergeCommitSha, merged);

  const interaction = await fixture(g3);
  interaction.snapshot.changes.push({ path: interaction.folder + '/design/interaction.md', bytes: '# Flow', mode: '100644', status: 'modified' });
  await assert.rejects(mergeContract({ ...interaction.args, section: 'design' }), /path is forbidden/);

  const held = await fixture({ ...g3, outcome: 'hold' });
  await assert.rejects(mergeContract({ ...held.args, section: 'design' }), /gate approval is required/);

  const g2Only = await fixture({ area: 'design' });
  await assert.rejects(mergeContract({ ...g2Only.args, section: 'design' }), /gate approval is required/);

  const agent = await fixture({ ...g3, actor: { id: 'owner', kind: 'agent', roles: ['human-owner'] } });
  await assert.rejects(mergeContract({ ...agent.args, section: 'design' }), /approver is unauthorized/);
});

test('rejects a cited manifest revision superseded by a current gate candidate', async () => {
  const { args, calls } = await fixture({ candidateRevision: 'rev2' });
  await assert.rejects(mergeContract(args), /current gate candidate/);
  assert.equal(calls(), 0);
});

test('contract publication rechecks pin freshness inside the final merge authorization', async () => {
  const { args } = await fixture();
  const run = await args.engine.getRun(args.runId);
  run.contract_pins = [{ section: 'product', contractId: 'billing', commit: main }];
  args.engine.getRun = async () => run;
  let frozen = false;
  args.engine.assertCurrentContractPins = async () => { if (frozen) throw new Error('Frozen contract'); };
  args.github.merge = async (_request, authorize) => { frozen = true; await authorize(); assert.fail('merge'); };
  await assert.rejects(mergeContract(args), /Frozen contract/);
});

test('merges a publication under the custom contractsRoot alias', async () => {
  const { args } = await fixture({ contractsRoot: 'specs/contracts' });
  assert.equal((await mergeContract(args)).mergeCommitSha, merged);
});

test('a G4 approval predating a superseding product pin cannot publish after resume', async () => {
  const { args, store } = await fixture({ type: 'technical-contract-approval', area: 'technical',
    actor: { id: 'cto', kind: 'agent', roles: ['cto'] } });
  args.section = 'technical';
  args.project.ctoId = 'cto';
  const host = { kind: 'system', id: 'host', roles: [] };
  const first = 'd'.repeat(40), second = 'e'.repeat(40);
  const pin = { contractId: 'product', section: 'product', commit: first };
  const state = await store.read();
  const run = state.runs.run;
  run.status = 'running';
  run.mode = 'manual';
  run.pack = { decisionRules: [{ type: 'technical-contract-approval', mode: 'manual',
    allowedKinds: ['agent'], allowedRoles: ['cto'], requiredEvidence: ['approval'] }] };
  Object.assign(run.graph.nodes[0], { type: 'decision', role: 'cto', outcomes: ['accept'] });
  run.graph.start = 'prepare';
  run.graph.nodes.push({ id: 'prepare', type: 'task' }, { id: 'publish', type: 'end' });
  run.nodeStates.publish = { status: 'pending', attempts: [] };
  run.graph.edges = [{ from: 'prepare', to: 'gate' }, { from: 'gate', to: 'publish', when: 'accept' }];
  run.conflicts = [];
  run.contract_pins = [pin];
  state.runs.publication = { id: 'publication', status: 'completed', input: { projectId: 'project' } };
  state.audit.push({ kind: 'decision.recorded', runId: run.id, decisionId: args.decisionId });
  await store.write({ ...state, revision: state.revision + 1 }, state.revision);
  const publication = { repository: 'org/repo', contractId: pin.contractId, section: pin.section };
  await args.engine.recordContractMerge('publication', { ...publication, pullNumber: 1, mergeCommitSha: first, supersedes: null });
  await args.engine.recordContractMerge('publication', { ...publication, contractId: 'replacement', pullNumber: 2, mergeCommitSha: second, supersedes: first });
  await args.engine.updateContractPins({ runId: run.id, pins: [{ ...pin, contractId: 'replacement', commit: second }], actor: host,
    reason: 'Supersession', idempotencyKey: 'update', expectedRunDigest: runValidationDigest(await args.engine.getRun(run.id)) });
  await args.engine.resumeRun({ runId: run.id, actor: host, reason: 'Pins updated' });
  args.github.merge = async (_request, authorize) => { await authorize(); assert.fail('Old G4 authorized publication'); };
  await assert.rejects(mergeContract(args), /Contract pins changed after/);

  const resumed = await store.read();
  resumed.runs.run.nodeStates.gate.status = 'pending';
  await store.write({ ...resumed, revision: resumed.revision + 1 }, resumed.revision);
  const { decision } = await args.engine.decideNode({ runId: run.id, nodeId: 'gate', outcome: 'accept',
    actor: { id: 'cto', kind: 'agent', roles: ['cto'], executionId: 'new-review' }, reason: 'Review the replacement pin',
    evidence: [{ kind: 'approval', subjectRefs: [{ artifactId: 'manifest', version: 'rev1' }] }] });
  args.github.merge = async (_request, authorize) => { await authorize(); return merged; };
  assert.equal((await mergeContract({ ...args, decisionId: decision.id })).mergeCommitSha, merged);
});
