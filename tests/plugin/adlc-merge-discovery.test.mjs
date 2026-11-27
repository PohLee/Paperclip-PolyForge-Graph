import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import { fileURLToPath } from 'node:url';
import { pack as adlc } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';
import { pack as creative } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/index.mjs';
import { canonical } from '../../src/core/canonical.mjs';
import { GraphEngine, MemoryStore, runValidationDigest } from '../../src/core/index.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import { PaperclipStore, advanceMergeDiscovery, getPackRuntime, listMergeRequests, recordPackRuntime,
  rejectSupersededMergeRequests, saveMergeRequest, setGraphConfig } from '../../src/plugin/store.mjs';
import { createAdlcContractPublication } from '../../src/plugin/adlc-contract-publication.mjs';
import { githubHostTransportReadiness } from '../../src/plugin/github-http-transport.mjs';
import { advanced, approvalBody, approvalTime, app, attestation, authoredProposal, merge, publicationGitHub, repositoryId, root, versions } from '../helpers/g2-publication-fixture.mjs';
import { discoverAdlcMerges } from '../../src/plugin/adlc-merge-discovery.mjs';
import { createPackHostAdapterRegistry } from '../../src/plugin/pack-host-support.mjs';
import { finalizePackRuntimeValidation, getLatestPackRuntimeValidation } from '../../src/plugin/pack-runtime-recovery-store.mjs';
import { adapterBundleDigest, mergeProducers, trustedPackAdapters } from '../../src/plugin/trusted-pack-adapters.mjs';
import plugin from '../../src/plugin/worker.mjs';
import { createPostgresShadowDatabase, postgresShadowAvailable } from '../helpers/postgres-shadow.mjs';
import { validatePluginRuntimeExecute, validatePluginRuntimeQuery } from '../helpers/paperclip-sql-validator.mjs';

const manifestRef = candidate => ({ id: candidate.id, revisionId: candidate.version });
const subject = candidate => ({ artifactId: candidate.id, version: candidate.version });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const agent = role => ({ id: role, executionId: role + '-session', kind: 'agent', roles: [role] });
const owner = { id: 'owner', kind: 'human', executionId: null, roles: ['human-owner'] };
const project = { id: 'project', ownerId: owner.id, repository: 'example/app' };
const pins = [{ section: 'product', contractId: 'P1', commit: '1'.repeat(40) },
  { section: 'technical', contractId: 'T1', commit: '2'.repeat(40) }];
const pr = { id: 'pr:example/app#10', version: 'a'.repeat(40), repository: 'example/app', pullNumber: 10, headSha: 'a'.repeat(40) };
const envelope = (kind, payload) => ({ kind, id: payload.id, version: payload.version });

function approvalManifestBody() {
  const deliverables = ['prd', 'acceptance.feature'].map(key => ({ key, revisionId: key + '-revision', digest: 'a'.repeat(64) }));
  return { supersedes: null, deliverables, egmReportRef: 'egm', assumptions: [], unresolvedEscalations: [] };
}

async function migratedHost(t) {
  const { db, sql, namespace, companyId, otherCompanyId, independentDatabase } = await createPostgresShadowDatabase(t, { full: true });
  const jobs = new Map(), warnings = [], snapshotReads = [];
  let interrupt = null;
  const observedDb = { namespace,
    async query(statement, args) {
      if (statement.includes('SELECT revision, document')) snapshotReads.push(args[0]);
      return db.query(statement, args);
    },
    async execute(statement, args) {
      if (interrupt && statement.includes(interrupt.table) && args[0] === interrupt.companyId) {
        interrupt = null;
        throw new Error('Simulated worker interruption (Bearer private-worker-token)');
      }
      return db.execute(statement, args);
    },
  };
  const config = { adlcProjects: { project } };
  const host = {
    manifest, db: observedDb, config: { get: async () => config },
    access: { members: { list: async () => [{ principalType: 'user', principalId: owner.id, status: 'active', membershipRole: 'admin' }] } },
    issues: { get: async id => ({ id, projectId: project.id }), listInteractions: async () => [] },
    logger: { warn: (message, details) => warnings.push({ message, details }), info() {} },
    actions: { register() {} }, data: { register() {} }, tools: { register() {} }, events: { on() {} },
    jobs: { register: (name, job) => jobs.set(name, job) },
  };
  // Keep the worker catalog on the companion source at either point in the build lifecycle.
  const previous = process.env.POLYFORGE_PACKS_ENTRY;
  process.env.POLYFORGE_PACKS_ENTRY = fileURLToPath(new URL('../../../Paperclip-PolyForge-Graph-Packs/index.mjs', import.meta.url));
  t.after(() => {
    if (previous === undefined) delete process.env.POLYFORGE_PACKS_ENTRY;
    else process.env.POLYFORGE_PACKS_ENTRY = previous;
  });
  await plugin.definition.setup(host);
  assert.ok(manifest.jobs.some(job => job.jobKey === 'adlc-merge-discover' && job.schedule === '* * * * *'));
  const { resolve, runtimeBindingError } = createPackHostAdapterRegistry({ trustedAdapters: trustedPackAdapters, adapterBundleDigest,
    runValidationDigest, runtimeStore: {
      get: (companyId, runId) => getPackRuntime(db, companyId, runId),
      getLatestValidation: (companyId, runId) => getLatestPackRuntimeValidation(db, companyId, runId),
      record: (companyId, runId, identity) => recordPackRuntime(db, companyId, runId, identity),
    } });
  return { db, sql, namespace, host, config, companyId, otherCompanyId, warnings, snapshotReads,
    independentDatabase, resolve, runtimeBindingError, publishJob: () => jobs.get('adlc-contract-publish')(),
    discover: () => jobs.get('adlc-merge-discover')(),
    discoverWithoutAdapter: packId => discoverAdlcMerges({ host,
      resolveAdapter: pack => !packId || pack.id === packId ? null : resolve(pack), runtimeBindingError }),
    interrupt: (table, companyId) => { interrupt = { table, companyId }; } };
}

function fixtureIdentity({ descriptor }) {
  const { packId, packVersion, packDigest, adapterId, adapterVersion } = descriptor;
  return { packId, packVersion, packDigest, adapterId, adapterVersion, adapterBundleDigest };
}

async function bindRuntime(db, companyId, fixture) {
  await recordPackRuntime(db, companyId, fixture.run.id, fixtureIdentity(fixture));
}

async function editSnapshot(store, transform) {
  const state = await store.read() ?? { revision: 0, runs: {}, packs: {}, decisions: [], idempotency: {}, audit: [] };
  const revision = state.revision;
  transform(state);
  state.revision++;
  await store.write(state, revision);
}

function completed(namespace, artifacts, outcome = null) {
  const refs = Object.entries(artifacts).map(([kind, value]) => envelope(kind, value));
  return { status: 'completed', outcome, artifacts: refs, attempts: [{ artifacts: refs, output: { [namespace]: artifacts } }] };
}

