// Validates actual Paperclip Graph callbacks and files written by model agents.
// Verification also reruns the local test suite and stores its transcript in .e2e/.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkArtifact, checkHeartbeat, checkHandoffInput, designHandoff,
  implementationHandoff, runIndependentTests } from './real-evidence.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const project = resolve(root, 'examples/decision-register');
const auth = JSON.parse(await readFile(resolve(root, '.e2e/real-auth.json'), 'utf8'));
const state = JSON.parse(await readFile(resolve(root, '.e2e/real-graph.json'), 'utf8'));
const base = 'http://localhost:3311';
const pluginId = 'pohlee.polyforge-graph';
const graphIds = { design: state.designRunId, implementation: state.implementationRunId,
  verification: state.verificationRunId };
const expectedGraphIds = { design: 'ui-ux-design', implementation: 'implementation', verification: 'verification' };
const legacyDesignRunId = 'cec44417-b219-4b8f-b22b-be02d25ad6db';

async function get(path) {
  const response = await fetch(new URL(path, base), {
    headers: { Cookie: auth.cookie, Origin: base },
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}
async function settledHeartbeat(id) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const heartbeat = await get(`/api/heartbeat-runs/${id}`);
    if (!['queued', 'running', 'starting'].includes(heartbeat.status) || Date.now() >= deadline) return heartbeat;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
export async function validateRealRun(name, runId) {
  assert.ok(runId, `${name} run has not started`);
  const path = `/api/plugins/${pluginId}/api/issues/${state.rootIssueId}/graph?runId=${runId}`;
  const data = await get(path);
  const run = data.run;
  assert.equal(run.id, runId);
  const pinned = state.runVersions?.[name] ?? (name === 'design' && runId === legacyDesignRunId
    ? { packVersion: '0.1.4', graphVersion: '0.1.1' } : null);
  assert.ok(pinned, `${name} has no saved pinned Pack/Graph version`);
  assert.equal(run.graph.id, expectedGraphIds[name], `${name} state points to a different Graph`);
  assert.equal(run.packId, 'adlc');
  assert.equal(run.packVersion, pinned.packVersion, `${name} Pack version differs from saved start response`);
  assert.equal(run.graph.version, pinned.graphVersion,
    `${name} Graph version is not the pinned acceptance version`);
  assert.equal(run.input.versioned_requirement?.sha256, state.briefSha256,
    'Run requirement hash differs from the approved local brief');
  const actualBriefHash = (await checkArtifact(project, { kind: 'versioned_requirement', id: 'BRIEF.md',
    version: state.briefSha256 })).sha256;
  assert.equal(actualBriefHash, state.briefSha256);
  assert.equal(run.status, 'completed', `${name} Graph is ${run.status}`);
  if (name === 'implementation') {
    const design = await get(`/api/plugins/${pluginId}/api/issues/${state.rootIssueId}/graph?runId=${state.designRunId}`);
    checkHandoffInput('implementation', run.input, designHandoff(design));
  } else if (name === 'verification') {
    const design = await get(`/api/plugins/${pluginId}/api/issues/${state.rootIssueId}/graph?runId=${state.designRunId}`);
    const implementation = await get(`/api/plugins/${pluginId}/api/issues/${state.rootIssueId}/graph?runId=${state.implementationRunId}`);
    checkHandoffInput('verification', run.input, designHandoff(design), implementationHandoff(implementation));
  }
  const decisions = new Map(data.decisions.map(item => [item.id, item]));
  const executionClaims = new Map();
  const claimExecution = (actor, nodeId, phase, attempt) => {
    assert.ok(!executionClaims.has(actor.executionId),
      `Host heartbeat ${actor.executionId} is claimed by multiple Graph nodes or phases`);
    executionClaims.set(actor.executionId, { actor, nodeId, phase, attempt });
  };
  const artifacts = [];
  const completed = run.graph.nodes.filter(node => run.nodeStates[node.id]?.status === 'completed');
  for (const node of completed) {
    const nodeState = run.nodeStates[node.id];
    const attempt = nodeState.attempts?.at(-1);
    if (node.type === 'join' || node.type === 'end') continue;
    assert.ok(attempt, `Completed ${node.id} lacks an attempt`);
    if (attempt.actor?.kind === 'agent') {
      assert.ok(attempt.actor.executionId, `${node.id} lacks a host run identity`);
      claimExecution(attempt.actor, node.id, 'work', nodeState.attempts.length);
    } else {
      assert.ok(node.type === 'decision' && name === 'verification' &&
        attempt.actor?.kind === 'human' && attempt.actor.roles?.includes('human-owner'),
      `${node.id} was not executed by an authorized Paperclip agent or verification owner`);
    }
    if (node.type === 'task') {
      assert.equal(attempt.actor?.kind, 'agent', `${node.id} task was not executed by an agent`);
      for (const kind of node.produces ?? []) {
        const artifact = run.nodeStates[node.id].artifacts?.find(item => item.kind === kind);
        assert.ok(artifact, `${node.id} did not submit ${kind}`);
        artifacts.push({ nodeId: node.id, ...await checkArtifact(project, artifact) });
      }
      if (node.decisionTraceRequired) {
        assert.ok(attempt.decisionIds?.length, `${node.id} lacks work Decision Records`);
        for (const decisionId of attempt.decisionIds) {
          const decision = decisions.get(decisionId);
          assert.ok(decision && decision.actor?.executionId === attempt.actor.executionId,
            `${node.id} work Decision Record has wrong execution identity`);
          assert.ok(decision.question && decision.reason && decision.evidence?.length,
            `${node.id} work Decision Record is incomplete`);
        }
      }
      if (node.review) {
        assert.ok(attempt.selfReviews?.length, `${node.id} lacks self review`);
        for (const review of attempt.selfReviews) {
          assert.equal(review.actor?.executionId, attempt.actor.executionId,
            `${node.id} self review was not in the producing execution`);
        }
        assert.equal(attempt.selfReviews.at(-1).artifactVersion, attempt.artifacts.at(-1)?.version,
          `${node.id} latest self review does not cite current artifact`);
        assert.equal(attempt.supervisorReview?.outcome, 'accept', `${node.id} lacks accepted independent review`);
        const supervisor = attempt.supervisorReview.actor;
        assert.ok(supervisor?.executionId && supervisor.executionId !== attempt.actor.executionId,
          `${node.id} supervisor review was not independent`);
        claimExecution(supervisor, node.id, 'supervisor', nodeState.attempts.length);
        assert.ok(decisions.has(attempt.supervisorReview.decisionId),
          `${node.id} supervisor review Decision Record is missing`);
      }
    } else if (node.type === 'decision') {
      assert.ok(decisions.has(attempt.decisionId), `${node.id} lacks its routed Decision Record`);
    }
  }
  const checkedAgents = new Set();
  for (const [id, claim] of executionClaims) {
    const heartbeat = await settledHeartbeat(id);
    checkHeartbeat(heartbeat, claim.actor, state.companyId);
    assert.ok(heartbeat.issueId, `${claim.nodeId} heartbeat has no Paperclip issue`);
    const issue = await get(`/api/issues/${heartbeat.issueId}`);
    assert.equal(issue.parentId, state.rootIssueId, `${claim.nodeId} heartbeat issue is outside Graph root`);
    assert.ok(issue.description?.includes(`PolyForge Graph run ${run.id}, node ${claim.nodeId}, attempt ${claim.attempt}.`),
      `${claim.nodeId} heartbeat issue is not the pinned Graph dispatch`);
    assert.equal(issue.originId, `${run.id}:${claim.nodeId}:${claim.attempt}:${claim.phase}`,
      `${claim.nodeId} heartbeat issue has the wrong dispatch origin`);
    if (claim.phase === 'supervisor') assert.ok(issue.title?.includes('review'),
      `${claim.nodeId} supervisor heartbeat was not a review dispatch`);
    if (!checkedAgents.has(claim.actor.id)) {
      const agent = await get(`/api/agents/${claim.actor.id}`);
      assert.equal(agent.companyId, state.companyId);
      assert.equal(agent.adapterType, 'codex_local', 'Current agent adapter is not codex_local');
      assert.equal(agent.adapterConfig?.model, 'gpt-6-sol', 'Current agent model differs from recorded usage');
      // Paperclip's run response records adapter type and model/provider usage,
      // but not the historical reasoning effort. This checks only the current
      // agent configuration; reports must not claim run-time High proof.
      assert.equal(agent.adapterConfig?.modelReasoningEffort, 'high',
        'Current agent reasoning configuration is not high');
      checkedAgents.add(claim.actor.id);
    }
  }
  assert.ok(artifacts.length > 0, `${name} has no on-disk versioned artifacts`);
  const handoff = name === 'design' ? designHandoff(data)
    : name === 'implementation' ? implementationHandoff(data) : null;
  const independentTests = name === 'verification' ? await runIndependentTests(project,
    resolve(root, '.e2e', `real-test-output-${runId}.txt`)) : null;
  console.log(JSON.stringify({ name, runId, packVersion: run.packVersion,
    graphVersion: run.graph.version, completedNodes: completed.length,
    successfulHeartbeats: executionClaims.size,
    verifiedArtifacts: artifacts.length, artifacts, handoff, independentTests,
    reasoningEvidence: 'current_agent_config_only; host run did not expose historical effort' }));
  return { data, artifacts, handoff, independentTests };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const selected = process.argv[2];
  assert.ok(Object.hasOwn(graphIds, selected), 'Usage: node scripts/validate-real-run.mjs design|implementation|verification');
  const validated = await validateRealRun(selected, graphIds[selected]);
  if (selected === 'design' || selected === 'implementation') {
    const key = selected === 'design' ? 'designHandoff' : 'implementationHandoff';
    if (state[key]) assert.deepEqual(state[key], validated.handoff, `Persisted ${key} differs from live evidence`);
  }
}
