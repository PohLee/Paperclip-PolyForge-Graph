import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { client, root, pluginId } from './enhancement-client.mjs';

const checkpoint = resolve(root, '.e2e/enhancement-checkpoint.json');
const state = JSON.parse(await readFile(checkpoint, 'utf8'));
const proof = state.cases.find(item => item.name === 'Real bounded Shadow SDK session and pinned candidate review').proof;
const { data } = await client();
const graphPath = `/api/plugins/${pluginId}/api/issues/${state.development.issueId}/graph?runId=${proof.runId}`;
const current = (await data('GET', graphPath)).run;
const company = await data('GET', `/api/plugins/${pluginId}/api/company?companyId=${proof.companyId}`);
const path = resolve(root, '.e2e/recovery-before.json');
const mode = process.argv[2];
if (mode === 'capture') {
  assert.equal(current.status, 'paused'); assert.ok(current.takeover?.id);
  await writeFile(path, JSON.stringify({ runId: current.id, goalContext: current.goalContext,
    pack: current.pack, graph: current.graph, takeover: current.takeover,
    shadows: company.control.shadows, candidate: current.nodeStates['freeze-candidate'].artifacts }, null, 2));
  console.log('PASS Captured browser takeover and pinned state before restart');
} else {
  const before = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(current.id, before.runId);
  assert.deepEqual(current.goalContext, before.goalContext);
  assert.deepEqual(current.pack, before.pack); assert.deepEqual(current.graph, before.graph);
  assert.deepEqual(current.nodeStates['freeze-candidate'].artifacts, before.candidate);
  assert.deepEqual(company.control.shadows, before.shadows);
  if (mode === 'verify') {
    assert.equal(current.status, 'paused'); assert.deepEqual(current.takeover, before.takeover);
    console.log('PASS Restart preserves human takeover, candidate, goals and closed Shadow');
  } else if (mode === 'resume-verify') {
    assert.equal(current.status, 'running'); assert.equal(current.takeover, null);
    const name = 'Browser human takeover and Docker restart preserve pinned state and resume';
    state.cases = state.cases.filter(item => item.name !== name);
    state.cases.push({ name, status: 'passed', at: new Date().toISOString(), proof: {
      companyId: proof.companyId, runId: current.id, takeoverId: before.takeover.id,
      shadowId: proof.shadowId, status: current.status, pinnedGoalsRetained: true,
    } });
    await writeFile(checkpoint, JSON.stringify(state, null, 2));
    await writeFile(resolve(root, '.e2e/enhancement-result.json'), JSON.stringify(state, null, 2));
    console.log(`PASS ${name}`);
  } else throw new Error('Use capture, verify or resume-verify');
}