async function readyGate(db, companyId, row, { id = row.gateNodeId, graphVersion = row.versions.at(-1), missing = false,
  preparing = false, document, supersedes = null, productBody, now, contractPins, graphStore } = {}) {
  const pack = row.packId === 'adlc' ? adlc : creative;
  const descriptor = trustedPackAdapters.find(adapter => adapter.packId === pack.id);
  const graph = pack.graphs.find(graph => graph.id === row.graphId && graph.version === graphVersion);
  const store = graphStore ?? new PaperclipStore(db, companyId);
  const engine = new GraphEngine({ store, mergeProducers, candidatePayload: descriptor.candidatePayload, now });
  const namespace = pack.id === adlc.id ? 'adlcProductMethods' : 'creativeArtifacts';
  const input = { paperclipCompanyId: companyId, paperclipIssueId: document?.issueId ?? randomUUID(), projectId: project.id };
  const run = { id, pack, packId: pack.id, packVersion: pack.version, graph, input, mode: 'manual', status: 'running',
    conflicts: [], nodeStates: Object.fromEntries(graph.nodes.map(node => [node.id,
      ['end'].includes(node.type) || [row.nodeId, row.gateNodeId].includes(node.id)
        ? { status: 'pending', artifacts: [], attempts: [] } : completed(namespace, {})])) };
  const candidate = { id: document?.id ?? 'manifest-' + id, version: document?.latestRevisionId ?? '1' };
  let audit;
  if (row.section === 'product') {
    input.requirements_draft = 'draft';
    input.readiness_report = 'reviewed';
    const body = productBody ?? approvalManifestBody();
    if (productBody) input.backlogItemRef = 'BACKLOG-7';
    const { deliverables } = body;
    Object.assign(candidate, body, { supersedes });
    if (supersedes) input.contract_pins = pins.slice(0, 1);
    run.nodeStates['scope-route'].outcome = 'small';
    run.nodeStates['challenge-requirements'] = completed(namespace, { egm_report: { id: 'egm', version: '1', deliverables,
      scope: 'small', complianceRelevant: false, rounds: [{ reviewers: { 'naive-reader': 'ran', 'bdd-testability': 'ran' }, findings: [] }] } });
  } else if (row.section === 'technical') {
    input.contract_pins = pins.slice(0, 1);
    const deliverables = [{ key: 'design.md', revisionId: 'design-revision', digest: 'a'.repeat(64) }];
    Object.assign(candidate, { revisionId: candidate.version, deliverables });
    run.nodeStates['comprehension-review'] = completed(namespace, {
      implementation_egm: { id: 'technical-review', version: '1', deliverables, passed: true },
    });
    if (run.nodeStates['prd-route']) run.nodeStates['prd-route'].outcome = 'ready';
    run.nodeStates['egm-route'].outcome = 'pass';
  } else if (row.section === 'design') {
    const ref = { id: 'product-contract', version: '1' };
    Object.assign(input, { approved_product_contract: ref, design_baseline: ref });
    Object.assign(candidate, { systemScope: 'in-system', behaviorChanged: false, productContractRef: ref,
      interactionRef: ref, designBaselineRef: ref, assets: [{ ...ref, digest: 'b'.repeat(64) }], tokens: [], components: [],
      deliverables: [{ key: 'design.json', digest: 'b'.repeat(64) }] });
    audit = { id: 'audit-' + id, version: '1', manifestRef: refFor(candidate), manifestDigest: sha256(canonical(candidate)),
      behaviorChanged: false, findings: [] };
    run.nodeStates[row.auditNodeId] = completed(namespace, { [row.auditKind]: audit });
  } else {
    Object.assign(input, { contract_pins: pins, pr_head: pr, verification_scope: { id: 'scope', version: '1' } });
    run.nodeStates['modernize-route'].outcome = 'MODERNIZE';
    run.nodeStates['review-route'].outcome = 'pass';
    run.nodeStates['acceptance-gate'].outcome = 'accept';
    run.nodeStates['prepare-g5'] = preparing ? { status: 'pending', attempts: [], artifacts: [] } :
      completed(namespace, { merge_pr_head: pr, merge_context: { id: 'context', version: '1',
        riskLevel: 'low', neverAutoMerge: [], authorAgentId: null, evidenceComplete: true } });
  }
  run.nodeStates[row.candidateNodeId] = completed(namespace, { [row.candidateKind]: candidate });
  if (contractPins) run.contract_pins = input.contract_pins = contractPins;
  if (missing) delete run.nodeStates[row.candidateNodeId].attempts[0].output;
  await editSnapshot(store, snapshot => {
    snapshot.runs[id] = run;
    if (!contractPins) {
      for (const pin of input.contract_pins ?? []) snapshot.audit.push({ kind: 'contract.merged',
        projectId: project.id, contractId: pin.contractId, section: pin.section, mergeCommitSha: pin.commit });
    }
  });
  const evidence = graph.nodes.find(node => node.id === row.gateNodeId);
  const subjectRefs = [subject(candidate), ...(audit ? [subject(audit)] : row.section ? [] : [subject(pr)])];
  const api = descriptor.createHostApi({ engine, runValidationDigest, resolveActor: ({ claimedActor }) => claimedActor,
    services: { resolveDecisionEvidence: async () => [
      { kind: 'visual_manifest', payload: candidate, subjectRefs },
      { kind: 'visual_audit', payload: audit, subjectRefs },
    ] } });
  const args = { runId: id, nodeId: row.gateNodeId, actor: row.section === 'technical' ? agent('cto') : owner,
    outcome: row.section === 'design' ? 'approve' : 'accept', reason: 'Approve exact candidate',
    evidence: pack.decisionRules.find(rule => rule.type === evidence.decisionType && rule.mode === 'manual')
      .requiredEvidence.map(kind => ({ kind, subjectRefs })) };
  return { store, engine, run, row, descriptor, api, args, namespace, candidate, audit };
}

const refFor = ({ id, version }) => ({ id, version });

async function publish(f, decision, { completeRun = true, pullNumber = pr.pullNumber } = {}) {
  const { engine, run, row, api, candidate, audit } = f;
  const nodeId = row.nodeId;
  const node = run.graph.nodes.find(node => node.id === nodeId);
  const request = { id: 'request-' + run.id, version: '1', section: row.section, runId: run.id,
    decisionId: decision.id, manifest: manifestRef(candidate), ...(audit ? { audit: manifestRef(audit) } : {}),
    pullNumber, ...(row.section === 'design' ? {} : { contract_pins: run.input.contract_pins ?? [] }),
    ...(row.section ? {} : { repository: pr.repository, headSha: pr.headSha,
      riskLevel: 'low', neverAutoMerge: [], authorAgentId: null, evidenceComplete: true }) };
  const actor = agent(node.role);
  const payloads = { [row.kind]: request };
  let decisionIds = [];
  if (row.section === 'product') {
    payloads.requirements_handoff = { id: 'handoff', version: '1', acceptedIntent: { id: 'intent', version: '1' },
      acceptanceDecisionId: decision.id, scope: [], nonGoals: [], dependencies: [], outcomeMetric: [],
      requirements: [{ id: 'R1', problemRef: 'P1' }], status: 'accepted',
      acceptanceCriteria: [{ id: 'A1', description: 'Test R1', proof: 'BDD', requirementIds: ['R1'] }] };
  }
  if (node.decisionTraceRequired) {
    const work = await engine.recordWorkDecision({ runId: run.id, nodeId, actor, category: 'process',
      question: 'Publish approved baseline?', options: [{ id: 'publish', label: 'Publish' }], outcome: 'publish',
      ruleRef: 'node:' + nodeId, reason: 'Reviewed', evidence: [{ kind: 'approval', summary: 'Current G2 approval',
        sourceRef: { kind: 'decision', id: decision.id } }] });
    decisionIds = [work.id];
  }
  await api.submitNode({ runId: run.id, nodeId, actor, decisionIds, payloads,
    artifacts: Object.entries(payloads).map(([kind, value]) => envelope(kind, value)) });
  if (node.review) {
    await engine.recordSelfReview({ runId: run.id, nodeId, actor, artifactVersion: '1' });
    const current = await engine.getRun(run.id);
    await engine.reviewWork({ runId: run.id, nodeId, actor: { ...owner, roles: [...owner.roles, node.review.supervisorRole] }, outcome: 'accept',
      expectedRunDigest: runValidationDigest(current), reason: 'Reviewed',
      evidence: ['artifact_version', 'review_findings', 'self_review_history'].map(kind => ({
        kind, subjectRefs: Object.values(payloads).map(subject) })) });
  }
  if (completeRun) {
    const end = (await engine.getReadyNodes(run.id)).find(node => node.type === 'end');
    await api.submitNode({ runId: run.id, nodeId: end.id, actor: { id: manifest.id, kind: 'system', roles: [], executionId: null } });
    assert.equal((await engine.getRun(run.id)).status, 'completed');
  }
  return request;
}

async function approveEscalatedDesign({ api, args }) {
  const { decision } = await api.decideNode({ ...args, actor: agent('design-director'), outcome: 'human' });
  assert.equal(decision.candidateBinding, undefined);
  const result = await api.resolveHumanGate({ ...args, expectedDecisionId: decision.id });
  assert.equal(result.decision.supersedes, decision.id);
  return result;
}

