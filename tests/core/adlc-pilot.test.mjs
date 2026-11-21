import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GraphEngine, MemoryStore, runValidationDigest } from '../../src/core/index.mjs';
import { createSmallChangeGitInspector } from '../../src/host/small-change-git.mjs';
import { createPackHostAdapterRegistry } from '../../src/plugin/pack-host-support.mjs';
import { loadSmallChangePilotHost } from '../../src/plugin/small-change-pilot-host.mjs';
import { packDigest } from '../../src/plugin/pack-snapshot.mjs';
import { pack, createAdlcHostApi } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';

const owner = { id: 'owner', kind: 'human', roles: ['human-owner', 'cto-caio'], executionId: null };
const planner = { id: 'planner', kind: 'agent', roles: ['principal-engineer'], executionId: 'plan' };
const producer = { id: 'implementer', kind: 'agent', roles: ['lead-engineer'], executionId: 'build' };
const reviewer = { id: 'reviewer', kind: 'agent', roles: ['principal-engineer'], executionId: 'independent-review' };
const automatic = { id: 'runner', kind: 'system', roles: [], executionId: null };
const flags = { permissions: false, sensitiveData: false, migration: false, sharedContract: false,
  externalIntegration: false, productionOperation: false };

async function setup(t) {
  const repo = await mkdtemp(join(tmpdir(), 'polyforge-small-change-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', repo, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Isolated pilot');
  git('config', 'user.email', 'pilot@example.invalid');
  await writeFile(join(repo, 'README.md'), 'Read the instalation guide.\n');
  await writeFile(join(repo, 'auth.txt'), 'Authorization policy\n');
  git('add', '--', 'README.md', 'auth.txt');
  git('commit', '--quiet', '-m', 'Fixture base');
  const baseSha = git('rev-parse', 'HEAD');
  let checkCalls = 0;
  let failedCheck = false;
  let checkoutAvailable = true;
  const inspectSmallChange = createSmallChangeGitInspector({ lookup: async ({ companyId, projectId, issueId }) => {
    if (!checkoutAvailable || [companyId, projectId, issueId].join('/') !== 'fixture/docs/issue') return null;
    return { key: 'test-checkout', path: repo, checkId: 'spelling', reviewerId: reviewer.id, allowedPaths: ['README.md'],
      requirementId: 'DOC-1', requirementVersion: '1', approvalId: approved.id,
      reviewDiff: async ({ head, patch }) => {
        const editedLines = patch.split('\n').filter(line => /^[+-][^+-]/.test(line));
        const approved = ['-Read the instalation guide.', '+Read the installation guide.'];
        if (JSON.stringify(editedLines) !== JSON.stringify(approved)) return { outcome: 'outside-scope' };
        return { outcome: 'within-scope', headSha: head, evidenceRef: 'fixture://approved-diff/' + head };
      },
      check: async ({ cwd, head, checkId }) => {
        checkCalls++;
        const result = await readFile(join(cwd, 'README.md'), 'utf8');
        return { id: checkId, headSha: head, result: !failedCheck && result === 'Read the installation guide.\n' ? 'pass' : 'fail',
          evidenceRef: 'fixture://spelling/' + head };
      } };
  } });
  const store = new MemoryStore();
  const raw = new GraphEngine({ store, availableCapabilities: { 'adlc-small-change-pilot': '1.0.0' } });
  await raw.registerPack(pack);
  const bindings = new Map();
  const adapters = hostServices => createPackHostAdapterRegistry({ trustedAdapters: [{
    packId: pack.id, packVersion: pack.version, packDigest: packDigest(pack),
    adapterId: 'adlc-host-api', adapterVersion: '1', createHostApi: createAdlcHostApi,
  }], runtimeStore: { get: async (_company, id) => bindings.get(id), record: async (_company, id, row) => bindings.set(id, row) },
  runValidationDigest, adapterBundleDigest: 'isolated-adlc-adapter', systemActorId: automatic.id,
  hostServices });
  const withInspector = adapters({ services: { inspectSmallChange } });
  const withoutInspector = adapters({});
  const engine = withInspector.withEngine(raw, 'fixture', [pack]);
  const approved = await raw.recordProductDecision({ feature: 'docs', actor: owner, status: 'approved',
    outcome: 'Correct spelling in README', reason: 'Approve the isolated sample',
    evidence: [{ kind: 'requirement', id: 'DOC-1' }] });
  const input = { paperclipCompanyId: 'fixture', projectId: 'docs', paperclipIssueId: 'issue', feature: 'docs',
    versioned_requirement: { id: 'DOC-1', version: '1' }, product_decision_refs: [approved.id],
    final_design_identity: { id: 'DESIGN-1', version: '1' },
    architecture_context: { disposition: 'not-applicable', rationale: 'Existing local documentation surface' },
    acceptance_criteria: [{ id: 'SPELL-1', description: 'Correct the spelling', requirementIds: ['DOC-1'] }],
    pilot_scope: { baseSha, kind: 'documentation', paths: ['README.md'], risks: flags,
      approvalId: approved.id, reviewer: reviewer.id, rollback: 'single-commit', checkId: 'spelling' } };
  const start = { packId: pack.id, packVersion: pack.version, graphId: 'small-change', actor: owner, mode: 'manual', input,
    idempotencyKey: 'fixture-start' };
  const step = async (run, nodeId, actor, artifacts) => {
    const trace = await engine.recordWorkDecision({ runId: run.id, nodeId, actor, category: 'process',
      question: 'Which approved scope applies?', options: [{ id: 'scope', label: 'Use approved scope' }],
      outcome: 'scope', reason: 'Follow the pinned requirement', ruleRef: 'node:' + nodeId, behaviorImpact: 'none',
      evidence: [{ kind: 'requirement', sourceRef: { kind: 'run_input', key: 'versioned_requirement' }, summary: 'Pinned DOC-1' }] });
    return { runId: run.id, nodeId, actor, artifacts, decisionIds: [trace.id], idempotencyKey: 'submit-' + nodeId };
  };
  async function candidate({ extra = false, wrong = false, multiple = false } = {}) {
    await writeFile(join(repo, 'README.md'), wrong ? 'Read this different guide.\n' : 'Read the installation guide.\n');
    if (extra) await writeFile(join(repo, 'auth.txt'), 'Changed authorization policy\n');
    git('add', '--', 'README.md', 'auth.txt');
    git('commit', '--quiet', '-m', 'Fixture candidate');
    if (multiple) git('commit', '--quiet', '--allow-empty', '-m', 'Second fixture commit');
    const head = git('rev-parse', 'HEAD');
    return [{ kind: 'implementation_candidate', id: 'candidate', version: head },
      { kind: 'test_report', id: 'check', version: head }];
  }
  return { engine, raw, start, store, step, candidate, checks: () => checkCalls,
    coldEngine: withoutInspector.withEngine(raw, 'fixture', [pack]),
    unavailable: () => { checkoutAvailable = false; }, failCheck: () => { failedCheck = true; } };
}

test('the worker pilot is disabled by default and accepts only operator-listed companies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polyforge-small-change-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await loadSmallChangePilotHost(root), null);
  await writeFile(join(root, 'polyforge.small-change-pilot.mjs'),
    "export default { companyIds: ['isolated'], lookup: () => { throw new Error('isolated lookup called'); } };\n");
  const pilot = await loadSmallChangePilotHost(root);
  assert.equal(pilot.supportsCompany('isolated'), true);
  assert.equal(pilot.supportsCompany('other'), false);
  await assert.rejects(pilot.inspectSmallChange({ phase: 'admission', input: { paperclipCompanyId: 'other' } }), /checkout/);
  await assert.rejects(pilot.inspectSmallChange({ phase: 'admission', input: { paperclipCompanyId: 'isolated' } }), /isolated lookup called/);
});

test('the fast path requires trusted admission and independently reviews the exact committed candidate', async t => {
  const f = await setup(t);
  const normal = new GraphEngine();
  await normal.registerPack(pack);
  await assert.rejects(normal.startRun(f.start), /adlc-small-change-pilot/);
  await assert.rejects(f.raw.startRun(f.start), /trusted admission/);
  await assert.rejects(f.engine.startRun({ ...f.start, actor: planner }), /human owner/);
  const run = await f.engine.startRun(f.start);
  assert.equal(run.graph.id, 'small-change');
  assert.equal(run.admission.outcome, 'eligible');
  assert.equal(run.id, (await f.engine.startRun(f.start)).id);
  await f.engine.submitNode(await f.step(run, 'verify-scope', planner, [{ kind: 'scope_record', id: 'scope', version: '1' }]));
  const artifacts = await f.candidate();
  const work = await f.step(run, 'change-and-check', producer, artifacts);
  await assert.rejects(f.raw.submitNode(work), /trusted candidate diff review/);
  const submitted = await f.engine.submitNode(work);
  assert.deepEqual(submitted.attempts[0].submissionReview.diff, [{ path: 'README.md', status: 'M' }]);
  assert.equal(submitted.attempts[0].submissionReview.scopeEvidenceRef, `fixture://approved-diff/${artifacts[0].version}`);
  assert.equal(f.checks(), 1);
  const self = { runId: run.id, nodeId: work.nodeId, actor: producer, artifactVersion: artifacts[0].version, findings: [] };
  await assert.rejects(f.engine.recordSelfReview({ ...self, revisedArtifact: { ...artifacts[0], version: 'different' } }), /new diff review/);
  await f.engine.recordSelfReview(self);
  await assert.rejects(f.engine.recordSelfReview(self), /awaiting self review/);
  assert.deepEqual(await f.engine.getWorkItems(run.id), [{ nodeId: work.nodeId, phase: 'supervisor',
    operation: 'review', role: 'principal-engineer', outcomes: ['accept', 'rework'], kind: 'agent' }]);
  const refs = items => items.map(({id, version}) => ({artifactId:id, version}));
  const evidence = (kinds, subjectRefs) => kinds.map(kind => ({ kind, subjectRefs }));
  const review = { runId: run.id, nodeId: work.nodeId, outcome: 'accept', reason: 'Independent readback',
    evidence: evidence(['artifact_version', 'review_findings', 'self_review_history'], refs(artifacts)) };
  await assert.rejects(f.engine.reviewWork({ ...review, actor: { ...reviewer, id: 'different' } }), /pinned at admission/);
  await assert.rejects(f.engine.reviewWork({ ...review, actor: { ...reviewer, kind: 'human', executionId: null } }), /Actor kind not allowed/);
  await f.engine.reviewWork({ ...review, actor: reviewer });
  assert.deepEqual((await f.engine.getWorkItems(run.id)).map(item => [item.nodeId, item.kind]), [['pilot-acceptance', 'human']]);
  const gate = { runId: run.id, nodeId: 'pilot-acceptance', actor: owner, outcome: 'accept', reason: 'Verified candidate' };
  const kinds = ['candidate_versions', 'independent_review', 'test_reports'];
  await assert.rejects(f.engine.decideNode({ ...gate, evidence: evidence(kinds, [{ artifactId: 'candidate', version: 'stale' }]) }), /current candidate/);
  await f.engine.decideNode({ ...gate, evidence: evidence(kinds, refs(artifacts.slice(0, 1))) });
  await f.engine.submitNode({ runId: run.id, nodeId: 'small-change-complete', actor: automatic });
  assert.equal((await f.engine.getRun(run.id)).status, 'completed');
});

test('unknown preflight conditions choose the standard Graph before dispatch', async t => {
  const f = await setup(t);
  const input = { ...f.start.input, pilot_scope: { ...f.start.input.pilot_scope, risks: {} } };
  const run = await f.engine.startRun({ ...f.start, input, admission: { outcome: 'eligible' } });
  assert.equal(run.graph.id, 'implementation');
  assert.equal(run.admission.outcome, 'standard');
  assert.deepEqual((await f.engine.getReadyNodes(run.id)).map(node => node.id), ['classify-implementation']);
  assert.equal(Object.keys((await f.store.read()).runs).length, 1);
});

for (const scenario of ['out-of-scope diff', 'extra edits in an allowed file', 'multiple commits', 'failed check',
  'unavailable checkout', 'removed pilot configuration', 'reviewer produced the candidate',
  'missing candidate version', 'missing report version', 'missing candidate identity and version']) {
  test(`${scenario} preserves the fast attempt and routes exactly once to standard implementation`, async t => {
    const f = await setup(t);
    const source = await f.engine.startRun(f.start);
    await f.engine.submitNode(await f.step(source, 'verify-scope', planner, [{ kind: 'scope_record', id: 'scope', version: '1' }]));
    const artifacts = await f.candidate({ extra: scenario === 'out-of-scope diff',
      wrong: scenario === 'extra edits in an allowed file', multiple: scenario === 'multiple commits' });
    if (scenario.startsWith('missing candidate')) delete artifacts[0].version;
    if (scenario === 'missing candidate identity and version') delete artifacts[0].id;
    if (scenario === 'missing report version') delete artifacts[1].version;
    if (scenario === 'failed check') f.failCheck();
    if (scenario === 'unavailable checkout') f.unavailable();
    const author = scenario === 'reviewer produced the candidate' ? { ...reviewer, roles: [...reviewer.roles, 'lead-engineer'] } : producer;
    const request = { ...await f.step(source, 'change-and-check', author, artifacts), evidence: [{ kind: 'observation', id: 'submission' }] };
    const host = scenario === 'removed pilot configuration' ? f.coldEngine : f.engine;
    const claims = { submissionReview: { outcome: 'eligible', evidenceRef: 'untrusted' } };
    const results = await Promise.all([host.submitNode({ ...request, ...claims }), host.submitNode(request)]);
    const route = results[0].standardRoute;
    assert.deepEqual(route, results[1].standardRoute);
    const runs = (await f.store.read()).runs;
    assert.equal(Object.keys(runs).length, 2);
    const stopped = runs[source.id];
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.nodeStates['change-and-check'].attempts.length, 1);
    const [attempt] = stopped.nodeStates['change-and-check'].attempts;
    assert.deepEqual(attempt.artifacts, artifacts);
    assert.deepEqual(attempt.evidence, request.evidence);
    assert.equal(attempt.supervisorReview, null);
    if (scenario.startsWith('missing ')) {
      assert.deepEqual(stopped.nodeStates['change-and-check'].artifacts, []);
      assert.deepEqual(standardArtifacts(runs[route.targetRunId]), []);
    }
    if (scenario === 'out-of-scope diff') {
      assert.ok(route.diff.some(item => item.path === 'auth.txt'));
      assert.equal(f.checks(), 0, 'out-of-scope candidates must not execute checks');
    }
    if (scenario === 'extra edits in an allowed file') {
      assert.match(route.reason, /approved requirement/);
      assert.equal(f.checks(), 0);
    }
    if (scenario === 'failed check') {
      assert.ok(route.diff.some(item => item.path === 'README.md'));
      assert.ok(route.scopeEvidenceRef);
      assert.ok(f.checks() >= 1);
    }
    if (scenario === 'multiple commits') assert.equal(f.checks(), 0);
    if (scenario === 'reviewer produced the candidate') assert.match(route.reason, /reviewer produced/);
    const standard = runs[route.targetRunId];
    assert.equal(standard.graph.id, 'implementation');
    assert.equal(standard.admission.sourceRunId, source.id);
    assert.equal(standard.parentRunId, source.id);
    assert.equal(standard.deliveryKey, source.deliveryKey);
    assert.deepEqual((await f.engine.getReadyNodes(standard.id)).map(node => node.id), ['classify-implementation']);
    await assert.rejects(f.engine.recordSelfReview({ ...request, artifactVersion: artifacts[0].version }), /awaiting self review/);
  });
}

