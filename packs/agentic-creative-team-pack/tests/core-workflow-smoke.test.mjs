import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphEngine } from '../../../src/core/index.mjs';
import { pack, createCreativeHostApi } from '../index.mjs';

// All data in these end-to-end runs is deterministic test-fixture content; no provider or user artifact is represented.
const capabilities = {
  'image-generation': '1.0.0', 'html-file-write': '1.0.0', 'design-rendering': '1.0.0',
  'project-source-read': '1.0.0', 'be-contract-read': '1.0.0', 'asset-production': '1.0.0',
};
const stableJson = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const digest = value => createHash('sha256').update(stableJson(value)).digest('hex');
const ref = (id, version = '1', kind, digestValue) => ({ id, version, ...(kind ? { kind } : {}), ...(digestValue ? { digest: digestValue } : {}) });
const artifact = (kind, payload) => ({ kind, id: payload.id, version: payload.version });
const actor = (role, executionId = `exec-${role}`) => ({ id: `actor-${executionId}`, kind: 'agent', roles: [role], executionId });

function externalRecord(kind, id, payload) {
  return { id, version: payload.version, kind, digest: digest(payload), payload };
}

function createFixture() {
  const external = new Map();
  const brief = { id: 'brief-1', version: 'v1', objective: 'Design a billing workflow', audience: 'Workspace operators', surfaceMode: 'operate' };
  const briefRow = externalRecord('creative_brief', brief.id, brief);
  external.set(`${briefRow.kind}:${briefRow.id}@${briefRow.version}`, briefRow);

  const baseline = { id: 'baseline-current', version: 'v4', tokensRef: ref('tokens', 'v4'), componentsRef: ref('components', 'v4'), patternsRef: ref('patterns', 'v4'), decisionRef: ref('decision', 'v4'), migrationRef: ref('migration', 'v4') };
  const oldBaseline = { ...baseline, id: 'baseline-old', version: 'v3' };
  const baselineRow = externalRecord('design_baseline', baseline.id, baseline);
  const oldBaselineRow = externalRecord('design_baseline', oldBaseline.id, oldBaseline);
  external.set(`design_baseline:${baseline.id}@${baseline.version}`, baselineRow);
  external.set(`design_baseline:${oldBaseline.id}@${oldBaseline.version}`, oldBaselineRow);

  const brandBaseline = {
    id: 'brand-baseline-current', version: 'v2',
    strategyRef: ref('brand-strategy', 'v2'), identityRef: ref('brand-identity', 'v2'),
    voiceRef: ref('brand-voice', 'v2'), decisionRef: ref('brand-decision', 'v2'),
  };
  const brandBaselineRow = externalRecord('brand_baseline', brandBaseline.id, brandBaseline);
  external.set(`brand_baseline:${brandBaseline.id}@${brandBaseline.version}`, brandBaselineRow);

  const contractPayload = (id, version) => ({ id, version, digest: 'a'.repeat(64), content: { method: 'GET', path: '/api/billing', response: { invoices: [] } } });
  const contract = contractPayload('billing-api', 'v2');
  const oldContract = contractPayload('billing-api', 'v1');
  const contractRow = externalRecord('be_contract', contract.id, contract);
  const oldContractRow = externalRecord('be_contract', oldContract.id, oldContract);
  external.set(`be_contract:${contract.id}@${contract.version}`, contractRow);
  external.set(`be_contract:${oldContract.id}@${oldContract.version}`, oldContractRow);
  const baselineRef = ref(baseline.id, baseline.version, baselineRow.kind, baselineRow.digest);
  const oldBaselineRef = ref(oldBaseline.id, oldBaseline.version, oldBaselineRow.kind, oldBaselineRow.digest);
  const contractRef = ref(contract.id, contract.version, contractRow.kind, contractRow.digest);
  const oldContractRef = ref(oldContract.id, oldContract.version, oldContractRow.kind, oldContractRow.digest);

  const engine = new GraphEngine({ availableCapabilities: capabilities });
  const rootPromise = mkdtemp(path.join(os.tmpdir(), 'creative-g05-'));
  const actorResolver = ({ claimedActor }) => claimedActor;
  const api = createCreativeHostApi({
    engine,
    artifactRootForRun: () => rootPromise,
    hasImageProvider: async () => true,
    resolveActor: actorResolver,
    loadExternalArtifact: async ({ ref: requestedRef, kind }) => {
      const row = external.get(`${kind}:${requestedRef.id ?? requestedRef.artifactId}@${requestedRef.version}`);
      return row ?? null;
    },
    resolveDecisionEvidence: async ({ run, requiredKinds }) => requiredKinds.map(kind => {
      const expectedSystemBaseline = run.input.bootstrapRef ?? baselineRef;
      const sources = {
        creative_brief_version: [ref(brief.id, brief.version, 'creative_brief', briefRow.digest), 'creative_brief'],
        design_baseline_version: [baselineRef, 'design_baseline'],
        screen_state_permission_matrix: [ref('state-matrix', 'v1')],
        be_contract_review: [ref('contract-review', 'v1')],
        saas_design_version: [ref('feature-design', 'v1')],
        handoff_review: [ref('design-review', 'v1')],
        expected_baseline_version: [expectedSystemBaseline, expectedSystemBaseline.kind ?? 'design_baseline'],
        proposed_design_system_version: [ref('system-proposal', 'v1')],
        representative_validation: [ref('system-validation', 'v1')],
        accessibility_review: [ref('system-validation', 'v1')],
        migration_impact: [ref('system-proposal', 'v1')],
        affected_consumers: [ref('system-inventory', 'v1')],
      };
      const [sourceRef, sourceKind] = sources[kind] ?? [];
      return { kind, payload: { evidenceKind: kind }, sourceRef, ...(sourceKind ? { sourceKind } : {}) };
    }),
  });
  const brandBaselineRef = ref(brandBaseline.id, brandBaseline.version, brandBaselineRow.kind, brandBaselineRow.digest);
  return { api, engine, brief, baselineRef, oldBaselineRef, brandBaselineRef, contractRef, oldContractRef, dispose: async () => {
    const root = await rootPromise;
    await rm(root, { recursive: true, force: true });
  } };
}

