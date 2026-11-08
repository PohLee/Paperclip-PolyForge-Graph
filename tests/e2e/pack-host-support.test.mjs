import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphEngine, MemoryStore, runValidationDigest } from '../../src/core/index.mjs';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';
import { createPackHostAdapterRegistry, governedPackGraph } from '../../src/plugin/pack-host-support.mjs';
import { trustedPackAdapters, adapterBundleDigest, adapterBuildMode } from '../../src/plugin/trusted-pack-adapters.mjs';
import { createCreativeHostServices } from '../../src/plugin/creative-host-services.mjs';
import { createPackRuntimeRecovery } from '../../src/plugin/pack-runtime-recovery.mjs';
import { pack as installedAdlc } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';
import { pack as installedCreative } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/index.mjs';

const legacy = { id: 'legacy', version: '1', graphs: [{ id: 'ordinary', nodes: [{ id: 'task', type: 'task' }] }] };
const creative = { id: 'creative-team', version: '1', runtimeRequirements: {
  trustedHostServices: ['artifactRootForRun'], artifactValidation: 'createCreativeHostApi required',
}, graphs: [{ id: 'design', nodes: [{ id: 'design', type: 'task' }] }] };
const runtimeStore = () => {
  const records = new Map();
  const validations = new Map();
  return { get: async (company, run) => records.get(`${company}:${run}`) ?? null,
    record: async (company, run, identity) => {
      const key = `${company}:${run}`, prior = records.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(identity)) throw new Error('Pinned host adapter identity changed for run');
      records.set(key, identity); return identity;
    }, forget: (company, run) => records.delete(`${company}:${run}`),
    getLatestValidation: async (company, run) => validations.get(`${company}:${run}`) ?? null,
    setLatestValidation: (company, run, validation) => validations.set(`${company}:${run}`, validation) };
};
const registry = (adapters = trustedPackAdapters, store = runtimeStore()) => createPackHostAdapterRegistry({
  trustedAdapters: adapters, adapterBundleDigest, runtimeStore: store, runValidationDigest, systemActorId: 'test.graph',
});

test('host adapter registry preserves legacy paths and rejects counterfeit declared contracts', async () => {
  const host = registry();
  assert.equal(governedPackGraph(legacy, 'ordinary'), false);
  assert.equal(host.statusPack(legacy).available, true);
  assert.equal(host.statusPack(creative).available, false);

  const counterfeit = { id: 'adlc', version: installedAdlc.version,
    productMethodContracts: [{ artifactKind: 'request_brief', validator: 'fake' }],
    graphs: [{ id: 'request-triage', nodes: [{ id: 'task', type: 'task', produces: ['request_brief'] }] }] };
  const malicious = { ...counterfeit, hostAdapter: { supported: true } };
  assert.equal(host.resolve(counterfeit), null);
  assert.equal(host.resolve(malicious), null);

  let writes = 0;
  const oldRun = { id: 'old-adlc', packId: 'adlc', packVersion: installedAdlc.version, pack: counterfeit,
    graph: counterfeit.graphs[0], nodeStates: {} };
  const legacyRun = { id: 'legacy-run', packId: 'legacy', packVersion: '1', pack: legacy, graph: legacy.graphs[0] };
  const engine = { async getRun(id) { return id === oldRun.id ? oldRun : id === legacyRun.id ? legacyRun : null; },
    async submitNode() { writes++; }, async decideNode() { writes++; }, async resolveHumanGate() { writes++; },
    async recordSelfReview() { writes++; }, async recordWorkDecision() { writes++; },
    async recordProductDecision() { writes++; },
    async startRun() { writes++; }, async getReadyNodes() { return ['task']; }, async getWorkItems() { return [{ nodeId: 'task' }]; } };
  const guarded = host.withEngine(engine, 'co', [counterfeit, legacy]);
  for (const method of ['submitNode', 'decideNode', 'resolveHumanGate', 'recordSelfReview']) {
    await assert.rejects(guarded[method]({ runId: oldRun.id }), /Unsupported Pack host contract/);
  }
  await assert.rejects(guarded.recordProductDecision({ runId: oldRun.id }), /Unsupported Pack host contract/);
  assert.deepEqual(await guarded.getReadyNodes(oldRun.id), []);
  assert.deepEqual(await guarded.getWorkItems(oldRun.id), []);
  assert.equal((await host.runStatus(guarded, 'co', oldRun)).available, false);
  await guarded.startRun({ packId: 'legacy', packVersion: '1', graphId: 'ordinary' });
  await guarded.submitNode({ runId: legacyRun.id });
  assert.equal(writes, 2);
});

