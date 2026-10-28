// Create a real signed two-party conflict for browser QA, then resolve it in a
// separate invocation after the browser reviewer acknowledges the dossier.
// Uses deterministic process agents; it does not validate LLM judgment.
import assert from 'node:assert/strict';
import { fixtureContractInputs } from './fixture-contract-inputs.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const auth = JSON.parse(await readFile(resolve(root, '.e2e/auth.json'), 'utf8'));
const baseline = JSON.parse(await readFile(resolve(root, '.e2e/acceptance-result.json'), 'utf8'));
const oldCheckpoint = JSON.parse(await readFile(resolve(root, '.e2e/acceptance-checkpoint.json'), 'utf8'));
const regression = JSON.parse(await readFile(resolve(root, '.e2e/acceptance-regressions-0.1.7.json'), 'utf8'));
const checkpointPath = resolve(root, '.e2e/browser-conflict-0.1.7.json');
const checkpoint = await readFile(checkpointPath, 'utf8').then(JSON.parse).catch(() => ({}));
const base = (process.env.POLYFORGE_E2E_BASE_URL || 'http://localhost:3310').replace(/\/$/, '');
const origin = process.env.POLYFORGE_E2E_AUTH_ORIGIN || 'http://localhost:3100';
const graphPath = `/api/plugins/pohlee.polyforge-graph/api/issues/${regression.issueId}/graph`;
const save = () => writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    Origin: origin, Cookie: auth.cookie,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : null;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
const read = runId => request('GET', `${graphPath}?runId=${runId}`);
const command = (operation, body, key) => request('POST', graphPath, {
  operation, ...body, idempotencyKey: `browser-conflict:0.1.7:${key}` });

async function start() {
  if (!checkpoint.runId) {
    const design = await read(regression.runs.designSingle);
    const final = design.decisions.findLast(item => item.nodeId === 'final-design' && item.outcome === 'accept');
    assert.equal(final.artifacts.length, 1);
    const chosen = { artifactId: final.artifacts[0].id, version: final.artifacts[0].version };
    const result = await command('start', { graphId: 'implementation', mode: 'autonomous', input: {
      ...fixtureContractInputs('implementation'),
      feature: baseline.feature,
      versioned_requirement: { id: `REQ-${oldCheckpoint.suffix}`, version: 'v1' },
      product_decision_refs: [oldCheckpoint.baselineId], fixtureScenario: 'conflict-stop',
      final_design_identity: { id: chosen.artifactId, version: chosen.version,
        selectedCandidates: [chosen], decisionId: final.id }
    } }, 'start');
    assert.equal(result.run.packVersion, '0.1.7');
    checkpoint.runId = result.run.id;
    await save();
  }
  for (let attempt = 0; attempt < 750; attempt++) {
    const state = await read(checkpoint.runId);
    const conflict = state.run.conflicts?.find(item => item.status === 'waiting_human' && item.protocolVersion === 2);
    if (conflict) {
      const cpo = state.decisions.find(item => item.id === conflict.positionDecisionIds.cpo);
      const cto = state.decisions.find(item => item.id === conflict.positionDecisionIds.cto);
      assert.ok(cpo && cto);
      assert.notEqual(cpo.actor.executionId, cto.actor.executionId);
      checkpoint.conflictId = conflict.id;
      await save();
      console.log(JSON.stringify({ browserUrl: `${base}/POLAAAAAAA/graph-runs?issueId=${regression.issueId}`,
        runId: checkpoint.runId, conflictId: conflict.id, options: conflict.options.map(item => item.id) }));
      return;
    }
    if (state.run.status !== 'running') throw new Error(`Unexpected run status ${state.run.status}`);
    await sleep(1200);
  }
  throw new Error('Timed out waiting for signed strict-v2 conflict');
}

async function resolveStop() {
  assert.ok(checkpoint.runId && checkpoint.conflictId, 'Run must first reach a waiting conflict');
  const before = await read(checkpoint.runId);
  const conflict = before.run.conflicts.find(item => item.id === checkpoint.conflictId);
  let decision;
  if (conflict.status === 'waiting_human') {
    const result = await command('resolve-conflict', { runId: checkpoint.runId,
      conflictId: checkpoint.conflictId, outcome: 'stop',
      reason: 'Trusted owner stops after the browser reviewer inspected the signed conflict dossier.',
      evidence: [{ kind: 'requirement', summary: 'Current versioned requirement',
        sourceRef: { kind: 'run_input', key: 'versioned_requirement' } }] }, 'resolve-stop');
    decision = result.result.decision;
  } else {
    decision = before.decisions.find(item => item.id === conflict.resolutionDecisionId);
  }
  assert.equal(decision.disposition, 'stop');
  const after = await read(checkpoint.runId);
  assert.equal(after.run.status, 'stopped');
  assert.equal(after.ready.length, 0);
  assert.equal(after.work.length, 0);
  assert.ok(after.decisions.filter(item => item.type === 'paperclip_node_dispatch')
    .every(item => new Date(item.at) <= new Date(decision.at)));
  checkpoint.resolutionDecisionId = decision.id;
  await save();
  console.log(JSON.stringify({ runId: checkpoint.runId, conflictId: checkpoint.conflictId,
    resolutionDecisionId: decision.id, disposition: decision.disposition, status: after.run.status }));
}

const action = process.argv[2];
if (action === 'start') await start();
else if (action === 'resolve-stop') await resolveStop();
else throw new Error('Usage: node scripts/e2e-acceptance-browser-conflict.mjs start|resolve-stop');
