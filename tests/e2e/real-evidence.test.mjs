import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactFile, checkArtifact, checkHandoffInput, checkHeartbeat,
  designHandoff, implementationHandoff, runIndependentTests, sha256 } from '../../scripts/real-evidence.mjs';

test('artifact evidence checks bytes and rejects traversal, probe files and symlink escape', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'polyforge-real-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(project, '.probe'), { recursive: true });
  await writeFile(join(project, 'candidate.html'), '<main>real candidate</main>');
  await writeFile(join(project, '.probe', 'fake.txt'), 'probe');
  await writeFile(join(dir, 'outside.txt'), 'outside');
  const version = sha256(await readFile(join(project, 'candidate.html')));
  assert.equal((await checkArtifact(project, { kind: 'design_candidate', id: 'candidate.html', version })).sha256, version);
  await assert.rejects(checkArtifact(project, { kind: 'design_candidate', id: 'candidate.html', version: '0'.repeat(64) }), /bytes differ/);
  await assert.rejects(artifactFile(project, '../outside.txt'), /escapes project/);
  await assert.rejects(artifactFile(project, '.probe/fake.txt'), /Probe file/);
  try {
    await symlink(join(dir, 'outside.txt'), join(project, 'linked.txt'), 'file');
    await assert.rejects(artifactFile(project, 'linked.txt'), /symlink escapes project/);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.diagnostic('Host disallows file symlink creation; containment code remains covered by path traversal');
  }
});

test('heartbeat claim requires successful real model/provider receipt and matching actor', () => {
  const actor = { id: 'agent-a', executionId: 'host-run-a' };
  const heartbeat = { id: 'host-run-a', companyId: 'company-a', agentId: 'agent-a',
    status: 'succeeded', exitCode: 0,
    runnerProfileJson: { adapterDispatch: { adapterType: 'codex_local' } },
    usageJson: { provider: 'openai', model: 'gpt-6-sol', accountingReceiptReady: true } };
  checkHeartbeat(heartbeat, actor, 'company-a');
  assert.throws(() => checkHeartbeat({ ...heartbeat, status: 'failed' }, actor, 'company-a'), /did not succeed/);
  assert.throws(() => checkHeartbeat({ ...heartbeat, agentId: 'agent-b' }, actor, 'company-a'), /another agent/);
  assert.throws(() => checkHeartbeat({ ...heartbeat, runnerProfileJson: { adapterDispatch: { adapterType: 'process' } } }, actor, 'company-a'), /codex_local/);
  assert.throws(() => checkHeartbeat({ ...heartbeat, usageJson: { ...heartbeat.usageJson, model: 'fixture' } }, actor, 'company-a'), /another model/);
  assert.throws(() => checkHeartbeat({ ...heartbeat, usageJson: { ...heartbeat.usageJson, accountingReceiptReady: false } }, actor, 'company-a'), /complete provider/);
});

test('handoffs reference accepted, current candidate artifacts and reject stale inputs', () => {
  const designArtifact = { kind: 'frozen_visual_a1', id: 'design/a1.html', version: 'a'.repeat(64) };
  const design = { run: { status: 'completed', graph: { nodes: [{ id: 'freeze-a1' },
    { id: 'filter-finalists' }, { id: 'final-design', selection: {
      sourceNodeId: 'filter-finalists', outputKey: 'selectedFinalists', frozenNodeIds: ['freeze-a1'],
    } }] },
    nodeStates: { 'freeze-a1': { status: 'completed', attempts: [{ artifacts: [designArtifact] }] },
      'filter-finalists': { status: 'completed', attempts: [{ output: { selectedFinalists: [
        { artifactId: designArtifact.id, version: designArtifact.version } ] } }] } } },
  decisions: [{ id: 'design-accept', nodeId: 'final-design', outcome: 'accept', artifacts: [designArtifact] }] };
  const designRef = designHandoff(design);
  assert.equal(designRef.decisionId, 'design-accept');
  assert.throws(() => designHandoff({ ...design, decisions: [{ ...design.decisions[0],
    artifacts: [designArtifact, { ...designArtifact, id: 'design/a2.html' }] }] }),
  /exactly one/);
  assert.throws(() => designHandoff({ ...design, run: { ...design.run, nodeStates: {
    ...design.run.nodeStates, 'filter-finalists': { status: 'completed', attempts: [{ output: {
      selectedFinalists: [{ artifactId: 'design/other.html', version: designArtifact.version }],
    } }] },
  } } }), /outside the current shortlist/);
  const backend = { kind: 'backend_candidate', id: 'src/server.mjs', version: 'b'.repeat(64) };
  const frontend = { kind: 'frontend_candidate', id: 'src/client.js', version: 'c'.repeat(64) };
  const implementation = { run: { status: 'completed', nodeStates: {
    backend: { status: 'completed', attempts: [{ artifacts: [backend] }] },
    frontend: { status: 'completed', attempts: [{ artifacts: [frontend] }] } } },
  decisions: [{ id: 'implementation-accept', nodeId: 'implementation-gate', outcome: 'accept',
    evidence: [{ kind: 'candidate_versions', subjectRefs: [
      { artifactId: backend.id, version: backend.version }, { artifactId: frontend.id, version: frontend.version } ] }] }] };
  const implementationRef = implementationHandoff(implementation);
  checkHandoffInput('verification', { final_design_identity: designRef,
    implementation_candidate: implementationRef }, designRef, implementationRef);
  assert.throws(() => checkHandoffInput('implementation', { final_design_identity: { ...designRef, version: 'stale' } }, designRef), /differs/);
  assert.throws(() => implementationHandoff({ ...implementation, decisions: [{ ...implementation.decisions[0], evidence: [] }] }), /did not cite/);
  assert.throws(() => designHandoff({ ...design, decisions: [{ ...design.decisions[0], artifacts: [{ ...designArtifact, version: 'stale' }] }] }), /outside the current shortlist/);
  assert.throws(() => designHandoff({ ...design, run: { ...design.run, nodeStates: {
    ...design.run.nodeStates, 'freeze-a1': { status: 'pending', attempts: [{ artifacts: [designArtifact] }] },
  } } }), /absent from current frozen artifacts/);
});

test('independent test output is captured with a matching hash and failed tests cannot pass', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'polyforge-real-test-output-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(project, 'test'), { recursive: true });
  const testFile = join(project, 'test', 'app.test.mjs');
  const outputPath = join(dir, 'test-output.log');
  await writeFile(testFile, "import assert from 'node:assert/strict'; assert.equal(2 + 2, 4);\n");
  const passed = await runIndependentTests(project, outputPath);
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.outputSha256, sha256(await readFile(outputPath)));
  await writeFile(testFile, "import assert from 'node:assert/strict'; assert.equal(2 + 2, 5);\n");
  await assert.rejects(runIndependentTests(project, outputPath), /Independent tests failed/);
  assert.match(await readFile(outputPath, 'utf8'), /Exit: 1/);
});
