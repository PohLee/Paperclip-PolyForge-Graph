import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine } from '../../src/core/index.mjs';
import { pack } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';
import { triageSubmission } from '../../scripts/e2e-minimal-fixture-agent.mjs';

const owner = { kind: 'human', id: 'owner', roles: ['human-owner'] };
const productOwner = { kind: 'agent', id: 'po', roles: ['product-owner'], executionId: 'intake' };
const supervisor = { kind: 'agent', id: 'cpo', roles: ['cpo'], executionId: 'supervisor' };
const minute = 60_000;

test('Discovery can cross 30 active minutes, then expires exactly 30 minutes after its last accepted research', async () => {
  let time = Date.UTC(2026, 10, 22);
  const engine = new GraphEngine({ now: () => new Date(time).toISOString() });
  await engine.registerPack(pack);
  const run = await engine.startRun({ actor: owner, packId: pack.id, packVersion: pack.version,
    graphId: 'product-discovery', mode: 'assisted', input: { source_request: { id: 'research-question', version: '1' } } });
  async function submitResearch(nodeId, accept) {
    const node = run.graph.nodes.find(item => item.id === nodeId);
    const scope = { runId: run.id, nodeId };
    const author = { id: node.role, roles: [node.role], kind: 'agent', executionId: 'write-' + nodeId };
    const finding = 'The supplied request identifies the maintainer but contains no dated usage measurement.';
    const decision = await engine.recordWorkDecision({ ...scope, actor: author, category: 'process',
      question: 'Which source is available?', options: [{ id: 'report', label: 'Inspect the supplied request' }],
      outcome: 'report', reason: finding, behaviorImpact: 'none', ruleRef: 'node:' + nodeId,
      evidence: [{ kind: 'requirement', summary: finding, sourceRef: { kind: 'run_input', key: 'source_request' } }] });
    const artifacts = node.produces.map(kind => ({ kind, id: kind, version: '1' }));
    await engine.submitNode({ ...scope, actor: author, decisionIds: [decision.id], artifacts, output: { observation: finding } });
    await engine.recordSelfReview({ ...scope, actor: author, artifactVersion: '1' });
    if (!accept) return;
    const work = (await engine.getWorkItems(run.id)).find(item => item.nodeId === nodeId && item.phase === 'supervisor');
    const reviewer = { kind: 'agent', id: work.role, roles: [work.role], executionId: 'review-' + nodeId };
    await engine.reviewWork({ ...scope, actor: reviewer, outcome: 'accept', reason: finding,
      evidence: work.requiredEvidence.map(kind => ({ kind, subjectRefs: work.candidateRefs })) });
  }
  await submitResearch('frame-discovery', true);
  assert.deepEqual((await engine.getDeliveryStatus(run.id)).acceptedMilestones, []);
  time += 20 * minute;
  await submitResearch('internal-research', true);
  time += 11 * minute;
  await submitResearch('external-research', false);
  const status = await engine.getDeliveryStatus(run.id);
  assert.equal(status.runStatus, 'running');
  assert.deepEqual(status.acceptedMilestones.map(item => item.nodeId), ['internal-research']);
  assert.equal(status.idleMinutesRemaining, 19);
  time += 19 * minute - 1;
  assert.equal((await engine.getRun(run.id)).status, 'running');
  time++;
  assert.equal((await engine.getRun(run.id)).status, 'stopped');
  assert.equal((await engine.listDecisions({ runId: run.id })).at(-1).reason, 'idle_progress_limit');
});