async function submit(api, runId, nodeId, role, payload, graphId = 'saas-feature-design') {
  const kind = pack.graphs.find(graph => graph.id === graphId).nodes.find(node => node.id === nodeId)?.produces?.[0];
  assert.ok(kind, `test fixture has a declared artifact for ${nodeId}`);
  return api.submitNode({ runId, nodeId, actor: actor(role), artifacts: [artifact(kind, payload)], payloads: { [kind]: payload } });
}

test('G06 evolves an existing design baseline through the trusted host wrapper', async () => {
  const fixture = createFixture();
  try {
    const { api, engine, baselineRef } = fixture;
    await engine.registerPack(pack);
    const run = await api.startRun({
      packId: pack.id, packVersion: pack.version, graphId: 'design-system-evolution', mode: 'manual',
      actor: { id: 'human-owner', kind: 'human', roles: ['human-owner'], executionId: 'owner-ui' },
      input: { designBaselineRef: baselineRef },
    });
    const payloads = {
      'inventory-system': { id: 'system-inventory', version: 'v1', baselineRef, tokens: ['color.surface'], components: ['button'], consumers: [{ id: 'billing' }] },
      'propose-system-change': { id: 'system-proposal', version: 'v1', expectedBaselineRef: baselineRef, changes: [{ token: 'color.surface', from: '#fff', to: '#f5f5f2' }], migrationImpact: 'Update one token consumer.' },
      'validate-representative-pages': { id: 'system-validation', version: 'v1', proposalRef: ref('system-proposal', 'v1'), representativePages: [{ id: 'billing', result: 'pass' }], findings: [] },
      'impact-review': { id: 'system-review', version: 'v1', proposalRef: ref('system-proposal', 'v1'), validationRef: ref('system-validation', 'v1'), disposition: 'accepted', findings: [] },
    };
    let turns = 0;
    while ((await engine.getRun(run.id)).status === 'running' && turns++ < 20) {
      const ready = await engine.getReadyNodes(run.id);
      assert.ok(ready.length, `G06 has ready work on turn ${turns}`);
      for (const node of ready) {
        if (node.type === 'task') {
          if (node.id === 'publish-design-baseline') {
            const decision = (await engine.listDecisions({ runId: run.id })).find(item => item.nodeId === 'system-disposition');
            const baseline = { id: 'design-baseline-next', version: 'v5', tokensRef: ref('system-inventory', 'v1'), componentsRef: ref('system-proposal', 'v1'), patternsRef: ref('system-validation', 'v1'), decisionRef: ref(decision.id, decision.at), migrationRef: ref('system-review', 'v1') };
            await submit(api, run.id, node.id, node.role, baseline, 'design-system-evolution');
          } else {
            await submit(api, run.id, node.id, node.role, payloads[node.id], 'design-system-evolution');
          }
        } else if (node.type === 'decision') {
          await api.decideNode({ runId: run.id, nodeId: node.id,
            actor: { id: 'human-director', kind: 'human', roles: ['human-owner', node.role], executionId: 'human-director' },
            outcome: 'accepted', reason: 'Accept the validated migration against the pinned baseline' });
        } else {
          await api.submitNode({ runId: run.id, nodeId: node.id, actor: { id: 'human-owner', kind: 'human', roles: ['human-owner'], executionId: 'owner-ui' } });
        }
      }
    }
    assert.ok(turns < 20, 'G06 reaches a terminal node');
    const result = await engine.getRun(run.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.nodeStates['system-ready'].status, 'completed');
  } finally { await fixture.dispose(); }
});