function assertFrozen(decision, f) {
  const binding = decision.candidateBinding;
  const manifest = binding.candidates.find(ref => ref.kind === f.row.candidateKind);
  const bytes = Buffer.from(canonical(f.candidate));
  assert.deepEqual(manifest, { ...subject(f.candidate), kind: f.row.candidateKind,
    bytes: bytes.toString('base64'), digest: sha256(bytes) });
  if (!f.audit) assert.equal(binding.audit, null);
  else assert.equal(binding.audit.digest, sha256(canonical(f.audit)));
}

test('worker discovers the four governed producers through migrated PostgreSQL', {
  skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL',
}, async t => {
  const h = await migratedHost(t);
  const fixtures = [];
  for (const row of mergeProducers) {
    const f = await readyGate(h.db, h.companyId, row);
    await bindRuntime(h.db, h.companyId, f);
    // G5 deliberately starts with seeded inspection evidence, since PR inspection is disabled in PR-A.
    const gateApi = row.section ? f.api : f.engine;
    const { decision } = row.section === 'design'
      ? await approveEscalatedDesign(f)
      : await gateApi.decideNode(f.args);
    assertFrozen(decision, f);
    const request = await publish(f, decision);
    fixtures.push({ ...f, decision, request });
  }
  const other = await readyGate(h.db, h.otherCompanyId, mergeProducers[1], { graphVersion: '0.1.1' });
  await bindRuntime(h.db, h.otherCompanyId, other);
  const nodeId = other.row.candidateNodeId;
  const node = other.run.graph.nodes.find(node => node.id === nodeId);
  const producer = agent(node.role);
  await editSnapshot(other.store, snapshot => {
    const state = snapshot.runs[other.run.id].nodeStates[nodeId];
    state.status = 'awaiting_self_review';
    Object.assign(state.attempts[0], { actor: producer, selfReviews: [] });
  });
  other.candidate = { ...other.candidate, version: '2', revisionId: '2' };
  await other.api.recordSelfReview({ runId: other.run.id, nodeId, actor: producer, artifactVersion: '2',
    revisedArtifact: envelope(other.row.candidateKind, other.candidate), revisedPayload: other.candidate });
  await other.engine.reviewWork({ runId: other.run.id, nodeId, outcome: 'accept', reason: 'Reviewed revised manifest',
    actor: { ...owner, roles: [...owner.roles, node.review.supervisorRole] },
    evidence: ['artifact_version', 'review_findings', 'self_review_history'].map(kind => ({
      kind, subjectRefs: [subject(other.candidate)] })) });
  const otherArgs = { ...other.args, evidence: other.args.evidence.map(item => ({
    ...item, subjectRefs: [subject(other.candidate)],
  })) };
  const approved = await other.api.decideNode(otherArgs);
  assertFrozen(approved.decision, other);
  await publish(other, approved.decision);

  const [interruptedRunId, nextRunId] = Object.keys((await fixtures[0].store.read()).runs);
  h.interrupt('INSERT INTO ' + h.namespace + '.adlc_merge_requests', h.companyId);
  await h.discover();
  assert.equal(h.warnings.filter(row => row.message.includes('discovery failed')).length, 1);
  assert.equal((await listMergeRequests(h.db, h.companyId, interruptedRunId)).length, 0);
  assert.equal((await listMergeRequests(h.db, h.companyId, nextRunId))[0].disposition, 'admitted');
  assert.equal((await listMergeRequests(h.db, h.otherCompanyId, other.run.id))[0].disposition, 'admitted');
  assert.deepEqual(h.warnings[0].details, { companyId: h.companyId, runId: interruptedRunId,
    operation: 'save-request', error: { name: 'Error', code: null } });

  h.interrupt('UPDATE ' + h.namespace + '.adlc_merge_discovery SET last_revision', h.companyId);
  await h.discover();
  for (const { run, request, row } of fixtures) {
    const [stored] = await listMergeRequests(h.db, h.companyId, run.id);
    assert.equal(stored.disposition, 'admitted', JSON.stringify(stored));
    assert.equal(stored.request.payload.decisionId, request.decisionId);
    assert.equal(stored.kind, row.kind);
  }
  await h.discover();
  h.snapshotReads.length = 0;
  await h.discover();
  assert.deepEqual(h.snapshotReads, []);
  assert.equal((await listMergeRequests(h.db, h.companyId, fixtures[1].run.id)).length, 1);

  const selected = fixtures[0].run;
  const read = await plugin.definition.onApiRequest({ routeKey: 'graph-read', companyId: h.companyId,
    params: { issueId: selected.input.paperclipIssueId }, query: { runId: selected.id },
    actor: { actorType: 'user', userId: owner.id } });
  assert.equal(read.body.error, undefined);
  assert.equal(read.body.mergeRequests[0].disposition, 'admitted');

  const [g2, g4, g5, g3] = fixtures;
  const rejected = [
    ['foreign-project', g2, { projectId: 'other-project' }, 'project-binding-mismatch'],
    ['foreign-run', g2, { runId: g4.run.id }, 'request-scope-mismatch'],
    ['first-publication-with-pins', g2, { contract_pins: pins }, 'first-publication-has-pins'],
    ['foreign-decision', g3, { decisionId: g2.decision.id }, 'missing-current-approval'],
    ['legacy-verification', g5, {}, null],
    ['unlisted-node', g2, {}, null],
    ['untrusted-pack', g2, {}, 'untrusted-pack-snapshot'],
    ['no-wrapper-output', g2, {}, 'missing-validated-request'],
  ];
  await editSnapshot(g2.store, snapshot => {
    for (const [id, f, changes] of rejected) {
      const run = structuredClone(snapshot.runs[f.run.id]);
      run.id = id;
      const producer = run.nodeStates[f.row.nodeId];
      Object.assign(producer.attempts.at(-1).output[f.namespace][f.row.kind], { runId: id, ...changes });
      const decision = { ...structuredClone(f.decision), id: id + '-decision', runId: id };
      run.nodeStates[f.row.gateNodeId].attempts.at(-1).decisionId = decision.id;
      if (!changes.decisionId) producer.attempts.at(-1).output[f.namespace][f.row.kind].decisionId = decision.id;
      if (id === 'legacy-verification') run.graph = adlc.graphs.find(row => row.id === 'verification' && row.version === '0.1.8');
      if (id === 'unlisted-node') {
        run.nodeStates['draft-requirements'] = producer;
        run.nodeStates[f.row.nodeId] = { status: 'pending', attempts: [], artifacts: [] };
      }
      if (id === 'untrusted-pack') run.pack.release.digest = 'sha256:' + '0'.repeat(64);
      if (id === 'no-wrapper-output') delete producer.attempts.at(-1).output[f.namespace];
      snapshot.runs[id] = run;
      snapshot.decisions.push(decision);
    }
  });
  for (const [id, f] of rejected) {
    await bindRuntime(h.db, h.companyId, { ...f, run: { id } });
  }
  await h.discover();
  for (const [id, , , reason] of rejected) {
    const [stored] = await listMergeRequests(h.db, h.companyId, id);
    if (reason === null) assert.equal(stored, undefined, id);
    else {
      assert.equal(stored?.disposition, 'rejected-admission', id);
      assert.equal(stored.reason, reason, id);
    }
  }
  const alterOutput = (snapshot, f, nodeId, kind, edit) => {
    const attempt = snapshot.runs[f.run.id].nodeStates[nodeId].attempts.at(-1);
    edit(attempt.output[f.namespace][kind]);
  };
  await editSnapshot(g2.store, snapshot => {
    alterOutput(snapshot, g2, g2.row.nodeId, g2.row.kind, value => { value.pullNumber++; });
    alterOutput(snapshot, g4, g4.row.candidateNodeId, g4.row.candidateKind, value => { value.altered = true; });
    alterOutput(snapshot, g3, g3.row.auditNodeId, g3.row.auditKind, value => { value.findings.push({ severity: 'P1' }); });
    snapshot.decisions.find(value => value.id === g5.decision.id).candidateBinding = null;
  });
  await h.discover();
  const expected = ['fingerprint-conflict', 'candidate-binding-mismatch', 'missing-current-approval', 'audit-binding-mismatch'];
  for (const [index, f] of fixtures.entries()) {
    const [stored] = await listMergeRequests(h.db, h.companyId, f.run.id);
    assert.equal(stored.disposition, index === 0 ? 'fingerprint-conflict' : 'rejected-admission');
    assert.equal(index === 0 ? stored.disposition : stored.reason, expected[index]);
    assert.equal(stored.request.payload.pullNumber, f.request.pullNumber);
    assert.equal(stored.fingerprint, sha256(canonical(stored.request)));
  }
});