test('installed ADLC adapter validates output before real Core mutation and pins its exact release', async () => {
  assert.equal(adapterBuildMode, 'source-test', 'source tests use the local Pack module; production bundles embed the serializable release snapshot');
  const store = runtimeStore();
  const adapters = registry(trustedPackAdapters, store);
  assert.ok(adapters.resolve(installedAdlc));
  const coreStore = new MemoryStore();
  const engine = new GraphEngine({ store: coreStore });
  await engine.registerPack(installedAdlc);
  const guarded = adapters.withEngine(engine, 'company-1', [installedAdlc]);
  const actor = { id: 'paperclip-user', kind: 'human', roles: ['human-owner', 'cpo', 'product-owner'], executionId: null };
  const run = await guarded.startRun({ packId: installedAdlc.id, packVersion: installedAdlc.version,
    graphId: 'request-triage', mode: 'manual', actor, input: { source_request: { artifactId: 'request-1', version: '1' } } });
  assert.equal((await store.get('company-1', run.id)).packDigest, adapters.resolve(installedAdlc).identity.packDigest);
  const before = await coreStore.read();
  const beforeRun = await engine.getRun(run.id);
  const bad = { id: 'brief-1', version: '1', literalAsk: 'Please add a setting' };
  await assert.rejects(guarded.submitNode({ runId: run.id, nodeId: 'assess-request', actor,
    output: { triage_report: 'Ready' }, artifacts: [{ kind: 'request_brief', id: bad.id, version: bad.version }],
    payloads: { request_brief: bad } }), /sourceRef is required/);
  assert.equal((await coreStore.read()).revision, before.revision);
  await assert.rejects(guarded.submitNode({ runId: run.id, nodeId: 'assess-request', actor,
    output: { triage_report: 'Ready' }, artifacts: [{ kind: 'request_brief', id: bad.id, version: bad.version }],
    payloads: { request_brief: { ...bad, sourceRef: 'issue:1', underlyingProblem: 'unclear', affectedUser: 'user',
      desiredOutcome: 'setting', acceptanceBoundary: 'one setting', owner: 'cpo', mustHaves: [], hardConstraints: [],
      exclusions: [], unknowns: [], problemStatus: 'reported' } } }), /(input|Output|contract|source request|Decision Records)/i);
  assert.deepEqual(await engine.getRun(run.id), beforeRun);
  assert.equal((await coreStore.read()).revision, before.revision);
});

