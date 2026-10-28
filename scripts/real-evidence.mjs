// Evidence checks for the isolated, model-powered Decision Register run.
// These helpers are intentionally usable without Paperclip so failure cases can be tested.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function within(root, target) {
  const rel = relative(root, target);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function artifactFile(project, id) {
  assert.equal(typeof id, 'string', 'Artifact ID must be a path');
  const prefix = '/workspace/decision-register/';
  const child = id.startsWith(prefix) ? id.slice(prefix.length) : id;
  assert.ok(child && !isAbsolute(child) && !child.includes('\\') && !child.includes('\0'),
    `Artifact ID is not a project file: ${id}`);
  const projectReal = await realpath(project);
  const lexical = resolve(projectReal, child);
  assert.ok(within(projectReal, lexical), `Artifact path escapes project: ${id}`);
  const target = await realpath(lexical);
  assert.ok(within(projectReal, target), `Artifact symlink escapes project: ${id}`);
  const rel = relative(projectReal, target);
  assert.ok(rel !== '.probe' && !rel.startsWith(`.probe${sep}`), `Probe file is not a deliverable: ${id}`);
  assert.ok((await stat(target)).isFile(), `Artifact is not a file: ${id}`);
  return target;
}

export async function checkArtifact(project, artifact) {
  assert.ok(artifact?.kind && artifact.id && artifact.version, 'Versioned artifact is incomplete');
  const digest = /^(?:sha256[:\-])?([a-f0-9]{64})$/i.exec(artifact.version)?.[1]?.toLowerCase();
  assert.ok(digest, `Artifact version must be SHA-256: ${artifact.id}`);
  const target = await artifactFile(project, artifact.id);
  assert.equal(sha256(await readFile(target)), digest, `Artifact bytes differ from submitted hash: ${artifact.id}`);
  return { kind: artifact.kind, id: artifact.id, version: artifact.version, sha256: digest };
}

export function checkHeartbeat(heartbeat, actor, companyId) {
  assert.equal(heartbeat?.id, actor?.executionId, 'Heartbeat ID differs from trusted Graph actor execution');
  assert.equal(heartbeat.companyId, companyId, 'Heartbeat belongs to another company');
  assert.equal(heartbeat.agentId, actor.id, 'Heartbeat belongs to another agent');
  assert.equal(heartbeat.status, 'succeeded', `Graph callback heartbeat ${heartbeat.id} did not succeed`);
  assert.equal(heartbeat.exitCode, 0, `Graph callback heartbeat ${heartbeat.id} exited unsuccessfully`);
  assert.equal(heartbeat.runnerProfileJson?.adapterDispatch?.adapterType, 'codex_local',
    'Graph callback did not use Paperclip codex_local');
  assert.equal(heartbeat.usageJson?.provider, 'openai', 'Graph callback has no OpenAI provider receipt');
  assert.equal(heartbeat.usageJson?.model, 'gpt-6-sol', 'Graph callback used another model');
  assert.equal(heartbeat.usageJson?.accountingReceiptReady, true,
    'Graph callback lacks a complete provider accounting receipt');
}

function acceptedDecision(data, nodeId) {
  const decision = data.decisions.findLast((item) => item.nodeId === nodeId && item.outcome === 'accept');
  assert.ok(decision?.id, `Missing accepted ${nodeId} Decision Record`);
  return decision;
}

function currentArtifact(data, nodeId, kind) {
  const state = data.run.nodeStates[nodeId];
  assert.equal(state?.status, 'completed', `${nodeId} is not completed`);
  const artifact = state.attempts.at(-1)?.artifacts?.find((item) => item.kind === kind);
  assert.ok(artifact, `${nodeId} has no current ${kind} artifact`);
  return artifact;
}