test('G06 bootstraps a design system from a pinned brand baseline with an empty initial inventory', async () => {
  const fixture = createFixture();
  try {
    const { api, engine, brandBaselineRef } = fixture;
    await engine.registerPack(pack);
    const run = await api.startRun({
      packId: pack.id, packVersion: pack.version, graphId: 'design-system-evolution', mode: 'manual',
      actor: { id: 'human-owner', kind: 'human', roles: ['human-owner'], executionId: 'owner-ui' },
      input: { bootstrapRef: brandBaselineRef },
    });
    const payloads = {
      'inventory-system': { id: 'system-inventory', version: 'v1', baselineRef: brandBaselineRef, tokens: [], components: [], consumers: [] },
      'propose-system-change': { id: 'system-proposal', version: 'v1', expectedBaselineRef: brandBaselineRef, changes: [{ token: 'color.surface', from: null, to: '#f5f5f2' }], migrationImpact: 'Introduce the first surface token; no consumers exist yet.' },
      'validate-representative-pages': { id: 'system-validation', version: 'v1', proposalRef: ref('system-proposal', 'v1'), representativePages: [{ id: 'starter-page', result: 'pass' }], findings: [] },
      'impact-review': { id: 'system-review', version: 'v1', proposalRef: ref('system-proposal', 'v1'), validationRef: ref('system-validation', 'v1'), disposition: 'accepted', findings: [] },
    };
    let turns = 0;
    while ((await engine.getRun(run.id)).status === 'running' && turns++ < 20) {
      const ready = await engine.getReadyNodes(run.id);
      assert.ok(ready.length, `G06 bootstrap has ready work on turn ${turns}`);
      for (const node of ready) {
        if (node.type === 'task') {
          if (node.id === 'publish-design-baseline') {
            const decision = (await engine.listDecisions({ runId: run.id })).find(item => item.nodeId === 'system-disposition');
            const baseline = { id: 'design-baseline-first', version: 'v1', tokensRef: ref('system-inventory', 'v1'), componentsRef: ref('system-proposal', 'v1'), patternsRef: ref('system-validation', 'v1'), decisionRef: ref(decision.id, decision.at), migrationRef: ref('system-review', 'v1') };
            await submit(api, run.id, node.id, node.role, baseline, 'design-system-evolution');
          } else {
            await submit(api, run.id, node.id, node.role, payloads[node.id], 'design-system-evolution');
          }
        } else if (node.type === 'decision') {
          await api.decideNode({ runId: run.id, nodeId: node.id,
            actor: { id: 'human-director', kind: 'human', roles: ['human-owner', node.role], executionId: 'human-director' },
            outcome: 'accepted', reason: 'Accept the first design system grounded in the pinned brand baseline' });
        } else {
          await api.submitNode({ runId: run.id, nodeId: node.id, actor: { id: 'human-owner', kind: 'human', roles: ['human-owner'], executionId: 'owner-ui' } });
        }
      }
    }
    assert.ok(turns < 20, 'G06 bootstrap reaches a terminal node');
    const result = await engine.getRun(run.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.nodeStates['system-ready'].status, 'completed');
  } finally { await fixture.dispose(); }
});

