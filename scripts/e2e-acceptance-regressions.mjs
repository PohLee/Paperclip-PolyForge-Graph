// Focused post-upgrade Docker checks. Uses real Paperclip process agents and
// trusted owner actions; fixture outputs are deterministic, not LLM judgments.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = (process.env.POLYFORGE_E2E_BASE_URL || 'http://localhost:3310').replace(/\/$/, '');
const origin = process.env.POLYFORGE_E2E_AUTH_ORIGIN || 'http://localhost:3100';
const auth = JSON.parse(await readFile(resolve(root, '.e2e/auth.json'), 'utf8'));
const oldResult = JSON.parse(await readFile(resolve(root, '.e2e/acceptance-result.json'), 'utf8'));
const oldCheckpoint = JSON.parse(await readFile(resolve(root, '.e2e/acceptance-checkpoint.json'), 'utf8'));
const pack = (await import(pathToFileURL(resolve(root, '..', 'Paperclip-PolyForge-Graph-ADLC', 'index.mjs')).href)).pack;
assert.equal(pack.version, '0.1.6');
const checkpointPath = resolve(root, `.e2e/acceptance-regression-checkpoint-${pack.version}.json`);
const checkpoint = await readFile(checkpointPath, 'utf8').then(JSON.parse).catch(() => ({
  packVersion: pack.version, companyId: oldResult.companyId, issueId: oldResult.issueId,
  suffix: randomUUID().slice(0, 8), runs: {}
}));
assert.equal(checkpoint.packVersion, pack.version);
const save = () => writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const graphPath = `/api/plugins/pohlee.polyforge-graph/api/issues/${checkpoint.issueId}/graph`;