export function designHandoff(data) {
  assert.equal(data.run.status, 'completed', 'Design run is incomplete');
  const decision = acceptedDecision(data, 'final-design');
  const selectedCandidates = (decision.artifacts ?? []).map((item) => ({ artifactId: item.id, version: item.version }));
  assert.equal(selectedCandidates.length, 1,
    'Final CPO Design approval must select exactly one versioned frozen candidate');
  const selection = data.run.graph.nodes.find((node) => node.id === 'final-design')?.selection;
  const frozenNodeIds = selection?.frozenNodeIds ?? data.run.graph.nodes
    .filter((node) => /^freeze-[ab][1-4]$/.test(node.id)).map((node) => node.id);
  const sourceNodeId = selection?.sourceNodeId ?? 'filter-finalists';
  const outputKey = selection?.outputKey ?? 'selectedFinalists';
  assert.equal(data.run.nodeStates[sourceNodeId]?.status, 'completed', 'Finalist shortlist is not completed');
  const shortlist = data.run.nodeStates[sourceNodeId].attempts.at(-1)?.output?.[outputKey];
  assert.ok(Array.isArray(shortlist) && shortlist.length > 0, 'Finalist shortlist has no current refs');
  const available = data.run.graph.nodes.filter((node) => frozenNodeIds.includes(node.id) &&
    data.run.nodeStates[node.id]?.status === 'completed')
    .flatMap((node) => data.run.nodeStates[node.id]?.attempts?.at(-1)?.artifacts ?? []);
  for (const ref of selectedCandidates) {
    assert.ok(shortlist.some((item) => item.artifactId === ref.artifactId && item.version === ref.version),
      'Final Design selected a candidate outside the current shortlist');
    assert.ok(available.some((item) => item.id === ref.artifactId && item.version === ref.version),
      'Final Design selected a candidate absent from current frozen artifacts');
  }
  return { id: selectedCandidates[0].artifactId, version: selectedCandidates[0].version,
    selectedCandidates, decisionId: decision.id };
}

export function implementationHandoff(data) {
  assert.equal(data.run.status, 'completed', 'Implementation run is incomplete');
  const decision = acceptedDecision(data, 'implementation-gate');
  const candidates = [currentArtifact(data, 'backend', 'backend_candidate'),
    currentArtifact(data, 'frontend', 'frontend_candidate')];
  const references = candidates.map((item) => ({ kind: item.kind, artifactId: item.id, version: item.version }));
  const evidenceRefs = (decision.evidence ?? []).flatMap((item) => item.subjectRefs ?? []);
  for (const ref of references) {
    assert.ok(evidenceRefs.some((item) => item.artifactId === ref.artifactId && item.version === ref.version),
      `Implementation gate did not cite current ${ref.kind}`);
  }
  return { artifacts: references, decisionId: decision.id };
}

export function checkHandoffInput(graphId, input, design, implementation) {
  if (graphId === 'implementation' || graphId === 'verification') {
    assert.deepEqual(input.final_design_identity, design, 'Downstream Design handoff differs from validated decision');
  }
  if (graphId === 'verification') {
    assert.deepEqual(input.implementation_candidate, implementation,
      'Verification candidate differs from validated Implementation gate');
  }
}

export async function runIndependentTests(project, outputPath) {
  const testRoot = resolve(project, 'test');
  const projectReal = await realpath(project);
  const testReal = await realpath(testRoot);
  assert.ok(within(projectReal, testReal), 'Test directory escapes project');
  const names = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:test|spec)\.(?:mjs|cjs|js)$/.test(entry.name)) names.push(path);
    }
  }
  await visit(testRoot);
  assert.ok(names.length > 0, 'No API/UI test files found under test/');
  names.sort();
  let stdout = '', stderr = '', exitCode = 0;
  try {
    // Do not inherit Node's parent test-runner context when this helper is
    // exercised from a test: the child must be an independent test process.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    ({ stdout, stderr } = await execFileAsync(process.execPath, ['--test', '--test-reporter=tap', ...names],
      { cwd: project, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }));
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
    exitCode = error.code ?? 1;
  }
  const output = `Command: ${process.execPath} --test --test-reporter=tap ${names.map((name) => relative(project, name)).join(' ')}\n` +
    `Exit: ${exitCode}\n\n${stdout}${stderr}`;
  await writeFile(outputPath, output, { mode: 0o600 });
  assert.equal(exitCode, 0, `Independent tests failed; saved output at ${outputPath}`);
  const passed = Number(/^# pass (\d+)$/m.exec(stdout)?.[1] ?? 0);
  assert.ok(passed > 0, `Independent test runner reported no passing tests; saved output at ${outputPath}`);
  return { command: 'node --test --test-reporter=tap test/*', testFiles: names.map((name) => relative(project, name)),
    outputPath, outputSha256: sha256(output), exitCode, passed };
}