const postgresOnly = { skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL' };

async function publishedProducer(h, row, { completeRun, ...options } = {}) {
  const fixture = await readyGate(h.db, h.companyId, row, options);
  await bindRuntime(h.db, h.companyId, fixture);
  // G5 uses seeded inspection evidence while the PR inspection service is disabled.
  const gateApi = row.section ? fixture.api : fixture.engine;
  const { decision } = await gateApi.decideNode(fixture.args);
  await publish(fixture, decision, { completeRun });
  return { ...fixture, decision };
}

test('missing adapter observations preserve admitted requests and can be replaced with validated requests', postgresOnly, async t => {
  const h = await migratedHost(t);
  const row = mergeProducers[0];
  const first = await publishedProducer(h, row, { id: 'admitted' });
  const requests = runId => listMergeRequests(h.db, h.companyId, runId);
  await h.discover();
  const admitted = await requests(first.run.id);
  assert.equal(admitted[0].disposition, 'admitted');

  const second = await publishedProducer(h, row, { id: 'initially-untrusted' });
  await h.discoverWithoutAdapter();
  assert.deepEqual(await requests(first.run.id), admitted);
  const [untrusted] = await requests(second.run.id);
  assert.equal(untrusted.disposition, 'rejected-admission');
  assert.equal(untrusted.request.payload, null);
  assert.equal(untrusted.fingerprint, null);

  await editSnapshot(first.store, () => {});
  await h.discover();
  assert.deepEqual(await requests(first.run.id), admitted);
  const [restored] = await requests(second.run.id);
  assert.equal(restored.disposition, 'admitted');
  assert.equal(restored.request.payload.decisionId, second.decision.id);
});

test('retrying a gate supersedes its previously admitted producer attempt', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await readyGate(h.db, h.companyId, mergeProducers[3]);
  await bindRuntime(h.db, h.companyId, f);
  const approval = await f.api.decideNode(f.args);
  await publish(f, approval.decision, { completeRun: false });
  const requests = () => listMergeRequests(h.db, h.companyId, f.run.id);
  await h.discover();
  const [first] = await requests();
  assert.equal(first.disposition, 'admitted');

  const retry = await f.engine.retryNode({ runId: f.run.id, nodeId: f.row.gateNodeId, actor: owner, reason: 'Repeat approval' });
  assert.equal(retry.run.nodeStates[f.row.nodeId].status, 'pending');
  await h.discover();
  const superseded = { ...first, disposition: 'rejected-admission', reason: 'superseded-attempt' };
  assert.deepEqual(await requests(), [superseded]);

  const freshApproval = await f.api.decideNode(f.args);
  await publish(f, freshApproval.decision);
  await h.discover();
  const rows = await requests();
  assert.deepEqual(rows[0], superseded);
  assert.deepEqual(rows.filter(row => row.disposition === 'admitted').map(row => row.attemptIndex), [2]);
});

for (const [label, row, options] of [
  ['superseding G2', mergeProducers[0], { supersedes: 'previous-manifest' }],
  ['G4', mergeProducers[1], {}],
  ['G5', mergeProducers[2], {}],
]) {
  test(`discovery checks current contract pins for ${label}`, postgresOnly, async t => {
    const h = await migratedHost(t);
    const f = await publishedProducer(h, row, options);
    const requests = () => listMergeRequests(h.db, h.companyId, f.run.id);
    const setPins = contractPins => editSnapshot(f.store, snapshot => { snapshot.runs[f.run.id].input.contract_pins = contractPins; });
    await setPins(f.run.input.contract_pins.map((pin, index) => index === 0 ? { ...pin, commit: '3'.repeat(40) } : pin));
    await h.discover();
    assert.equal((await requests())[0].reason, 'contract-pins-mismatch');
    await setPins(f.run.input.contract_pins);
    await h.discover();
    assert.equal((await requests())[0].disposition, 'admitted');
  });
}

async function revalidate(h, f, status) {
  const snapshot = await f.store.read();
  const validation = await finalizePackRuntimeValidation(h.db, { companyId: h.companyId, runId: f.run.id,
    expectedStateRevision: snapshot.revision, sourceDigest: 'sha256:' + runValidationDigest(snapshot.runs[f.run.id]),
    validation: { status, issues: status === 'invalid' ? ['Fixture failed validation'] : [], validatedSubjectRefs: [] },
    identity: status === 'valid' ? fixtureIdentity(f) : null, actor: owner, reason: 'Fixture revalidation' });
  assert.equal(validation.committed, true);
}

for (const adapterAvailable of [true, false]) {
  test(`failed revalidation revokes admission with adapter available: ${adapterAvailable}`, postgresOnly, async t => {
    const h = await migratedHost(t);
    const f = await publishedProducer(h, mergeProducers[1]);
    const requests = () => listMergeRequests(h.db, h.companyId, f.run.id);
    await h.discover();
    const [admitted] = await requests();
    assert.equal(admitted.disposition, 'admitted');

    await revalidate(h, f, 'invalid');
    if (adapterAvailable) await h.discover();
    else await h.discoverWithoutAdapter();
    assert.deepEqual(await requests(), [{ ...admitted, disposition: 'rejected-admission', reason: 'untrusted-runtime-binding' }]);
  });
}

test('discovery rejects stale validation and missing or different runtime identities', postgresOnly, async t => {
  const h = await migratedHost(t);
  const row = mergeProducers[0];
  const stale = await publishedProducer(h, row, { id: 'stale-validation' });
  await revalidate(h, stale, 'valid');
  const missing = await publishedProducer(h, row, { id: 'missing-identity' });
  const different = await publishedProducer(h, row, { id: 'different-identity' });
  const runtime = h.namespace + '.graph_pack_runtime';
  await h.db.execute(`DELETE FROM ${runtime} WHERE company_id=$1 AND graph_run_id=$2`, [h.companyId, missing.run.id]);
  await h.db.execute(`UPDATE ${runtime} SET adapter_version='different' WHERE company_id=$1 AND graph_run_id=$2`,
    [h.companyId, different.run.id]);
  await editSnapshot(stale.store, snapshot => { delete snapshot.runs[stale.run.id].hostValidationId; });
  await h.discover();
  for (const f of [stale, missing, different]) {
    const [saved] = await listMergeRequests(h.db, h.companyId, f.run.id);
    assert.equal(saved.disposition, 'rejected-admission', f.run.id);
    assert.equal(saved.reason, 'untrusted-runtime-binding', f.run.id);
  }
});

test('invalid parent revalidation revokes a trusted child admission from the same snapshot', postgresOnly, async t => {
  const h = await migratedHost(t);
  const row = mergeProducers[0];
  const parent = await readyGate(h.db, h.companyId, row, { id: 'parent' });
  await bindRuntime(h.db, h.companyId, parent);
  const child = await publishedProducer(h, row, { id: 'child' });
  const requests = () => listMergeRequests(h.db, h.companyId, child.run.id);
  await editSnapshot(child.store, snapshot => {
    const run = snapshot.runs[child.run.id];
    run.parentWorkflow = { runId: parent.run.id };
    run.input.paperclipIssueId = parent.run.input.paperclipIssueId;
  });
  await h.discover();
  const [admitted] = await requests();
  assert.equal(admitted.disposition, 'admitted');
  await revalidate(h, parent, 'invalid');
  h.snapshotReads.length = 0;
  await h.discover();
  assert.deepEqual(h.snapshotReads, [h.companyId]);
  assert.deepEqual(await requests(), [{ ...admitted, disposition: 'rejected-admission', reason: 'untrusted-runtime-binding' }]);
});