function taskPayload(nodeId, fixture) {
  const { brief, baselineRef, contractRef } = fixture;
  switch (nodeId) {
    case 'read-baseline': return { id: 'pinned-context', version: 'v1', designBaselineRef: baselineRef, requirementRef: ref(brief.id, brief.version, 'creative_brief') };
    case 'map-permissions': return { id: 'state-matrix', version: 'v1', states: [{ id: 'loaded' }, { id: 'empty' }, { id: 'error' }], permissions: [{ role: 'operator', actions: ['read'] }], unknowns: [], contractRefs: [contractRef] };
    case 'be-contract-review': return { id: 'contract-review', version: 'v1', contractRefs: [contractRef], unknowns: [], ownerRefs: [ref('be-owner', 'v1')] };
    case 'design-feature': return { id: 'feature-design', version: 'v1', baselineRef, stateMatrixRef: ref('state-matrix', 'v1'), pages: [{ id: 'billing', sections: ['invoices'] }] };
    case 'handoff': return { id: 'design-handoff', version: 'v1', requirementRef: ref(brief.id, brief.version, 'creative_brief'), designBaselineRef: baselineRef, designSpecRef: ref('feature-design', 'v1'), acceptanceCriteria: ['Shows loaded, empty, and error states'] };
    case 'saas-independent-review': return { id: 'design-review', version: 'v1', handoffRef: ref('design-handoff', 'v1'), disposition: 'complete', findings: [], reviewerExecutionId: 'exec-design-qa-accessibility', subjectAuthorExecutionIds: ['replaced-by-host'] };
    case 'publish-saas-package': return { id: 'saas-package', version: 'v1', handoffRef: ref('design-handoff', 'v1'), baselineRef, apiContractRefs: [contractRef], stateMatrixRef: ref('state-matrix', 'v1'), reviewRef: ref('design-review', 'v1') };
    default: throw new Error(`No fixture payload for ${nodeId}`);
  }
}

async function runToPackage(fixture, { badBaseline = false, badContract = false } = {}) {
  const { api, engine, brief } = fixture;
  await engine.registerPack(pack);
  const run = await api.startRun({
    packId: pack.id, packVersion: pack.version, graphId: 'saas-feature-design', mode: 'manual',
    actor: { id: 'human-owner', kind: 'human', roles: ['human-owner'], executionId: 'owner-ui' },
    input: {
      creative_brief: brief,
      designBaselineRef: fixture.baselineRef,
      beContracts: [fixture.contractRef],
    },
  });
  let turns = 0;
  while ((await engine.getRun(run.id)).status === 'running' && turns++ < 30) {
    const ready = await engine.getReadyNodes(run.id);
    assert.ok(ready.length, `G05 has ready work on turn ${turns}`);
    if (ready.some(node => node.id === 'publish-saas-package')) break;
    for (const node of ready) {
      if (node.type === 'task') {
        const payload = taskPayload(node.id, fixture);
        await submit(api, run.id, node.id, node.role, payload);
      } else if (node.type === 'decision') {
        await api.decideNode({ runId: run.id, nodeId: node.id,
          actor: { id: `human-${node.id}`, kind: 'human', roles: ['human-owner', node.role], executionId: `human-${node.id}` },
          outcome: 'ready', reason: 'Accept the exact reviewed SaaS design package' });
      } else {
        await api.submitNode({ runId: run.id, nodeId: node.id,
          actor: { id: 'human-owner', kind: 'human', roles: ['human-owner'], executionId: 'owner-ui' } });
      }
    }
  }
  assert.ok(turns < 30, 'G05 reaches a terminal node');
  const runState = await engine.getRun(run.id);
  assert.equal(runState.nodeStates['publish-saas-package'].status, 'pending');
  const packagePayload = taskPayload('publish-saas-package', fixture);
  if (badBaseline) packagePayload.baselineRef = fixture.oldBaselineRef;
  if (badContract) packagePayload.apiContractRefs = [fixture.oldContractRef];
  return { runId: run.id, packagePayload, runState };
}

test('G05 completes through the trusted host wrapper with exact pinned baseline and BE contracts', async () => {
  const fixture = createFixture();
  try {
    const { api, engine } = fixture;
    const { runId, packagePayload } = await runToPackage(fixture);
    await submit(api, runId, 'publish-saas-package', 'design-ops-producer', packagePayload);
    for (const node of await engine.getReadyNodes(runId)) if (node.type === 'end') {
      await api.submitNode({ runId, nodeId: node.id, actor: { id: 'human-owner', kind: 'human', roles: ['human-owner'], executionId: 'owner-ui' } });
    }
    const result = await engine.getRun(runId);
    assert.equal(result.status, 'completed');
    assert.equal(result.nodeStates['saas-ready'].status, 'completed');
  } finally { await fixture.dispose(); }
});

for (const mismatch of ['baseline', 'contract']) test(`G05 refuses a package with a different ${mismatch} reference`, async () => {
  const fixture = createFixture();
  try {
    const { api, engine } = fixture;
    const { runId, packagePayload } = await runToPackage(fixture, mismatch === 'baseline' ? { badBaseline: true } : { badContract: true });
    await assert.rejects(submit(api, runId, 'publish-saas-package', 'design-ops-producer', packagePayload), /exact baseline, contracts/);
    assert.equal((await engine.getRun(runId)).nodeStates['publish-saas-package'].status, 'pending');
  } finally { await fixture.dispose(); }
});