test('accepted ADLC intake refreshes the same issue across runs only for fresh artifact versions', async () => {
  let time = Date.UTC(2026, 10, 20);
  const engine = new GraphEngine({ now: () => new Date(time).toISOString() });
  await engine.registerPack(pack);
  const input = { paperclipCompanyId: 'test-company', projectId: 'test-project', paperclipIssueId: 'root-issue',
    source_request: { id: 'request', version: 'v1' }, accepted_intent: { id: 'intent', version: 'v1' } };
  const start = graphId => engine.startRun({ actor: owner, mode: 'assisted', packId: pack.id,
    packVersion: pack.version, graphId, input });
  const evidence = (type, artifacts) => {
    const rule = pack.decisionRules.find(item => item.type === type && item.mode === 'assisted');
    return rule.requiredEvidence.map(kind => ({ kind, subjectRefs: artifacts.map(({ id, version }) => ({ artifactId: id, version })) }));
  };
  async function assess(runId, outcome, version) {
    const scope = { runId, nodeId: 'assess-request' };
    const decision = await engine.recordWorkDecision({ ...scope, actor: productOwner, category: 'process',
      question: 'Which details are missing?', options: [{ id: 'clarify', label: 'Clarify the user' }],
      outcome: 'clarify', reason: 'The source omits the affected user', ruleRef: 'node:assess-request',
      behaviorImpact: 'none', evidence: [{ kind: 'requirement', summary: 'Original dashboard request',
        sourceRef: { kind: 'run_input', key: 'source_request' } }] });
    const submission = triageSubmission({ graphRunId: 'shared-intake', companyId: input.paperclipCompanyId,
      requestId: input.source_request.id, decisionId: decision.id });
    for (const artifact of submission.artifacts) artifact.version = version;
    submission.payloads.request_brief.version = version;
    for (const ref of submission.evidence[0].subjectRefs) ref.version = version;
    await engine.submitNode({ ...scope, actor: productOwner, ...submission });
    await engine.recordSelfReview({ ...scope, actor: productOwner, artifactVersion: version });
    await engine.reviewWork({ ...scope, actor: supervisor, outcome, reason: 'Checked the intake evidence',
      evidence: evidence('review-disposition', submission.artifacts) });
    if (outcome === 'accept') {
      await engine.decideNode({ runId, nodeId: 'triage-disposition', actor: productOwner,
        outcome: 'needs-info', reason: 'Request the missing user details',
        evidence: evidence('request-triage', submission.artifacts.filter(item => item.kind === 'triage_report')) });
      await engine.submitNode({ runId, nodeId: 'triage-needs-info', actor: owner });
      assert.equal((await engine.getRun(runId)).status, 'completed');
    }
  }

  const triage = await start('request-triage');
  time += 10 * minute;
  await assess(triage.id, 'rework', 'v1');
  assert.equal((await engine.getDeliveryStatus(triage.id)).acceptedMilestones.length, 0);
  time += 72_000;
  await assess(triage.id, 'accept', 'v2');
  const original = await engine.getDeliveryStatus(triage.id);
  assert.deepEqual(original.acceptedMilestones.map(item => item.nodeId), ['assess-request']);
  assert.deepEqual(original.acceptedMilestones[0].artifacts.map(item => item.kind), ['triage_report', 'request_brief']);

  const requirements = await start('requirements-baseline');
  time += 1_133_220; // Total active time on this issue now matches the reported 1,805,220 ms.
  const repeat = await start('request-triage');
  await assert.rejects(assess(repeat.id, 'accept', 'v2'), /identity\/version was already submitted/);
  const status = await engine.getDeliveryStatus(requirements.id);
  assert.equal(status.deliveryId, input.paperclipIssueId);
  assert.equal(status.runStatus, 'running');
  assert.deepEqual(status.acceptedMilestones, original.acceptedMilestones);
  assert.equal(status.noProgressRuns, 0);
  assert.equal(status.idleMinutesRemaining, 12);
  time += 666_780; // Exactly 30 active minutes since the fresh intake artifacts were accepted.
  assert.equal((await engine.getRun(requirements.id)).status, 'stopped');
  assert.equal((await engine.listDecisions({ runId: requirements.id })).at(-1).reason, 'idle_progress_limit');
});