test('an unavailable required parent adapter blocks new child admission and preserves existing admission', postgresOnly, async t => {
  const h = await migratedHost(t);
  const parentRow = mergeProducers.find(row => row.packId === creative.id);
  const parent = await readyGate(h.db, h.companyId, parentRow, { id: 'parent' });
  await bindRuntime(h.db, h.companyId, parent);
  const child = await publishedProducer(h, mergeProducers[0], { id: 'child' });
  const requests = () => listMergeRequests(h.db, h.companyId, child.run.id);
  await editSnapshot(child.store, snapshot => {
    const run = snapshot.runs[child.run.id];
    run.parentWorkflow = { runId: parent.run.id };
    run.input.paperclipIssueId = parent.run.input.paperclipIssueId;
  });

  await h.discoverWithoutAdapter(parentRow.packId);
  const [rejected] = await requests();
  assert.equal(rejected.disposition, 'rejected-admission');
  assert.equal(rejected.reason, 'untrusted-ancestor-binding');

  await editSnapshot(child.store, () => {});
  await h.discover();
  const [admitted] = await requests();
  assert.equal(admitted.disposition, 'admitted');

  await editSnapshot(child.store, () => {});
  await h.discoverWithoutAdapter(parentRow.packId);
  assert.deepEqual(await requests(), [admitted]);
});

for (const [label, corrupt] of [
  ['without a Pack snapshot', parentRun => { delete parentRun.pack; }],
  // Only the run's recorded version changes; the trusted snapshot stays intact so its adapter still
  // resolves, and only the snapshot identity check can yield untrusted-ancestor-binding.
  ['with a mismatched Pack snapshot version', parentRun => { parentRun.packVersion = `${parentRun.packVersion}-other`; }],
]) {
  test(`a parent ${label} blocks first-time child admission`, postgresOnly, async t => {
    const h = await migratedHost(t);
    const row = mergeProducers[0];
    const parent = await readyGate(h.db, h.companyId, row, { id: 'parent' });
    await bindRuntime(h.db, h.companyId, parent);
    const child = await publishedProducer(h, row, { id: 'child' });
    await editSnapshot(child.store, snapshot => {
      corrupt(snapshot.runs[parent.run.id]);
      const run = snapshot.runs[child.run.id];
      run.parentWorkflow = { runId: parent.run.id };
      run.input.paperclipIssueId = parent.run.input.paperclipIssueId;
    });

    await h.discover();
    const [rejected] = await listMergeRequests(h.db, h.companyId, child.run.id);
    assert.equal(rejected.disposition, 'rejected-admission');
    assert.equal(rejected.reason, 'untrusted-ancestor-binding');
    assert.equal(rejected.fingerprint, null);
  });
}

test('a missing repository revokes child admission while a required parent adapter is unavailable', postgresOnly, async t => {
  const h = await migratedHost(t);
  const parentRow = mergeProducers.find(row => row.packId === creative.id);
  const parent = await readyGate(h.db, h.companyId, parentRow, { id: 'parent' });
  await bindRuntime(h.db, h.companyId, parent);
  const child = await publishedProducer(h, mergeProducers[0], { id: 'child' });
  const requests = () => listMergeRequests(h.db, h.companyId, child.run.id);
  await editSnapshot(child.store, snapshot => {
    const run = snapshot.runs[child.run.id];
    run.parentWorkflow = { runId: parent.run.id };
    run.input.paperclipIssueId = parent.run.input.paperclipIssueId;
  });
  await h.discover();
  const [admitted] = await requests();
  assert.equal(admitted.disposition, 'admitted');

  h.config.adlcProjects.project = { ...project, repository: undefined };
  await editSnapshot(child.store, () => {});
  await h.discoverWithoutAdapter(parentRow.packId);
  assert.deepEqual(await requests(), [{ ...admitted, disposition: 'rejected-admission', reason: 'project-binding-mismatch' }]);
});

test('a missing repository remains provisional until the project is configured', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await publishedProducer(h, mergeProducers[0]);
  const requests = () => listMergeRequests(h.db, h.companyId, f.run.id);
  h.config.adlcProjects.project = { ...project, repository: undefined };
  await h.discover();
  const [provisional] = await requests();
  assert.equal(provisional.disposition, 'rejected-admission');
  assert.equal(provisional.reason, 'project-binding-mismatch');
  assert.equal(provisional.request.repository, null);
  assert.ok(provisional.fingerprint);
  h.config.adlcProjects.project = project;
  await editSnapshot(f.store, () => {});
  await h.discover();
  const [admitted] = await requests();
  assert.equal(admitted.disposition, 'admitted');
  assert.equal(admitted.request.repository, project.repository);
  assert.equal(admitted.fingerprint, sha256(canonical(admitted.request)));
  assert.notEqual(admitted.fingerprint, provisional.fingerprint);
});

test('removing and restoring the configured repository preserves the original publication request', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await publishedProducer(h, mergeProducers[0]);
  const requests = () => listMergeRequests(h.db, h.companyId, f.run.id);
  await h.discover();
  const [admitted] = await requests();
  assert.equal(admitted.disposition, 'admitted');

  for (const repository of [undefined, 'malformed']) {
    h.config.adlcProjects.project = { ...project, repository };
    await editSnapshot(f.store, () => {});
    await h.discover();
    assert.deepEqual(await requests(), [{ ...admitted, disposition: 'rejected-admission', reason: 'project-binding-mismatch' }]);
  }

  h.config.adlcProjects.project = project;
  await editSnapshot(f.store, () => {});
  await h.discover();
  assert.deepEqual(await requests(), [admitted]);
});

test('changing the configured repository conflicts with the original publication request', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await publishedProducer(h, mergeProducers[0]);
  const requests = () => listMergeRequests(h.db, h.companyId, f.run.id);
  await h.discover();
  const [admitted] = await requests();
  assert.equal(admitted.disposition, 'admitted');
  h.config.adlcProjects.project = { ...project, repository: 'example/other' };
  await editSnapshot(f.store, () => {});
  await h.discover();
  assert.deepEqual(await requests(), [{ ...admitted, disposition: 'fingerprint-conflict', reason: 'fingerprint-changed' }]);
});

test('a failing company moves behind an unattempted company with a scan limit of one', postgresOnly, async t => {
  const h = await migratedHost(t);
  for (const companyId of [h.companyId, h.otherCompanyId]) {
    await editSnapshot(new PaperclipStore(h.db, companyId), () => {});
  }
  await h.db.execute(`UPDATE ${h.namespace}.graph_state SET updated_at=updated_at-interval '1 day' WHERE company_id=$1`, [h.companyId]);
  h.host.config.get = async companyId => {
    if (companyId === h.companyId) {
      throw new Error('Configuration failed at https://private-user:private-password@example.com?token=private-query-token ' +
        'https://example.com/object?X-Amz-Signature=private-signature#private-fragment ' +
        "https://example.com/team's/report?X-Amz-Signature=private-value " +
        'client_secret=private-client-secret db_password=private-db-password ' + 'x'.repeat(200));
    }
    return h.config;
  };
  const tick = () => discoverAdlcMerges({ host: h.host, resolveAdapter: () => assert.fail(),
    runtimeBindingError: () => assert.fail(), limit: 1 });
  await tick();
  await tick();
  assert.deepEqual(h.snapshotReads, [h.companyId, h.otherCompanyId]);
  assert.ok(!JSON.stringify(h.warnings).includes('private-'), 'error text appeared in the log');
  assert.deepEqual(h.warnings, [{ message: 'ADLC merge discovery failed for company', details: {
    companyId: h.companyId, runId: null, operation: 'company-scan', error: { name: 'Error', code: null },
  } }]);
  const checkpoints = await h.db.query(`SELECT company_id, last_revision FROM ${h.namespace}.adlc_merge_discovery`);
  assert.deepEqual(Object.fromEntries(checkpoints.map(row => [row.company_id, Number(row.last_revision)])),
    { [h.companyId]: 0, [h.otherCompanyId]: 1 });
});