test('installed ADLC facade completes a reviewed experiment through revised payload, native gate, and automatic end', async () => {
  const store = runtimeStore();
  const adapters = registry(trustedPackAdapters, store);
  const coreStore = new MemoryStore();
  const engine = new GraphEngine({ store: coreStore });
  await engine.registerPack(installedAdlc);
  const guarded = adapters.withEngine(engine, 'company-lifecycle', [installedAdlc]);
  const feature = 'facade-lifecycle';
  const owner = { id: 'board-user', kind: 'human', roles: ['human-owner', 'cpo'], executionId: null };
  const baseline = await guarded.recordProductDecision({ feature, actor: owner, status: 'approved',
    outcome: 'Test baseline', reason: 'Start the facade lifecycle fixture', evidence: [{ kind: 'requirement', id: 'REQ-1' }] });
  const run = await guarded.startRun({ packId: installedAdlc.id, packVersion: installedAdlc.version,
    graphId: 'product-experiment', mode: 'autonomous', actor: owner,
    input: { feature, accepted_intent: { id: 'intent-1', version: '1' },
      versioned_requirement: { id: 'REQ-1', version: '1' }, product_decision_refs: [baseline.id] } });

  async function finishTask(node, payloads = {}) {
    const worker = { id: `agent-${node.id}`, kind: 'agent', roles: [node.role], executionId: `exec-${node.id}` };
    const artifacts = (node.produces ?? []).map(kind => ({ id: payloads[kind]?.id ?? `${node.id}-${kind}`,
      version: payloads[kind]?.version ?? '1', kind }));
    const workDecision = await guarded.recordWorkDecision({ runId: run.id, nodeId: node.id, actor: worker,
      category: 'process', question: `Which procedure applies to ${node.id}?`,
      options: [{ id: 'pinned-node', label: 'Follow the pinned node' }], outcome: 'pinned-node',
      reason: 'The pinned Graph defines this fixture step.', ruleRef: `node:${node.id}`, behaviorImpact: 'none',
      productDecisionRefs: run.input.product_decision_refs,
      evidence: [{ kind: 'requirement', summary: 'Versioned fixture requirement',
        sourceRef: { kind: 'run_input', key: 'versioned_requirement' } }] });
    await guarded.submitNode({ runId: run.id, nodeId: node.id, actor: worker, artifacts, payloads,
      output: { result: node.id }, decisionIds: [workDecision.id], productDecisionRefs: run.input.product_decision_refs });
    if (!node.review) return;
    if (node.id === 'assess-probe') {
      await guarded.recordSelfReview({ runId: run.id, nodeId: node.id, actor: worker, artifactVersion: '1',
        findings: [{ severity: 'P1', status: 'open' }] });
      const prior = payloads.experiment_record;
      const revised = { ...prior, version: '2', evidenceType: 'direct-user',
        observationRef: 'user-session-1', observedResult: 'Participants completed the task' };
      await guarded.recordSelfReview({ runId: run.id, nodeId: node.id, actor: worker, artifactVersion: '2', findings: [],
        revisedArtifact: { kind: 'experiment_record', id: prior.id, version: '2' }, revisedPayload: revised });
    } else {
      await guarded.recordSelfReview({ runId: run.id, nodeId: node.id, actor: worker,
        artifactVersion: artifacts.at(-1).version, findings: [] });
    }
    const reviewRule = installedAdlc.decisionRules.find(item => item.type === node.review.decisionType && item.mode === 'autonomous');
    const reviewArtifacts = node.id === 'assess-probe' ? artifacts.map(item => item.kind === 'experiment_record'
      ? { ...item, version: '2' } : item) : artifacts;
    await guarded.reviewWork({ runId: run.id, nodeId: node.id,
      actor: { id: `reviewer-${node.id}`, kind: 'agent', roles: [node.review.supervisorRole], executionId: `review-${node.id}` },
      outcome: 'accept', reason: 'Independent supervisor accepted the fixture artifact.',
      evidence: (reviewRule?.requiredEvidence ?? []).map(kind => ({ kind,
        subjectRefs: reviewArtifacts.map(item => ({ artifactId: item.id, version: item.version })) })) });
  }

  await assert.rejects(guarded.submitNode({ runId: run.id, nodeId: 'plan-probe',
    actor: { id: 'spoof', kind: 'system', roles: [], executionId: null } }), /Authenticated host system actor/);
  let pending = (await guarded.getReadyNodes(run.id))[0];
  await finishTask(pending);
  pending = (await guarded.getReadyNodes(run.id))[0];
  await finishTask(pending);
  pending = (await guarded.getReadyNodes(run.id))[0];
  assert.equal(pending.id, 'assess-probe');
  const experiment = { id: 'experiment-1', version: '1', hypothesis: 'Operators use the shortcut',
    targetUser: 'Operators', riskyAssumption: 'The shortcut is discoverable', probe: 'Observed usability session',
    supportCriterion: 'Most participants complete the task', refuteCriterion: 'Participants cannot find it',
    evidenceType: 'technical-feasibility', decisionOwner: 'cpo', state: 'supported',
    executedAt: '2026-11-08T00:00:00Z', observationRef: 'technical-probe-1',
    observedResult: 'A technical proof of concept works', recommendedNext: 'build' };
  await finishTask(pending, { experiment_record: experiment, evidence_ledger: { id: 'ledger-1', version: '1', claims: [] } });
  const readyGate = (await guarded.getReadyNodes(run.id))[0];
  assert.equal(readyGate.id, 'experiment-gate');
  await assert.rejects(guarded.submitNode({ runId: run.id, nodeId: 'experiment-gate',
    actor: { id: 'test.graph', kind: 'system', roles: [], executionId: null } }), /Host system actor is limited/);
  const current = await guarded.getRun(run.id);
  const currentRecord = current.nodeStates['assess-probe'].output.adlcProductMethods.experiment_record;
  assert.equal(currentRecord.version, '2');
  await guarded.decideNode({ runId: run.id, nodeId: 'experiment-gate', actor: owner, outcome: 'human',
    reason: 'Request a native human decision' });
  const evidence = [{ kind: 'experiment_record', subjectRefs: [{ artifactId: currentRecord.id, version: currentRecord.version }] },
    { kind: 'evidence_ledger', subjectRefs: [{ artifactId: currentRecord.id, version: currentRecord.version }] }];
  await guarded.resolveHumanGate({ runId: run.id, nodeId: 'experiment-gate', actor: owner, outcome: 'build',
    reason: 'The revised record has direct user evidence', evidence });
  const automatic = (await guarded.getWorkItems(run.id))[0];
  assert.equal(automatic.nodeId, 'experiment-build');
  await guarded.submitNode({ runId: run.id, nodeId: automatic.nodeId,
    actor: { id: 'test.graph', kind: 'system', roles: [], executionId: null },
    output: { automatedTransition: true }, idempotencyKey: `auto:${run.id}` });
  assert.equal((await guarded.getRun(run.id)).status, 'completed');
  assert.equal((await adapters.runStatus(guarded, 'company-lifecycle', await guarded.getRun(run.id))).available, true);

  const priorRun = await engine.getRun(run.id);
  const beforeRecoveryDecisions = await engine.listDecisions({ runId: run.id });
  store.forget('company-lifecycle', run.id);
  const lostBinding = await adapters.runStatus(guarded, 'company-lifecycle', priorRun);
  assert.equal(lostBinding.available, false);
  assert.equal(lostBinding.recoverable, true);
  let validationRevision = 0;
  const recovery = createPackRuntimeRecovery({
    readSnapshot: () => coreStore.read(),
    resolveOwner: async ({ claimedActor }) => claimedActor,
    resolveValidator: async pinnedRun => {
      const resolution = adapters.resolve(pinnedRun.pack);
      const api = resolution.descriptor.createHostApi({ engine, runValidationDigest,
        resolveActor: async () => { throw new Error('Read-only recovery validation must not resolve a mutation actor'); } });
      return { identity: resolution.identity, validateRun: api.validateRun.bind(api) };
    },
    finalizeValidation: async fields => {
      const state = await coreStore.read();
      if (state.revision !== fields.expectedStateRevision) return { committed: false };
      const token = `fixture-validation-${++validationRevision}`;
      if (fields.validation.status === 'valid') await store.record(fields.companyId, fields.runId, fields.identity);
      state.runs[fields.runId].hostValidationId = token;
      state.revision += 1;
      await coreStore.write(state, fields.expectedStateRevision);
      store.setLatestValidation(fields.companyId, fields.runId, { status: fields.validation.status,
        valid: fields.validation.status === 'valid', validationToken: token, issues: fields.validation.issues });
      return { committed: true, validationRevision, validationToken: token,
        newStateRevision: state.revision, previousIdentity: null };
    },
  });
  const recovered = await recovery.revalidate({ companyId: 'company-lifecycle', runId: run.id, actor: owner,
    reason: 'Restore the exact trusted validator binding after the sidecar record was lost.' });
  assert.equal(recovered.valid, true, JSON.stringify(recovered.issues));
  const afterRecoveryRun = await engine.getRun(run.id);
  const { hostValidationId: _validationId, ...afterRecoveryHistory } = afterRecoveryRun;
  assert.deepEqual(afterRecoveryHistory, priorRun, 'revalidation changes only the recovery token, not run history');
  assert.deepEqual(await engine.listDecisions({ runId: run.id }), beforeRecoveryDecisions);
  const restartedRegistry = registry(trustedPackAdapters, store);
  const restartedEngine = restartedRegistry.withEngine(engine, 'company-lifecycle', [installedAdlc]);
  const recoveredStatus = await restartedRegistry.runStatus(restartedEngine, 'company-lifecycle', afterRecoveryRun);
  assert.equal(recoveredStatus.available, true, 'a restart with the recovered exact identity accepts the validated legacy run');
});

