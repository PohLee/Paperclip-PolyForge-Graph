import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine, runValidationDigest, createWorkflowRuntime } from '../../src/core/index.mjs';
import { projectReviewRun } from '../../src/plugin/review-context.mjs';
import { creativePayload } from '../../scripts/e2e-workflow-composition-fixture-agent.mjs';
import { pack } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/index.mjs';
import { createCreativeHostApi } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/runtime/host-api.mjs';

test('Creative fixture completes through the trusted adapter and independent review projection', async () => {
  const engine = new GraphEngine(); await engine.registerPack(pack);
  const owner = { id: 'fixture-owner', kind: 'human', roles: ['human-owner', 'creative-team:creative-director'], executionId: null };
  const system = { id: 'fixture-host', kind: 'system', roles: [], executionId: null };
  let authenticated = owner;
  const api = createCreativeHostApi({ engine, runValidationDigest, resolveActor: async () => authenticated,
    resolveDecisionEvidence: async ({ run, requiredKinds }) => requiredKinds.map(kind => {
      const artifactKind = { evidence_quality: 'brand_evidence_ledger', review_findings: 'brand_foundation_review' }[kind] ?? kind;
      const state = Object.values(run.nodeStates).find(state => state.artifacts?.some(a => a.kind === artifactKind));
      const artifact = state.artifacts.find(a => a.kind === artifactKind);
      return { kind, payload: state.attempts.at(-1).output.creativeArtifacts[artifactKind],
        sourceRef: { id: artifact.id, version: artifact.version, kind: artifact.kind } };
    }),
  });
  const run = await api.startRun({ packId: pack.id, packVersion: pack.version, graphId: 'brand-foundation-contract',
    graphVersion: '1.0.0', actor: owner, mode: 'autonomous', input: { workflowInput: {
      brandName: 'Fixture', category: 'Scheduling', targetAudience: 'Operations leads', brandPromise: 'Clear shifts', proofPoints: ['Synthetic input'],
    } } });
  for (let step = 0; step < 20; step++) {
    const current = await engine.getRun(run.id);
    if (current.status === 'completed') break;
    const [node] = await engine.getReadyNodes(run.id);
    assert.ok(node, 'Fixture workflow must have eligible work');
    if (node.type === 'decision') {
      authenticated = { ...owner, roles: ['human-owner', 'marketing:creative-director'] };
      await assert.rejects(api.decideNode({ runId: run.id, nodeId: node.id, actor: authenticated,
        outcome: 'ready', reason: 'A different Pack role must not authorize this decision.' }), /required role|not allowed/);
      assert.deepEqual(await engine.getRun(run.id), current);
      authenticated = owner;
      await api.decideNode({ runId: run.id, nodeId: node.id, actor: owner, outcome: 'ready', reason: 'Synthetic owner reviewed exact persisted evidence.' });
    } else if (['join', 'end'].includes(node.type)) {
      authenticated = system;
      await api.submitNode({ runId: run.id, nodeId: node.id, actor: system });
    } else {
      authenticated = { id: node.role, kind: 'agent', roles: [node.role], executionId: 'authenticated-' + node.id };
      const artifacts = node.produces.map(kind => ({ id: node.id + '-' + kind, version: 'synthetic-v1', kind }));
      const projected = node.independentOf?.length ? projectReviewRun(current, node.id) : current;
      const payloads = creativePayload(node, projected, artifacts, await engine.listDecisions({ runId: run.id }), authenticated.executionId);
      if (node.id === 'review-brand-foundation' || node.id === 'publish-foundation-package') {
        const forged = structuredClone(payloads);
        if (node.id === 'review-brand-foundation') forged.brand_foundation_review.reviewerExecutionId = 'forged-reviewer';
        else forged.brand_foundation_package.acceptanceDecisionRef.version = 'stale-decision';
        await assert.rejects(api.submitNode({ runId: run.id, nodeId: node.id, actor: authenticated, output: {}, artifacts, payloads: forged }),
          /Reviewer identity|exact accepted decision/);
        assert.deepEqual(await engine.getRun(run.id), current);
      }
      await api.submitNode({ runId: run.id, nodeId: node.id, actor: authenticated, output: {}, artifacts, payloads });
    }
  }
  const { handle } = await createWorkflowRuntime({ engine }).inspect(run.id);
  assert.equal(handle.status, 'completed');
  assert.ok(handle.output.foundation.acceptanceDecisionRef.id);
  const accepted = (await engine.listDecisions({ runId: run.id })).find(d => d.nodeId === 'accept-brand-foundation');
  assert.equal(handle.output.foundation.acceptanceDecisionRef.version, accepted.at);
});