test('merge discovery store fences stale observations and checkpoint advances', postgresOnly, async t => {
  const h = await migratedHost(t);
  const store = new PaperclipStore(h.db, h.companyId);
  for (let i = 0; i < 2; i++) await editSnapshot(store, () => {});
  const request = { runId: 'run', nodeId: 'producer', attemptIndex: 1, kind: 'request',
    fingerprint: 'original', request: { repository: project.repository, payload: { pullNumber: 1 } },
    disposition: 'admitted', reason: null };
  await saveMergeRequest(h.db, h.companyId, 2, request);
  const rows = await listMergeRequests(h.db, h.companyId, request.runId);
  assert.equal(rows.length, 1);
  await saveMergeRequest(h.db, h.companyId, 1, { ...request, fingerprint: 'different', request: { payload: { pullNumber: 2 } } });
  assert.deepEqual(await listMergeRequests(h.db, h.companyId, request.runId), rows);
  await editSnapshot(store, () => {});
  await editSnapshot(store, () => {});
  await rejectSupersededMergeRequests(h.db, h.companyId, 3, { ...request, currentAttempt: null });
  assert.deepEqual(await listMergeRequests(h.db, h.companyId, request.runId), rows);
  assert.equal(await advanceMergeDiscovery(h.db, h.companyId, null, 3), true);
  assert.equal(await advanceMergeDiscovery(h.db, h.companyId, 2, 4), false);
  assert.equal(await advanceMergeDiscovery(h.db, h.companyId, 3, 4), true);
});

test('a stale worker cannot insert an attempt after a newer worker checkpoints a retry', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await publishedProducer(h, mergeProducers[3], { completeRun: false });
  const observed = await f.store.read();
  const { nodeId, kind } = f.row;
  const attempt = observed.runs[f.run.id].nodeStates[nodeId].attempts.at(-1);
  const request = { kind, payload: attempt.output[f.namespace][kind], artifactRef: attempt.artifacts.find(ref => ref.kind === kind),
    projectId: project.id, repository: project.repository };
  const staleWrite = () => saveMergeRequest(h.db, h.companyId, observed.revision, {
    runId: f.run.id, nodeId, attemptIndex: 1, kind, fingerprint: sha256(canonical(request)), request,
    disposition: 'admitted', reason: null,
  });
  const retry = await f.engine.retryNode({ runId: f.run.id, nodeId: f.row.gateNodeId, actor: owner, reason: 'Repeat approval' });
  assert.equal(retry.run.nodeStates[nodeId].status, 'pending');
  await h.discover();
  const [checkpoint] = await h.db.query(`SELECT last_revision FROM ${h.namespace}.adlc_merge_discovery WHERE company_id=$1`, [h.companyId]);
  assert.equal(Number(checkpoint.last_revision), observed.revision + 1);
  await staleWrite();
  assert.deepEqual(await listMergeRequests(h.db, h.companyId, f.run.id), []);
});

test('G2 confirmation freezes the exact document and rejects missing or changed payload', {
  skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL',
}, async t => {
  const h = await migratedHost(t);
  const row = mergeProducers[0];
  const absent = await readyGate(h.db, h.companyId, row, { id: 'no-payload', missing: true });
  await assert.rejects(absent.engine.decideNode(absent.args), /current validated candidate payload/);
  const harness = createTestHarness({ manifest, capabilities: ['issue.documents.read', 'issue.documents.write'] });
  const issueId = randomUUID();
  harness.seed({ issues: [{ id: issueId, companyId: h.companyId }] });
  const body = JSON.stringify(approvalManifestBody(), null, 2);
  const document = await harness.ctx.issues.documents.upsert({ companyId: h.companyId, issueId, key: 'approval-manifest', body });
  const f = await readyGate(h.db, h.companyId, row, { id: 'confirmation', document });
  const { run, engine, candidate } = f;
  await bindRuntime(h.db, h.companyId, f);
  const storedCandidate = snapshot => snapshot.runs[run.id].nodeStates[row.candidateNodeId].attempts[0].output[f.namespace][row.candidateKind];
  await editSnapshot(f.store, snapshot => {
    Object.assign(snapshot.runs[run.id], {
      status: 'paused', pendingHuman: { kind: 'decision', nodeId: row.gateNodeId, escalationDecisionId: 'escalation' },
    });
    storedCandidate(snapshot).altered = true;
  });
  h.host.issues.documents = harness.ctx.issues.documents;
  h.host.issues.requestConfirmation = async (_issue, input) => ({ ...input, id: 'card', kind: 'request_confirmation',
    status: 'accepted', result: { outcome: 'accepted' }, resolvedByUserId: owner.id });
  const confirm = () => plugin.definition.onApiRequest({ routeKey: 'graph-read', companyId: h.companyId,
    params: { issueId }, query: { runId: run.id }, actor: { actorType: 'user', userId: owner.id } });
  assert.match((await confirm()).body.nativeDecisionError, /document body does not match/);
  assert.deepEqual(await engine.listDecisions({ runId: run.id }), []);
  await editSnapshot(f.store, snapshot => { delete storedCandidate(snapshot).altered; });
  const response = await confirm();
  assert.equal(response.body.nativeDecisionError, null);
  assert.equal(response.body.nativeDecisions[0].consumed, true);
  const [decision] = await engine.listDecisions({ runId: run.id });
  assertFrozen(decision, f);
  assert.deepEqual(decision.candidateBinding.document,
    { issueId, key: 'approval-manifest', documentId: candidate.id, revisionId: candidate.version, bodyDigest: sha256(body) });
});

test('worker explains why prepare-g5 cannot inspect the implementation PR', {
  skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL',
}, async t => {
  const h = await migratedHost(t);
  const f = await readyGate(h.db, h.companyId, mergeProducers[2], { preparing: true });
  await bindRuntime(h.db, h.companyId, f);
  await setGraphConfig(h.db, h.companyId, { roleBindings: {}, userRoles: { owner: ['principal-engineer'] }, defaultMode: 'manual' });
  const context = { id: 'context', version: '1', modelRisk: 'low' };
  const response = await plugin.definition.onApiRequest({ routeKey: 'graph-command', companyId: h.companyId,
    params: { issueId: f.run.input.paperclipIssueId }, actor: { actorType: 'user', userId: owner.id },
    body: { operation: 'submit', runId: f.run.id, nodeId: 'prepare-g5',
      artifacts: [envelope('merge_context', context), envelope('merge_pr_head', pr)],
      payloads: { merge_context: context, merge_pr_head: pr } } });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /implementation PR inspection not yet enabled/);
  assert.equal((await f.engine.getRun(f.run.id)).nodeStates['prepare-g5'].status, 'pending');
});