async function request(method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${base}${path}`, { method,
      headers: { Origin: origin, Cookie: auth.cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 300) }; }
    if (response.ok) return data;
    if ([502, 503].includes(response.status) && (method === 'GET' || body?.idempotencyKey) && attempt < 2) {
      await sleep(250 * (attempt + 1));
      continue;
    }
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  }
}
const command = (operation, fields, key) => request('POST', graphPath, {
  operation, ...fields, idempotencyKey: `accept-reg:${checkpoint.suffix}:${key}`
});
const read = runId => request('GET', `${graphPath}?runId=${runId}`);
async function until(predicate, label, maxMs = 900_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(1200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  const installed = await request('GET', '/api/plugins/pohlee.polyforge-graph');
  assert.equal(installed.status, 'ready');
  const catalog = await request('GET', graphPath);
  assert.equal(catalog.pack.version, pack.version);
  assert.equal(catalog.pack.graphs.find(item => item.id === 'ui-ux-design').version, '0.1.2');
  const input = { feature: oldResult.feature,
    versioned_requirement: { id: `REQ-${oldCheckpoint.suffix}`, version: 'v1' },
    product_decision_refs: [oldCheckpoint.baselineId] };
  const start = async (key, graphId, fixtureScenario, extraInput = {}) => {
    if (checkpoint.runs[key]) return checkpoint.runs[key];
    const result = await command('start', { graphId, mode: 'autonomous', input: { ...input, ...extraInput, fixtureScenario } }, `start:${key}`);
    assert.equal(result.run.packVersion, pack.version);
    checkpoint.runs[key] = result.run.id;
    await save();
    return result.run.id;
  };
  const complete = runId => until(async () => {
    const state = await read(runId);
    if (state.run.status === 'completed') return state;
    if (state.run.status !== 'running') throw new Error(`${runId} ended ${state.run.status}`);
    return null;
  }, `run ${runId} completion`);
  const source = () => ({ kind: 'requirement', summary: 'Current versioned requirement',
    sourceRef: { kind: 'run_input', key: 'versioned_requirement' } });
  const checkHeartbeat = async id => {
    const heartbeat = await until(async () => {
      const item = await request('GET', `/api/heartbeat-runs/${id}`);
      return ['succeeded', 'failed', 'cancelled'].includes(item.status) ? item : null;
    }, `terminal heartbeat ${id}`, 120_000);
    assert.equal(heartbeat.status, 'succeeded', `heartbeat ${id}`);
    assert.equal(heartbeat.exitCode, 0, `heartbeat ${id} process did not exit cleanly`);
    assert.equal(heartbeat.companyId, checkpoint.companyId);
  };

  // The new opt-in Design gate must select one exact frozen finalist.
  const designId = await start('designSingle', 'ui-ux-design', 'major-full');
  const design = await complete(designId);
  const shortlist = design.run.nodeStates['filter-finalists'].output.selectedFinalists;
  assert.equal(shortlist.length, 2);
  const final = design.decisions.findLast(item => item.nodeId === 'final-design' && item.outcome === 'accept');
  assert.equal(final.artifacts.length, 1);
  assert.equal(final.artifacts[0].id, shortlist[1].artifactId);
  assert.equal(final.artifacts[0].version, shortlist[1].version);
  assert.ok(design.run.graph.nodes.find(item => item.id === 'final-design').selection);
  assert.ok(design.run.nodeStates['freeze-b1'].artifacts.some(item =>
    item.id === final.artifacts[0].id && item.version === final.artifacts[0].version));
  const traced = design.decisions.filter(item => item.type === 'work_choice');
  assert.ok(traced.length > 0);
  assert.ok(traced.every(item => item.feature === input.feature && item.runId === designId));
  const companyIssues = await request('GET', `/api/companies/${checkpoint.companyId}/issues`);
  const designChildren = companyIssues.filter(item => item.description?.includes(`PolyForge Graph run ${designId},`));
  const currentChildren = designChildren.filter(child => {
    const match = child.description.match(/PolyForge Graph run [\w-]+, node ([\w-]+), attempt (\d+)\./);
    return match && Number(match[2]) === design.run.nodeStates[match[1]]?.attempts.length;
  });
  assert.ok(currentChildren.length >= 50, 'major Design did not create the expected current-attempt child issues');
  const designHeartbeats = await until(async () => {
    const runs = await request('GET', `/api/companies/${checkpoint.companyId}/heartbeat-runs`);
    return currentChildren.every(child => {
      const matches = runs.filter(item => item.issueId === child.id);
      return matches.length === 1 && ['succeeded', 'failed', 'cancelled'].includes(matches[0].status);
    }) ? runs : null;
  }, 'all current major Design child heartbeats terminal', 120_000);
  for (const child of currentChildren) {
    const runs = designHeartbeats.filter(item => item.issueId === child.id);
    assert.equal(runs.length, 1, `duplicate host wakeup for Design child ${child.id}`);
    assert.equal(runs[0].status, 'succeeded', `Design child ${child.id} heartbeat failed`);
    assert.equal(runs[0].exitCode, 0, `Design child ${child.id} process did not exit cleanly`);
  }
  const historicalFailedChildren = designChildren.filter(child => !currentChildren.some(item => item.id === child.id))
    .map(child => ({ issueId: child.id, heartbeatRuns: designHeartbeats.filter(item => item.issueId === child.id)
      .map(item => ({ id: item.id, status: item.status })) }));
  const designIdentity = { id: final.artifacts[0].id, version: final.artifacts[0].version,
    selectedCandidates: [{ artifactId: final.artifacts[0].id, version: final.artifacts[0].version }],
    decisionId: final.id };
  console.log(`Single Design selection passed: ${final.artifacts[0].id}@${final.artifacts[0].version}; ${traced.length} traced decisions; ${currentChildren.length} current child heartbeats succeeded; ${historicalFailedChildren.length} historical retry children retained`);

  // Concurrent dispatch requests must preserve one host run for the same child.
  // Keep the pre-fix saturated run in the checkpoint; use a fresh child and
  // fresh idempotency namespace after the dispatch audit/singleflight fix.
  let raceId = checkpoint.runs.raceMinorPostFix;
  let raceBefore = checkpoint.raceDispatchPostFix;
  if (!raceId) {
    const started = await command('start', { graphId: 'ui-ux-design', mode: 'autonomous',
      input: { ...input, fixtureScenario: 'race-minor' } }, 'start:raceMinorPostFix');
    raceId = started.run.id;
    raceBefore = started.dispatch.find(row => row.nodeId === 'classify-design' && row.phase === 'work');
    assert.ok(raceBefore?.agentRunId, 'start did not dispatch the pending classify-design task');
    checkpoint.runs.raceMinorPostFix = raceId;
    checkpoint.raceDispatchPostFix = raceBefore;
    await save();
  }
  const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    command('dispatch', { runId: raceId,
      reason: 'Authenticated owner repeats dispatch to verify one wake for this current pending Graph node.' },
    `race:${raceId}:${index}`)));
  assert.equal(concurrent.length, 12);
  const race = await complete(raceId);
  const activeAttempt = race.run.nodeStates['classify-design'].attempts.findLast(item => item.actor?.executionId);
  assert.equal(activeAttempt.actor.executionId, raceBefore.agentRunId);
  await checkHeartbeat(raceBefore.agentRunId);
  const heartbeatRuns = await request('GET', `/api/companies/${checkpoint.companyId}/heartbeat-runs`);
  const forChild = heartbeatRuns.filter(item => item.issueId === raceBefore.issueId);
  assert.equal(forChild.length, 1, 'concurrent dispatch created duplicate host runs for one child issue');
  assert.equal(forChild[0].id, raceBefore.agentRunId);
  const ownerDispatchDecisions = race.decisions.filter(item => item.type === 'paperclip_dispatch_recovery');
  assert.equal(ownerDispatchDecisions.length, 12, 'each owner dispatch request needs its own durable decision');
  assert.equal(new Set(ownerDispatchDecisions.map(item => item.id)).size, 12);
  assert.ok(ownerDispatchDecisions.every(item => item.actor.kind === 'human' &&
    item.runId === raceId && item.packVersion === pack.version && item.reason));
  console.log(`Concurrent dispatch passed: 12 callers and 12 audited decisions, one child and heartbeat ${raceBefore.agentRunId}`);

  const conflictState = async runId => until(async () => {
    const state = await read(runId);
    const conflict = state.run.conflicts?.find(item =>
      ['waiting_human', 'resolved'].includes(item.status) && item.protocolVersion === 2);
    return conflict ? { state, conflict } : null;
  }, `strict conflict for ${runId}`);
  const signedPositions = ({ state, conflict }, runId) => {
    const cpo = state.decisions.find(item => item.id === conflict.positionDecisionIds.cpo);
    const cto = state.decisions.find(item => item.id === conflict.positionDecisionIds.cto);
    assert.equal(cpo.runId, runId); assert.equal(cto.runId, runId);
    assert.notEqual(cpo.actor.executionId, cto.actor.executionId);
  };

  const continueId = await start('conflictContinue', 'implementation', 'conflict-continue', { final_design_identity: designIdentity });
  const continuing = await conflictState(continueId);
  signedPositions(continuing, continueId);
  if (!checkpoint.browserPauseDone && continuing.conflict.status === 'waiting_human') {
    checkpoint.browserPauseDone = true;
    await save();
    console.log(`BROWSER_QA_CONFLICT ${JSON.stringify({ companyId: checkpoint.companyId, issueId: checkpoint.issueId,
      runId: continueId, conflictId: continuing.conflict.id, holdSeconds: 45 })}`);
    await sleep(45_000);
  }
  const continued = continuing.conflict.status === 'resolved'
    ? { result: { decision: continuing.state.decisions.find(item => item.id === continuing.conflict.resolutionDecisionId) } }
    : await command('resolve-conflict', { runId: continueId, conflictId: continuing.conflict.id,
      outcome: 'proceed', reason: 'Trusted owner accepts the bounded risk after reviewing both signed positions.',
      evidence: [source()] }, `continue:${continuing.conflict.id}`);
  assert.equal(continued.result.decision.disposition, 'continue');
  const continueRun = await complete(continueId);
  const gateAccept = continueRun.decisions.findLast(item => item.nodeId === 'implementation-gate' && item.outcome === 'accept');
  assert.ok(gateAccept.evidence.some(item => item.kind === 'conflict_resolution' && item.decisionId === continued.result.decision.id));
  console.log(`Conflict continue passed: human resolution ${continued.result.decision.id} bound to gate acceptance`);

  const stopId = await start('conflictStop', 'implementation', 'conflict-stop', { final_design_identity: designIdentity });
  const stopping = await conflictState(stopId);
  signedPositions(stopping, stopId);
  const stopped = stopping.conflict.status === 'resolved'
    ? { result: { decision: stopping.state.decisions.find(item => item.id === stopping.conflict.resolutionDecisionId) } }
    : await command('resolve-conflict', { runId: stopId, conflictId: stopping.conflict.id,
      outcome: 'stop', reason: 'Trusted owner stops this Graph after unresolved product and technical risk.',
      evidence: [source()] }, `stop:${stopping.conflict.id}`);
  assert.equal(stopped.result.decision.disposition, 'stop');
  const stoppedRun = await read(stopId);
  assert.equal(stoppedRun.run.status, 'stopped');
  assert.equal(stoppedRun.ready.length, 0);
  assert.equal(stoppedRun.work.length, 0);
  assert.ok(stoppedRun.decisions.filter(item => item.type === 'paperclip_node_dispatch')
    .every(item => new Date(item.at) <= new Date(stopped.result.decision.at)),
  'stopped Graph created a new dispatch after human resolution');
  for (const dispatch of stoppedRun.dispatches) await checkHeartbeat(dispatch.agentRunId);
  assert.ok(!stoppedRun.decisions.some(item => item.nodeId === 'implementation-gate' && item.outcome === 'accept'));
  console.log(`Conflict stop passed: run ${stopId} stopped without downstream dispatch`);

  const result = { kind: 'deterministic-host-fixture', packVersion: pack.version,
    companyId: checkpoint.companyId, issueId: checkpoint.issueId,
    runs: { designSingle: designId, raceMinor: raceId, conflictContinue: continueId, conflictStop: stopId },
    decisions: { selectedDesign: final.id, continue: continued.result.decision.id, stop: stopped.result.decision.id },
    race: { childIssueId: raceBefore.issueId, heartbeatRunId: raceBefore.agentRunId,
      concurrentCallers: 12, auditedOwnerRequests: ownerDispatchDecisions.length,
      majorDesignCurrentChildHeartbeats: currentChildren.length,
      historicalRetryChildren: historicalFailedChildren },
    limitation: 'This validates host dispatch and decision enforcement with deterministic process fixtures, not LLM business judgment.' };
  await writeFile(resolve(root, `.e2e/acceptance-regressions-${pack.version}.json`), JSON.stringify(result, null, 2));
  return result;
}

run().then(result => console.log(`Focused Docker regressions passed; evidence .e2e/acceptance-regressions-${result.packVersion}.json`))
  .catch(error => { console.error(error); process.exitCode = 1; });
