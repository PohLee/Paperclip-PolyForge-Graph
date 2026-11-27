import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphEngine, runValidationDigest } from '../../src/core/index.mjs';
import { pack } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/index.mjs';
import { createCreativeHostApi } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/runtime/host-api.mjs';
import { canonicalDigest } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/product-method-contracts.mjs';

const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
const director = { id: 'director', kind: 'agent', roles: ['design-director'], executionId: 'execution' };

async function readyG3() {
  const engine = new GraphEngine();
  await engine.registerPack(pack);
  const ref = { id: 'baseline', version: '1' };
  const digest = 'a'.repeat(64);
  const manifest = { id: 'visual', version: '1', systemScope: 'out-of-system', behaviorChanged: false,
    productContractRef: ref, interactionRef: ref, designBaselineRef: ref, tokens: [], components: [],
    assets: [{ ...ref, digest }], deliverables: [{ key: 'design.json', digest }] };
  const audit = { id: 'audit', version: '1', manifestRef: { id: manifest.id, version: manifest.version },
    manifestDigest: canonicalDigest(manifest), behaviorChanged: false, findings: [] };
  const candidate = { artifactId: manifest.id, version: manifest.version };
  const api = createCreativeHostApi({ engine, runValidationDigest, resolveActor: ({ claimedActor }) => claimedActor,
    services: {
      getProjectConfig: async () => ({ automationMode: 'manual' }),
      resolveDecisionEvidence: async () => [
        { kind: 'visual_manifest', payload: manifest, subjectRefs: [candidate] },
        { kind: 'visual_audit', payload: audit, subjectRefs: [candidate, { artifactId: audit.id, version: audit.version }] },
      ],
    } });
  const run = await api.startRun({ packId: pack.id, packVersion: pack.version, graphId: 'g3-visual-contract',
    graphVersion: '0.1.1', actor: owner, input: { projectId: 'project', approved_product_contract: ref, design_baseline: ref } });
  const state = await engine.store.read();
  for (const [nodeId, kind, payload] of [
    ['prepare-visual-manifest', 'visual_manifest', manifest], ['design-audit', 'visual_audit', audit],
  ]) {
    const artifacts = [{ id: payload.id, version: payload.version, kind }];
    Object.assign(state.runs[run.id].nodeStates[nodeId], { status: 'completed', artifacts,
      attempts: [{ artifacts, output: { creativeArtifacts: { [kind]: payload } } }] });
  }
  await engine.store.write({ ...state, revision: state.revision + 1 }, state.revision);
  return { api, engine, args: { runId: run.id, nodeId: 'g3', outcome: 'approve', reason: 'Review visual scope' } };
}

test('the G3 owner can decide without the design-director role', async () => {
  const { api, args } = await readyG3();
  assert.equal((await api.decideNode({ ...args, actor: owner })).decision.outcome, 'approve');
});

test('the director can escalate G3 and the owner can resolve it', async () => {
  const { api, engine, args } = await readyG3();
  await assert.rejects(api.decideNode({ ...args, actor: director }), /human owner/);
  const escalated = await api.decideNode({ ...args, actor: director, outcome: 'human' });
  assert.equal(escalated.run.pendingHuman.nodeId, args.nodeId);
  const resolved = await api.resolveHumanGate({ ...args, actor: owner, expectedDecisionId: escalated.decision.id });
  assert.equal(resolved.decision.supersedes, escalated.decision.id);
  assert.equal((await engine.getRun(args.runId)).nodeStates.g3.outcome, 'approve');
});