function standardArtifacts(run) {
  return Object.values(run.nodeStates).flatMap(node => node.artifacts ?? []);
}

test('ordinary submissions and eligible pilot submissions still require artifact identity and version', async t => {
  const f = await setup(t);
  const run = await f.engine.startRun(f.start);
  const scope = await f.step(run, 'verify-scope', planner, [{ kind: 'scope_record', id: 'scope' }]);
  await assert.rejects(f.engine.submitNode(scope), /artifact.version/);
  await f.engine.submitNode({ ...scope, artifacts: [{ kind: 'scope_record', id: 'scope', version: '1' }] });
  const artifacts = await f.candidate();
  delete artifacts[0].id;
  await assert.rejects(f.engine.submitNode(await f.step(run, 'change-and-check', producer, artifacts)), /artifact.id/);
  assert.equal((await f.engine.getRun(run.id)).status, 'running');
});

test('a superseded approval stops the pilot and keeps the submitted attempt for the owner', async t => {
  const f = await setup(t);
  const source = await f.engine.startRun(f.start);
  await f.engine.submitNode(await f.step(source, 'verify-scope', planner, [{ kind: 'scope_record', id: 'scope', version: '1' }]));
  const artifacts = await f.candidate();
  const request = await f.step(source, 'change-and-check', producer, artifacts);
  await f.raw.recordProductDecision({ feature: 'docs', actor: owner, status: 'approved',
    outcome: 'Revise the approved documentation scope', reason: 'Scope changed after dispatch',
    evidence: [{ kind: 'requirement', id: 'DOC-2' }], supersedes: f.start.input.pilot_scope.approvalId });
  const result = await f.engine.submitNode(request);
  assert.match(result.standardRoute.reason, /no longer active/);
  assert.match(result.standardRoute.blockedReason, /not approved and active/);
  assert.equal(result.standardRoute.targetRunId, null);
  assert.deepEqual(result.attempts[0].artifacts, artifacts);
  assert.equal((await f.engine.getRun(source.id)).status, 'stopped');
});