const publicationOptions = { skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL' };

async function approvedPublication(h, options) {
  const producer = mergeProducers.find(row => row.section === 'product');
  const f = await readyGate(h.db, h.companyId, producer, { productBody: approvalBody(), now: () => approvalTime, ...options });
  if (h.db) await bindRuntime(h.db, h.companyId, f);
  const { decision } = await f.api.decideNode({ ...f.args, confirmation: true, confirmationDocument: {
    issueId: f.run.input.paperclipIssueId, key: 'approval-manifest', documentId: f.candidate.id,
    revisionId: f.candidate.version, body: JSON.stringify(f.candidate),
  } });
  const payload = await publish(f, decision, { pullNumber: options?.pullNumber });
  await h.discover?.();
  const frozen = decision.candidateBinding.candidates.find(ref => ref.artifactId === f.candidate.id);
  const approvedManifest = { ...manifestRef(f.candidate), bytes: Buffer.from(frozen.bytes, 'base64') };
  return { f, decision, producer, approvedManifest, payload };
}

test('the G2 worker reads an in-memory approved run and blocks a GitHub repository identity mismatch', async () => {
  const companyId = randomUUID(), namespace = 'plugin_memory_publication';
  const graphStore = new MemoryStore();
  const { f, producer, payload } = await approvedPublication({ companyId }, { graphStore });
  const snapshot = await graphStore.read();
  const artifactRef = snapshot.runs[f.run.id].nodeStates[producer.nodeId].attempts.at(-1).artifacts
    .find(ref => ref.kind === producer.kind);
  const request = { kind: producer.kind, payload, artifactRef, projectId: project.id, repository: project.repository };
  const occurrence = { company_id: companyId, run_id: f.run.id, node_id: producer.nodeId, attempt_index: 1, kind: producer.kind,
    disposition: 'admitted', execution_state: null, execution_version: 0, request_json: request, fingerprint: sha256(canonical(request)) };
  const github = publicationGitHub(project.repository, new Map());
  github.repo.id++;
  const config = { githubApp: app, githubTransportAttestation: attestation, adlcProjects: { project: {
    ...project, githubRepositoryId: repositoryId, contractPublication: { g2: true, validatorId: 'adlc-g2-reference-v1' },
  } } };
  const db = {
    namespace,
    async query(statement) {
      validatePluginRuntimeQuery(statement, namespace);
      if (statement.includes('.graph_state')) return [{ revision: snapshot.revision, document: snapshot }];
      return statement.includes('.adlc_merge_requests') ? [occurrence] : [];
    },
    async execute(statement, params) {
      validatePluginRuntimeExecute(statement, namespace);
      assert.match(statement, /SET execution_state=/);
      assert.deepEqual(params.slice(6, 8), ['blocked-config', 'github-repository-identity-mismatch']);
      return { rowCount: 1 };
    },
  };
  const worker = createAdlcContractPublication({
    host: { db, config: { get: async () => config }, http: { fetch: github.fetch }, secrets: { resolve: github.resolve } },
    engineFor: async () => ({ engine: f.engine }), resolveAdapter: () => ({ descriptor: f.descriptor }),
    runtimeBindingError: async () => null, transportReadiness: value => githubHostTransportReadiness(value, versions),
  });
  assert.deepEqual(await worker.tick(), [{ state: 'blocked-config', reason: 'github-repository-identity-mismatch' }]);
  assert.deepEqual(githubWrites(github), []);
});

async function publicationHarness(t) {
  const h = await migratedHost(t);
  const { f, decision, producer, approvedManifest } = await approvedPublication(h);
  const authored = authoredProposal(decision, approvedManifest);
  const github = publicationGitHub(project.repository, new Map([[root + '/INDEX.json', Buffer.from('[]\n')]]), authored.tree);
  h.config.githubApp = app;
  h.config.githubTransportAttestation = attestation;
  h.config.adlcProjects.project = { ...project, githubRepositoryId: repositoryId,
    contractPublication: { g2: true, validatorId: 'adlc-g2-reference-v1' } };
  const ownerCommand = recoveryAction => plugin.definition.onApiRequest({
    routeKey: 'graph-command', companyId: h.companyId, params: { issueId: f.run.input.paperclipIssueId },
    actor: { actorType: 'user', userId: owner.id },
    body: { operation: 'contract-publication-recovery', recoveryAction, runId: f.run.id, nodeId: producer.nodeId,
      kind: producer.kind, attemptIndex: 1 },
  });
  const createWorker = (db = h.db, overrides = {}) => createAdlcContractPublication({
    host: { ...h.host, db, http: { fetch: github.fetch }, secrets: { resolve: github.resolve } },
    engineFor: async companyId => ({ engine: new GraphEngine({ store: new PaperclipStore(db, companyId) }) }),
    resolveAdapter: h.resolve, runtimeBindingError: h.runtimeBindingError,
    transportReadiness: value => githubHostTransportReadiness(value, versions),
    ...overrides,
  });
  const queue = h.namespace + '.adlc_merge_requests';
  const due = () => h.sql.unsafe('UPDATE ' + queue + ' SET next_try_at=now()');
  const readQueue = runId => h.sql.unsafe('SELECT * FROM ' + queue + ' WHERE run_id=$1', [runId ?? f.run.id]).then(([row]) => row);
  return { h, f, decision, authored, github, ownerCommand, createWorker, queue, due, readQueue };
}

test('two publication workers race through the real G2 profile and record exactly one receipt', publicationOptions, async t => {
  const { h, f, authored, github, ownerCommand, createWorker, readQueue } = await publicationHarness(t);
  assert.deepEqual(await h.publishJob(), [{ state: 'blocked-config', reason: 'transport-redirect-unsafe' }]);
  assert.deepEqual((await ownerCommand('reschedule')).body, { state: 'rescheduled' });
  const attempts = await h.sql.unsafe('SELECT outcome,actor_id,reason FROM ' + h.namespace + '.github_merge_recovery_attempts');
  assert.deepEqual([...attempts], [{ outcome: 'rescheduled', actor_id: owner.id, reason: 'publication-recovery-owner-reschedule' }]);
  const workers = [createWorker(h.db), createWorker(h.independentDatabase())];
  await Promise.all(workers.map(worker => worker.tick()));
  await workers[0].tick();
  const durableCalls = github.calls.filter(({ method, path }) => path.startsWith('/repos/') && method !== 'GET');
  assert.deepEqual(durableCalls.map(({ method }) => method), ['POST', 'POST', 'PATCH', 'DELETE']);
  const events = (await f.engine.getAudit({ runId: f.run.id })).filter(event => event.kind === 'contract.merged');
  assert.equal(events.length, 1);
  assert.equal(events[0].contractId, authored.contractId);
  const row = await readQueue();
  assert.equal(row.execution_state, 'recorded');
  assert.equal(row.receipt_json.mergeCommitSha, events[0].mergeCommitSha);
  assert.equal((await ownerCommand('view')).body.state, 'acked');
});

const githubWrites = github => github.calls.filter(({ method, path }) => path.startsWith('/repos/') && method !== 'GET');

for (const issue of ['missing', 'different revision']) {
  test('G2 re-admission refuses confirmation with ' + issue + ' binding', publicationOptions, async t => {
    const { f, decision, github, createWorker } = await publicationHarness(t);
    await editSnapshot(f.store, snapshot => {
      const binding = snapshot.decisions.find(item => item.id === decision.id).candidateBinding;
      if (issue === 'missing') delete binding.document;
      else binding.document.revisionId = 'wrong-revision';
    });
    assert.deepEqual(await createWorker().tick(), [{ state: 'needs-new-approval', reason: 'publication-approval-stale' }]);
    assert.deepEqual(githubWrites(github), []);
  });
}

for (const [scenario, change, expected] of [
  ['wrong proposal branch', github => { github.branch = 'contract/feat-incorrect_PRC-000000000001'; },
    { state: 'needs-new-approval', reason: 'contract-proposal-differs' }],
  ['different merge base', github => { github.proposalBase = advanced; },
    { state: 'needs-new-approval', reason: 'github-merge-main-changed' }],
  ['different GitHub repository ID', github => { github.repo.id++; },
    { state: 'blocked-config', reason: 'github-repository-identity-mismatch' }],
]) {
  test('G2 worker blocks ' + scenario, publicationOptions, async t => {
    const { github, createWorker, readQueue } = await publicationHarness(t);
    change(github);
    assert.deepEqual(await createWorker().tick(), [expected]);
    assert.equal((await readQueue()).execution_state, expected.state);
    assert.deepEqual(githubWrites(github), []);
  });
}

for (const method of ['listDecisions', 'getRun']) {
  test('G2 worker backs off on a transient ' + method + ' error without logging private detail', publicationOptions, async t => {
    const { h, f, github, createWorker, readQueue } = await publicationHarness(t);
    const engine = new GraphEngine({ store: f.store });
    const original = engine[method].bind(engine);
    let calls = 0;
    engine[method] = async (...args) => {
      if (++calls === (method === 'getRun' ? 2 : 1)) throw new Error('Revision conflict or DB error: private-detail');
      return original(...args);
    };
    assert.deepEqual(await createWorker(h.db, { engineFor: async () => ({ engine }) }).tick(),
      [{ state: 'backoff', reason: 'publication-retry' }]);
    assert.equal((await readQueue()).execution_state, 'backoff');
    assert.deepEqual(h.warnings.at(-1), { message: 'ADLC contract publication failed',
      details: { runId: f.run.id, reason: 'publication-retry' } });
    assert.deepEqual(githubWrites(github), []);
  });
}

test('G2 worker blocks on hold and publishes after the run resumes', publicationOptions, async t => {
  const { f, github, createWorker, due } = await publicationHarness(t);
  const worker = createWorker();
  await editSnapshot(f.store, snapshot => { snapshot.runs[f.run.id].status = 'paused'; });
  assert.deepEqual(await worker.tick(), [{ state: 'blocked-config', reason: 'publication-run-on-hold' }]);
  assert.deepEqual(githubWrites(github), []);
  await editSnapshot(f.store, snapshot => { snapshot.runs[f.run.id].status = 'completed'; });
  await due();
  assert.deepEqual(await worker.tick(), [{ state: 'recorded' }]);
});

test('G2 worker defers when an operator disables the gate during preparation', publicationOptions, async t => {
  const { h, github, createWorker } = await publicationHarness(t);
  github.fail = (_method, path) => {
    if (path.startsWith('/git/trees/')) h.config.adlcProjects.project.contractPublication.g2 = false;
    return false;
  };
  assert.deepEqual(await createWorker().tick(), [{ state: 'blocked-config', reason: 'publication-gate-disabled' }]);
  assert.deepEqual(githubWrites(github), []);
});

test('G2 worker blocks a temporary runtime binding failure', publicationOptions, async t => {
  const { h, github, createWorker } = await publicationHarness(t);
  const worker = createWorker(h.db, { runtimeBindingError: async () => 'runtime validation not ready' });
  assert.deepEqual(await worker.tick(), [{ state: 'blocked-config', reason: 'untrusted-runtime-binding' }]);
  assert.deepEqual(githubWrites(github), []);
});

test('a worker paused before intent loses its send privilege when another worker changes the queue', publicationOptions, async t => {
  const { h, github, createWorker, queue, readQueue } = await publicationHarness(t);
  const paused = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const workerDb = { ...h.db, async execute(statement, params) {
    if (statement.includes("SET state='intent'")) {
      paused.resolve();
      await resume.promise;
    }
    return h.db.execute(statement, params);
  } };
  const run = createWorker(workerDb).tick();
  try {
    await Promise.race([paused.promise, run.then(() => assert.fail('Worker did not reach intent CAS'))]);
    const second = h.independentDatabase();
    await second.execute("UPDATE " + queue + " SET execution_state='needs-new-approval',execution_version=execution_version+1", []);
    assert.deepEqual(await createWorker(second).tick(), []);
  } finally {
    resume.resolve();
    await run;
  }
  assert.equal((await readQueue()).execution_state, 'needs-new-approval');
  const [operation] = await h.sql.unsafe('SELECT state, temp_ref FROM ' + h.namespace + '.github_merge_journal');
  assert.deepEqual(operation, { state: 'claimed', temp_ref: null });
  assert.deepEqual(githubWrites(github), []);
});

test('G2 PATCH authorization retries a transient read and an unrelated graph revision bump', publicationOptions, async t => {
  const { h, f, github, createWorker } = await publicationHarness(t);
  let droppedRead = false;
  github.fail = (method, path) => {
    if (!droppedRead && method === 'GET' && path.startsWith('/pulls/') && github.calls.some(call => call.path.endsWith('/merges'))) {
      droppedRead = true;
      return true;
    }
    return false;
  };
  let casCalls = 0;
  const db = { ...h.db, async execute(statement, params) {
    if (statement.includes('SET patch_send_started=true') && ++casCalls === 1) {
      await editSnapshot(f.store, () => {});
    }
    return h.db.execute(statement, params);
  } };
  assert.deepEqual(await createWorker(db).tick(), [{ state: 'recorded' }]);
  assert.equal(droppedRead, true);
  assert.equal(casCalls, 2);
  assert.deepEqual(githubWrites(github).map(call => call.method), ['POST', 'POST', 'PATCH']);
});

test('a competing worker observing live intent preserves the original sender queue version', publicationOptions, async t => {
  const { h, github, createWorker, readQueue } = await publicationHarness(t);
  const paused = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const db = { ...h.db, async execute(statement, params) {
    const result = await h.db.execute(statement, params);
    if (statement.includes("SET state='intent'")) {
      paused.resolve();
      await resume.promise;
    }
    return result;
  } };
  const run = createWorker(db).tick();
  try {
    await Promise.race([paused.promise, run.then(() => assert.fail('Worker did not reach intent CAS'))]);
    assert.deepEqual(await createWorker(h.independentDatabase()).tick(), [{ state: 'intent' }]);
    assert.equal(String((await readQueue()).execution_version), '0');
  } finally {
    resume.resolve();
    await run;
  }
  assert.deepEqual(await run, [{ state: 'recorded' }]);
  assert.deepEqual(githubWrites(github).map(call => call.method), ['POST', 'POST', 'PATCH']);
});

for (const [failure, expectedCalls] of [['zero rows', 4], ['unknown acknowledgment', 1]]) {
  test('G2 PATCH remains unsent after send CAS returns ' + failure, publicationOptions, async t => {
    const { h, github, createWorker } = await publicationHarness(t);
    let casCalls = 0;
    const db = { ...h.db, async execute(statement, params) {
      if (statement.includes('SET patch_send_started=true')) {
        casCalls++;
        if (failure === 'zero rows') return { rowCount: 0 };
        await h.db.execute(statement, params);
        throw new Error('lost CAS response');
      }
      return h.db.execute(statement, params);
    } };
    assert.deepEqual(await createWorker(db).tick(), [{ state: 'unresolved' }]);
    assert.equal(casCalls, expectedCalls);
    assert.deepEqual(githubWrites(github).map(call => call.method), ['POST', 'POST']);
  });
}

for (const marker of [null, true]) {
  test('fingerprinted authorization refuses PATCH when the send marker is ' + marker, publicationOptions, async t => {
    const { h, github, createWorker } = await publicationHarness(t);
    const db = { ...h.db, async execute(statement, params) {
      const result = await h.db.execute(statement, params);
      if (statement.includes('SET merge_sha=')) {
        await h.sql.unsafe('UPDATE ' + h.namespace + '.github_merge_journal SET patch_send_started=$1', [marker]);
      }
      return result;
    } };
    assert.deepEqual(await createWorker(db).tick(), [{ state: 'unresolved' }]);
    assert.deepEqual(githubWrites(github).map(call => call.method), ['POST', 'POST']);
  });
}

test('G2 worker keeps the current product contract ID and folder for a distinct replacement approval', publicationOptions, async t => {
  const { h, authored, decision, github, createWorker, readQueue } = await publicationHarness(t);
  const worker = createWorker();
  assert.deepEqual(await worker.tick(), [{ state: 'recorded' }]);
  const replacement = await approvedPublication(h, { id: 'replacement', supersedes: merge, pullNumber: pr.pullNumber + 1,
    contractPins: [{ section: 'product', contractId: authored.contractId, commit: merge }] });
  assert.notEqual(replacement.decision.id, decision.id);
  const successor = authoredProposal(replacement.decision, replacement.approvedManifest, { ...authored, commit: merge });
  github.base = github.proposalBase = merge;
  github.head = 'e'.repeat(40);
  github.merge = 'f'.repeat(40);
  github.trees.set(github.head, successor.tree);
  assert.deepEqual(await worker.tick(), [{ state: 'recorded' }]);
  const { receipt_json: receipt } = await readQueue(replacement.f.run.id);
  assert.equal(receipt.contractId, authored.contractId);
  assert.equal(receipt.supersedes, merge);
  assert.equal(receipt.decisionId, replacement.decision.id);
  assert.equal(receipt.mergeCommitSha, github.merge);
});