test('installed Creative adapter completes a supported intake path through the configured HTTP host and real Core facade', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polyforge-creative-facade-'));
  const artifactRoot = join(root, 'paperclip-volume', 'creative-artifacts');
  let decisionRpcCalls = 0;
  const gateway = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    const result = request.url === '/v1/creative/capabilities'
      ? { protocol: 'polyforge-creative-host-v1', result: { services: ['resolveDecisionEvidence'], imageProviderIds: [], imageDecoder: false } }
      : request.url === '/v1/creative/evidence/resolve'
        ? (decisionRpcCalls++, { protocol: 'polyforge-creative-host-v1', companyId: input.companyId, result: input.requiredKinds.map(kind => ({
          kind, payload: { id: `evidence-${kind}`, version: '1', summary: 'Local fixture evidence' },
          sourceRef: { kind: 'creative_brief', id: 'brief-1', version: '1' },
        })) })
        : { protocol: 'polyforge-creative-host-v1', error: 'unknown endpoint' };
    response.writeHead(request.url === '/v1/creative/capabilities' || request.url === '/v1/creative/evidence/resolve' ? 200 : 404,
      { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => gateway.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
  await writeFile(join(root, 'polyforge.runtime.json'), JSON.stringify({ creativeHost: {
    artifactRoot, gatewayUrl, gatewayTokenEnv: 'POLYFORGE_CREATIVE_TEST_TOKEN', timeoutMs: 1000, allowedImageProviderIds: [],
  } }));
  const creativeServices = await createCreativeHostServices({ root, env: { POLYFORGE_CREATIVE_TEST_TOKEN: 'fixture-token' } });
  assert.equal(creativeServices.available, true);
  let latestValidation = null;
  const runtimeBindings = runtimeStore();
  runtimeBindings.getLatestValidation = async () => latestValidation;
  const creativeRegistry = createPackHostAdapterRegistry({
    trustedAdapters: trustedPackAdapters, adapterBundleDigest, runtimeStore: runtimeBindings, runValidationDigest,
    systemActorId: 'test.graph', hostServices: creativeServices,
  });
  const engine = new GraphEngine();
  await engine.registerPack(installedCreative);
  const guarded = creativeRegistry.withEngine(engine, 'creative-company', [installedCreative]);
  const owner = { id: 'creative-owner', kind: 'human', roles: ['human-owner', 'head-of-design'], executionId: null };
  const run = await guarded.startRun({ packId: installedCreative.id, packVersion: installedCreative.version,
    graphId: 'creative-intake', mode: 'manual', actor: owner, input: { brief: 'Create a landing page for a new product.' } });
  const payloads = [
    { kind: 'context_inventory', payload: { id: 'context-1', version: '1', summary: 'Available project context', sources: [{ kind: 'run_input', key: 'brief' }] } },
    { kind: 'clarification_record', payload: { id: 'questions-1', version: '1', questions: [], knownAnswers: [] } },
    { kind: 'creative_brief', payload: { id: 'brief-1', version: '1', objective: 'Explain the product', audience: 'New customers', surfaceMode: 'persuade' } },
  ];
  for (const [index, nodeId] of ['read-context', 'clarify-brief', 'synthesize-brief'].entries()) {
    const { kind, payload } = payloads[index];
    const role = installedCreative.graphs.find(item => item.id === 'creative-intake').nodes.find(item => item.id === nodeId).role;
    await guarded.submitNode({ runId: run.id, nodeId, actor: {
      id: `creative-agent-${index}`, kind: 'agent', roles: [role],
      executionId: `creative-exec-${index}`,
    }, output: { [kind]: payload }, artifacts: [{ kind, id: payload.id, version: payload.version }], payloads: { [kind]: payload } });
  }
  const beforeDecision = await guarded.getRun(run.id);
  assert.equal(beforeDecision.nodeStates['synthesize-brief'].status, 'completed');
  await guarded.decideNode({ runId: run.id, nodeId: 'route-work', actor: owner, outcome: 'human', reason: 'Request the native creative route decision' });
  const current = await guarded.getRun(run.id);
  const brief = current.nodeStates['synthesize-brief'].output.creativeArtifacts.creative_brief;
  await guarded.resolveHumanGate({ runId: run.id, nodeId: 'route-work', actor: owner, outcome: 'brief-ready',
    reason: 'The brief is sufficiently clear to proceed.', evidence: [{ kind: 'creative_brief', payload: brief,
      sourceRef: { kind: 'creative_brief', id: brief.id, version: brief.version } }] });
  const endWork = (await guarded.getWorkItems(run.id))[0];
  assert.equal(endWork.nodeId, 'brief-ready');
  await guarded.submitNode({ runId: run.id, nodeId: endWork.nodeId,
    actor: { id: 'test.graph', kind: 'system', roles: [], executionId: null },
    output: { automatedTransition: true }, idempotencyKey: `auto:${run.id}` });
  const status = await creativeRegistry.runStatus(guarded, 'creative-company', await guarded.getRun(run.id));
  assert.equal(status.available, true);
  assert.equal(decisionRpcCalls, 2, 'the initial gate claim and native human decision both used configured tenant-scoped evidence');
  assert.equal((await guarded.getRun(run.id)).status, 'completed');
  latestValidation = { status: 'invalid', valid: false, issues: [{ code: 'fixture-invalid', message: 'Fixture recovery rejection' }] };
  const blocked = await creativeRegistry.runStatus(guarded, 'creative-company', await guarded.getRun(run.id));
  assert.equal(blocked.available, false, 'a latest invalid recovery audit blocks an otherwise matching pinned adapter');
  assert.match(blocked.reason, /Latest host revalidation is invalid/);
});

test('run without a pinned Pack snapshot fails closed, while ordinary legacy run remains supported', async () => {
  const host = registry();
  const missing = { id: 'run-missing-pack', packId: 'adlc', packVersion: installedAdlc.version,
    graph: installedAdlc.graphs.find(item => item.id === 'request-triage') };
  assert.equal((await host.runStatus({}, 'company-1', missing)).available, false);
});

test('start-plan-item rejects unavailable trusted wrapper before creating issue or run', async () => {
  const plan = { id: 'plan-1', projectId: 'project-1' };
  const fakePack = { id: 'adlc', version: installedAdlc.version, graphs: [
    { id: 'request-triage', nodes: [{ id: 'assess', type: 'task', produces: ['request_brief'] }] },
  ], productMethodContracts: [{ artifactKind: 'request_brief' }] };
  let issuesCreated = 0, runsStarted = 0;
  const control = { getWorkPlanItemContext: async () => ({ plan,
    item: { id: 'item-1', packId: fakePack.id, packVersion: fakePack.version, graphId: 'request-triage', input: {} }, run: null }) };
  const host = { db: { namespace: 'plugin_test', query: async () => [] }, manifest: { id: 'test.graph' },
    projects: { get: async () => ({ id: 'project-1' }) },
    issues: { list: async () => [], create: async () => { issuesCreated++; return { id: 'issue-1' }; } } };
  const packHostAdapters = registry();
  const engine = packHostAdapters.withEngine({ async startRun() { runsStarted++; } }, 'company-1', [fakePack]);
  const api = createCompanyApi({ host, catalog: () => [fakePack], engineFor: async () => ({ engine, control }), packHostAdapters,
    getConfig: async () => ({ defaultMode: 'manual', roleBindings: {} }),
    trustedActor: async () => ({ actor: { id: 'owner', kind: 'human', roles: ['human-owner'], executionId: null }, isAdministrator: true }),
    capabilitiesFor: async () => ({}) });
  await assert.rejects(api.command({ companyId: 'company-1', hostActor: { userId: 'owner' }, body: {
    operation: 'start-plan-item', planId: plan.id, itemId: 'item-1', reason: 'Start planned work', idempotencyKey: 'start-1',
  } }), /Unsupported Pack host contract/);
  assert.equal(issuesCreated, 0);
  assert.equal(runsStarted, 0);
});
