import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import { fileURLToPath } from 'node:url';
import { pack as adlc } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';
import { pack as creative } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/index.mjs';
import { canonical } from '../../src/core/canonical.mjs';
import { canonicalPublicationJson, readApprovedContract } from '../../src/host/contract-publication.mjs';
import { mergeImplementation } from '../../src/host/implementation-merge.mjs';
import { GraphEngine, runValidationDigest } from '../../src/core/index.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import { PaperclipStore, advanceMergeDiscovery, getPackRuntime, listMergeRequests, recordPackRuntime,
  rejectSupersededMergeRequests, saveMergeRequest, setGraphConfig } from '../../src/plugin/store.mjs';
import { advanced, app, approvalBody, approvalTime, authoredProposal, base, emptyIndex, head, merge, publicationGitHub, repositoryId, root } from '../helpers/g2-publication-fixture.mjs';
import { discoverAdlcMerges } from '../../src/plugin/adlc-merge-discovery.mjs';
import { createPackHostAdapterRegistry } from '../../src/plugin/pack-host-support.mjs';
import { finalizePackRuntimeValidation, getLatestPackRuntimeValidation } from '../../src/plugin/pack-runtime-recovery-store.mjs';
import { adapterBundleDigest, mergeProducers, trustedPackAdapters } from '../../src/plugin/trusted-pack-adapters.mjs';
import plugin from '../../src/plugin/worker.mjs';
import { createPostgresShadowDatabase, postgresShadowAvailable } from '../helpers/postgres-shadow.mjs';

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
  const { db, sql, namespace, companyId, otherCompanyId } = await createPostgresShadowDatabase(t, { full: true });
  const jobs = new Map(), warnings = [], snapshotReads = [];
  let interrupt = null;
  const observedDb = { namespace,
    async query(statement, args) {
      if (statement.includes('SELECT revision, document')) snapshotReads.push(args[0]);
      return db.query(statement, args);
    },
    async execute(statement, args) {
      if (interrupt && statement.includes(interrupt.table) && args[0] === interrupt.companyId
          && (!interrupt.state || args[6] === interrupt.state)) {
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
    discover: () => jobs.get('adlc-merge-discover')(), verify: () => jobs.get('adlc-contract-verify')(),
    discoverWithoutAdapter: packId => discoverAdlcMerges({ host,
      resolveAdapter: pack => !packId || pack.id === packId ? null : resolve(pack), runtimeBindingError }),
    interrupt: (table, companyId, state) => { interrupt = { table, companyId, state }; } };
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
  preparing = false, document, supersedes = null, productBody, now, contractPins, sectionDeliverables, mode = 'manual', findings = [] } = {}) {
  const pack = row.packId === 'adlc' ? adlc : creative;
  const descriptor = trustedPackAdapters.find(adapter => adapter.packId === pack.id);
  const graph = pack.graphs.find(graph => graph.id === row.graphId && graph.version === graphVersion);
  const store = new PaperclipStore(db, companyId);
  const engine = new GraphEngine({ store, mergeProducers, candidatePayload: descriptor.candidatePayload, now });
  const namespace = pack.id === adlc.id ? 'adlcProductMethods' : 'creativeArtifacts';
  const input = { paperclipCompanyId: companyId, paperclipIssueId: document?.issueId ?? randomUUID(), projectId: project.id };
  const run = { id, pack, packId: pack.id, packVersion: pack.version, graph, input, mode, status: 'running',
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
    const deliverables = sectionDeliverables ?? [{ key: 'design.md', revisionId: 'design-revision', digest: 'a'.repeat(64) }];
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
      deliverables: sectionDeliverables ?? [{ key: 'design.json', digest: 'b'.repeat(64) }] });
    audit = { id: 'audit-' + id, version: '1', manifestRef: refFor(candidate), manifestDigest: sha256(canonical(candidate)),
      behaviorChanged: false, findings };
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
    for (const pin of contractPins ? [] : input.contract_pins ?? []) snapshot.audit.push({ kind: 'contract.merged',
      projectId: project.id, contractId: pin.contractId, section: pin.section, mergeCommitSha: pin.commit });
  });
  const evidence = graph.nodes.find(node => node.id === row.gateNodeId);
  const subjectRefs = [subject(candidate), ...(audit ? [subject(audit)] : row.section ? [] : [subject(pr)])];
  const api = descriptor.createHostApi({ engine, runValidationDigest, resolveActor: ({ claimedActor }) => claimedActor,
    services: { getProjectConfig: async () => ({ ...project, automationMode: mode }), resolveDecisionEvidence: async () => [
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


async function verifiedProposal(h, { id = 'verify-g2', supersedes, contractPins, pullNumber } = {}) {
  h.config.githubApp = app;
  const configured = h.config.adlcProjects.project;
  h.config.adlcProjects.project = { ...configured, githubRepositoryId: repositoryId,
    contractPublication: { ...configured.contractPublication, g2: true, validatorId: 'adlc-g2-reference-v1' } };
  const row = mergeProducers.find(row => row.section === 'product');
  const f = await readyGate(h.db, h.companyId, row, { id, supersedes, contractPins, productBody: approvalBody(), now: () => approvalTime });
  await bindRuntime(h.db, h.companyId, f);
  const { decision } = await f.api.decideNode({ ...f.args, confirmation: true, confirmationDocument: {
    issueId: f.run.input.paperclipIssueId, key: 'approval-manifest', documentId: f.candidate.id,
    revisionId: f.candidate.version, body: JSON.stringify(f.candidate),
  } });
  await publish(f, decision, { pullNumber });
  await h.discover();
  const requests = () => listMergeRequests(h.db, h.companyId, f.run.id);
  assert.equal((await requests())[0].disposition, 'admitted');
  const frozen = decision.candidateBinding.candidates.find(ref => ref.artifactId === f.candidate.id);
  const approved = { ...manifestRef(f.candidate), bytes: Buffer.from(frozen.bytes, 'base64') };
  const receipts = async () => (await f.engine.getRun(f.run.id)).contractMerges ?? [];
  return { ...f, decision, requests, receipts, proposal: authoredProposal(decision, approved, supersedes &&
    { contractId: contractPins.find(pin => pin.section === 'product' && pin.commit === supersedes).contractId,
      folder: h.priorFolder, commit: supersedes }) };
}

function connectGitHub(h, proposal) {
  const github = publicationGitHub(project.repository, proposal);
  h.host.http = { fetch: github.fetch };
  h.host.secrets = { resolve: github.resolve };
  return github;
}

test('G2 worker verifies with four App permissions and posts once per head and result', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { proposal, requests } = await verifiedProposal(h);
  const github = connectGitHub(h, proposal);
  const success = { sha: head, state: 'success', description: 'Contract verified', context: 'polyforge/contract-g2' };
  await Promise.all([h.verify(), h.verify()]);
  await h.verify();
  assert.deepEqual(github.statuses, [success], JSON.stringify(h.warnings));
  assert.equal((await requests())[0].executionState, 'verified');

  github.commit(advanced, new Map([emptyIndex, ['README.md', Buffer.from('main moved')]]), [base]);
  github.main = advanced;
  await h.verify();
  assert.deepEqual(github.statuses, [success]);
  assert.ok(github.calls.some(call => call.path.endsWith('compare/' + advanced + '...' + head)));

  const newHead = 'e'.repeat(40);
  // Retain main's unrelated file when updating the proposal branch.
  github.commit(newHead, new Map([...proposal.tree, ['README.md', Buffer.from('main moved')]]), [advanced]);
  github.pr.head.sha = newHead;
  await h.verify();
  assert.deepEqual(github.statuses, [success, { ...success, sha: newHead }]);

  github.pr.head.ref = 'contract/wrong';
  await h.verify();
  await h.verify();
  assert.equal(github.statuses.length, 3);
  assert.deepEqual(github.statuses.at(-1), { ...success, sha: newHead, state: 'failure', description: 'contract-proposal-differs' });
  assert.equal((await requests())[0].executionReason, 'contract-proposal-differs');

  const badHead = 'f'.repeat(40);
  const badTree = new Map([...proposal.tree, ['README.md', Buffer.from('main moved')]]);
  badTree.set(root + '/' + proposal.folder + '/product/prd.md', Buffer.from('unapproved'));
  github.commit(badHead, badTree, [advanced]);
  github.pr.head = { sha: badHead, ref: 'contract/feat-orders_' + proposal.contractId };
  await h.verify();
  assert.deepEqual(github.statuses.at(-1), { ...success, sha: badHead, state: 'failure', description: 'contract-deliverable-invalid' });

  const invalidMain = '4'.repeat(40);
  github.commit(invalidMain, new Map([[root + '/INDEX.json', Buffer.from('{ invalid')]]), [advanced]);
  github.main = invalidMain;
  await h.verify();
  assert.deepEqual(github.statuses.at(-1), { ...success, sha: badHead, state: 'failure', description: 'contract-index-invalid' });
});

for (const method of ['merge commit', 'squash', 'multi-commit rebase', 'fast-forward']) {
  test('G2 observation records a ' + method + ' from main exactly once', postgresOnly, async t => {
    const h = await migratedHost(t);
    const { proposal, requests, receipts, decision } = await verifiedProposal(h);
    const github = connectGitHub(h, proposal);
    let parent = base;
    if (method === 'multi-commit rebase') {
      const before = '1'.repeat(40);
      const first = new Map(proposal.tree);
      first.delete(root + '/' + proposal.folder + '/product/prd.md');
      github.commit(before, first, [base]);
      github.commit(head, proposal.tree, [before]);
      github.commit(advanced, new Map([emptyIndex, ['README.md', Buffer.from('main changed')]]), [base]);
      parent = '2'.repeat(40);
      const unrelated = ['README.md', Buffer.from('main changed')];
      github.commit(parent, new Map([...first, unrelated]), [advanced]);
      github.commit(merge, new Map([...proposal.tree, unrelated]), [parent]);
      github.pr.commits = 2;
    } else if (method !== 'fast-forward') {
      github.commit(merge, proposal.tree, method === 'merge commit' ? [base, head] : [base]);
    }
    const landed = method === 'fast-forward' ? head : merge;
    const later = '3'.repeat(40);
    github.commit(later, proposal.tree, [landed]);
    github.main = later;
    Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: landed });

    await h.verify();
    await h.verify();
    assert.equal((await requests())[0].executionState, 'recorded', JSON.stringify(h.warnings));
    const [receipt] = await receipts();
    assert.equal((await receipts()).length, 1);
    assert.equal(receipt.decisionId, decision.id);
    assert.equal(receipt.mergeCommitSha, landed);
    assert.equal(receipt.folder, root + '/' + proposal.folder);
    assert.equal(receipt.lockDigest, sha256(proposal.tree.get(root + '/' + proposal.folder + '/contract.lock.json')));
    assert.deepEqual(github.statuses, []);
  });
}

for (const mismatch of ['bytes', 'extra file', 'ancestry']) {
  test('G2 merged-unverified records no receipt for a mismatch in ' + mismatch, postgresOnly, async t => {
    const h = await migratedHost(t);
    const { proposal, run, requests, receipts } = await verifiedProposal(h);
    const github = connectGitHub(h, proposal);
    const tree = new Map(proposal.tree);
    if (mismatch === 'bytes') tree.set(root + '/' + proposal.folder + '/product/prd.md', Buffer.from('wrong'));
    if (mismatch === 'extra file') {
      const extra = [root + '/' + proposal.folder + '/product/extra.md', Buffer.from('extra')];
      tree.set(...extra);
      github.commit(advanced, new Map([emptyIndex, extra]), [base]);
      github.main = advanced;
      await h.verify();
      assert.equal((await requests())[0].executionReason, 'contract-proposal-differs');
      assert.equal(github.statuses.at(-1)?.state, 'failure');
    }
    github.commit(merge, tree, [base]);
    github.main = mismatch === 'ancestry' ? base : merge;
    Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
    const cause = mismatch === 'bytes' ? 'contract-deliverable-invalid'
      : mismatch === 'extra file' ? 'contract-proposal-differs' : 'github-main-ancestry-unproven';
    if (mismatch === 'ancestry') {
      for (let tick = 0; tick < 10; tick++) await h.verify();
      assert.notEqual((await requests())[0].executionState, 'merged-unverified');
      assert.equal(h.warnings.filter(row => row.details.runId && row.details.cause === cause).length, 10);
      h.warnings.length = 0;
    }
    await h.verify();
    await h.verify();
    const [request] = await requests();
    assert.equal(request.executionState, 'merged-unverified', JSON.stringify(h.warnings));
    assert.equal(request.executionReason, cause);
    assert.deepEqual(await receipts(), []);
    assert.deepEqual(h.warnings.filter(row => row.details.runId), [
      { message: 'Merged G2 contract could not be verified', details: { runId: run.id, cause } },
    ]);
    if (mismatch !== 'ancestry') assert.equal(h.warnings.filter(row => row.details.cause === 'contract-unapproved').length, 1);
  });
}

for (const revision of ['missing', 'different']) {
  test('G2 re-admission refuses a ' + revision + ' confirmation revision', postgresOnly, async t => {
    const h = await migratedHost(t);
    const { proposal, store, decision, requests } = await verifiedProposal(h);
    const github = connectGitHub(h, proposal);
    await editSnapshot(store, snapshot => {
      const binding = snapshot.decisions.find(item => item.id === decision.id).candidateBinding;
      if (revision === 'missing') delete binding.document;
      else binding.document.revisionId = 'different';
    });
    await h.verify();
    assert.equal((await requests())[0].executionReason, 'publication-approval-stale');
    assert.deepEqual(github.statuses, [{ sha: head, state: 'failure', description: 'publication-approval-stale', context: 'polyforge/contract-g2' }]);
  });
}


test('G2 replacement keeps the original contract ID and records the new lock digest', postgresOnly, async t => {
  const h = await migratedHost(t);
  const first = await verifiedProposal(h);
  const github = connectGitHub(h, first.proposal);
  github.commit(merge, first.proposal.tree, [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  await h.verify();
  const [original] = await first.receipts();
  assert.ok(original, JSON.stringify(h.warnings));

  h.priorFolder = first.proposal.folder;
  const next = await verifiedProposal(h, { id: 'replacement', supersedes: merge, pullNumber: 20,
    contractPins: [{ section: 'product', contractId: original.contractId, commit: merge }] });
  const nextHead = 'e'.repeat(40);
  github.commit(nextHead, next.proposal.tree, [merge]);
  github.pr.head.sha = nextHead;
  Object.assign(github.pr, { state: 'open', merged: false, merge_commit_sha: null });
  await h.verify();
  assert.equal((await next.requests())[0].executionState, 'verified', JSON.stringify(h.warnings));

  github.commit(advanced, next.proposal.tree, [merge, nextHead]);
  github.main = advanced;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: advanced });
  await h.verify();
  const [replacement] = await next.receipts();
  assert.equal(replacement.contractId, original.contractId);
  assert.equal(replacement.supersedes, merge);
  assert.notEqual(replacement.lockDigest, original.lockDigest);
});

for (const condition of ['draft', 'non-main base', 'truncated contracts tree', 'transient HTTP failure']) {
  test('G2 open verification handles ' + condition, postgresOnly, async t => {
    const h = await migratedHost(t);
    const { proposal, requests } = await verifiedProposal(h);
    const github = connectGitHub(h, proposal);
    if (condition === 'draft') github.pr.draft = true;
    if (condition === 'non-main base') github.pr.base.ref = 'release';
    if (condition === 'truncated contracts tree') github.truncated = true;
    if (condition === 'transient HTTP failure') {
      h.host.http.fetch = (url, options) => url.includes('/git/blobs/')
        ? new Response(null, { status: 503 }) : github.fetch(url, options);
      await h.verify();
      assert.equal((await requests())[0].executionState, undefined);
      assert.deepEqual(github.statuses, []);
      assert.ok(h.warnings.some(({ details }) => details.cause === 'github-request-unavailable'));
      h.host.http.fetch = github.fetch;
      await h.verify();
      assert.equal(github.statuses.at(-1).state, 'success');
      return;
    }
    await h.verify();
    assert.equal(github.statuses.at(-1).state, 'failure');
    assert.equal(github.statuses.at(-1).description,
      condition === 'truncated contracts tree' ? 'github-contract-tree-truncated' : 'contract-proposal-differs');
  });
}

for (const cause of ['paused', 'stopped', 'frozen', 'rejected-admission', 'second active row']) {
  test('G2 withdraws success for ' + cause, postgresOnly, async t => {
    const h = await migratedHost(t);
    const first = await verifiedProposal(h);
    const github = connectGitHub(h, first.proposal);
    await h.verify();
    assert.equal(github.statuses.at(-1).state, 'success');
    if (cause === 'second active row') {
      await verifiedProposal(h, { id: 'another-row' });
      github.commit(advanced, first.proposal.tree, [head]);
      github.pr.head.sha = advanced;
    } else if (cause === 'rejected-admission') {
      await h.db.execute('UPDATE ' + h.namespace + ".adlc_merge_requests SET disposition='rejected-admission' WHERE run_id=$1",
        [first.run.id]);
    } else {
      await editSnapshot(first.store, state => {
        const run = state.runs[first.run.id];
        if (cause === 'frozen') {
          run.contract_pins = [{ section: 'product', contractId: first.proposal.contractId, commit: merge }];
          state.audit.push({ kind: 'contract.frozen', projectId: project.id, contractId: first.proposal.contractId });
        } else run.status = cause;
      });
    }
    await h.verify();
    await h.verify();
    assert.deepEqual(github.statuses.map(({ state, sha }) => [state, sha]),
      [['success', head], ['failure', cause === 'second active row' ? advanced : head]]);
  });
}

async function landFirstContract(h) {
  const first = await verifiedProposal(h);
  const github = connectGitHub(h, first.proposal);
  github.commit(merge, first.proposal.tree, [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  await h.verify();
  assert.equal((await first.receipts()).length, 1, JSON.stringify(h.warnings));
  return { first, github };
}

for (const status of ['running', 'completed']) {
  test('G2 reconciles a replacement receipt after an interrupted queue write in a ' + status + ' run', postgresOnly, async t => {
    const h = await migratedHost(t);
    const { first, github } = await landFirstContract(h);
    h.priorFolder = first.proposal.folder;
    const replacement = await verifiedProposal(h, { id: 'replacement', supersedes: merge, pullNumber: 20,
      contractPins: [{ section: 'product', contractId: first.proposal.contractId, commit: merge }] });
    await editSnapshot(replacement.store, state => { state.runs[replacement.run.id].status = status; });
    github.commit(advanced, replacement.proposal.tree, [merge]);
    github.main = advanced;
    Object.assign(github.pr, { merge_commit_sha: advanced });
    h.interrupt('adlc_merge_requests', h.companyId, 'recorded');
    await h.verify();
    assert.equal((await replacement.receipts()).length, 1, JSON.stringify(h.warnings));
    assert.notEqual((await replacement.requests())[0].executionState, 'recorded');
    if (status === 'completed') {
      await h.db.execute('UPDATE ' + h.namespace + ".adlc_merge_requests SET disposition='rejected-admission' WHERE run_id=$1",
        [replacement.run.id]);
    }
    await h.verify();
    assert.equal((await replacement.requests())[0].executionState, 'recorded');
    assert.equal((await replacement.receipts()).length, 1);
  });
}

test('G2 will not reuse a receipted PR under a different gate decision', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first } = await landFirstContract(h);
  const retry = await verifiedProposal(h, { id: 'gate-retry' });
  assert.notEqual(retry.decision.id, first.decision.id);
  await h.verify();
  assert.equal((await retry.requests())[0].executionState, 'merged-unverified');
  assert.equal((await retry.requests())[0].executionReason, 'github-pull-already-recorded');
  assert.deepEqual(await retry.receipts(), []);
});

test('G2 rechecks the graph revision inside receipt recording after approval is superseded', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  const github = connectGitHub(h, f.proposal);
  github.commit(merge, f.proposal.tree, [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  const record = GraphEngine.prototype.recordContractMerge;
  GraphEngine.prototype.recordContractMerge = async function (...args) {
    await editSnapshot(f.store, state => state.decisions.push({ id: 'new-decision', supersedes: f.decision.id }));
    return record.apply(this, args);
  };
  try { await h.verify(); }
  finally { GraphEngine.prototype.recordContractMerge = record; }
  assert.deepEqual(await f.receipts(), []);
  assert.equal((await f.requests())[0].executionReason, 'publication-approval-stale');
  assert.deepEqual(await f.receipts(), []);
});

test('G2 receipts its own entry even when an earlier PR commit drops a different contract entry', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const second = await verifiedProposal(h, { id: 'second-contract', pullNumber: 20 });
  const intermediate = '1'.repeat(40);
  github.commit(intermediate, new Map([...first.proposal.tree, emptyIndex]), [merge]);
  const tree = new Map([...first.proposal.tree, ...second.proposal.tree]);
  const secondHead = '2'.repeat(40);
  github.commit(secondHead, tree, [intermediate]);
  github.commit(advanced, tree, [merge, secondHead]);
  github.main = advanced;
  Object.assign(github.pr, { commits: 2, merge_commit_sha: advanced,
    head: { sha: secondHead, ref: 'contract/feat-orders_' + second.proposal.contractId } });
  await h.verify();
  assert.equal((await second.requests())[0].executionState, 'recorded', JSON.stringify(h.warnings));
  assert.equal((await second.receipts()).length, 1);
  assert.ok(h.warnings.some(({ details }) => details.cause === 'contract-unapproved' &&
    details.folder === root + '/' + first.proposal.folder));
  await assert.rejects(checkG5Contract(first, tree, advanced), { code: 'contract-drift' });
});

async function checkG5Contract(first, tree, baseSha, history = new Map([[merge, first.proposal.tree]])) {
  const pin = { section: 'product', contractId: first.proposal.contractId, commit: merge };
  const runId = 'g5-bytes', pullNumber = 30, headSha = '6'.repeat(40), mergeCommitSha = '7'.repeat(40);
  const type = 'implementation-merge-approval';
  const manifest = { id: 'verification', revisionId: '1', bytes: JSON.stringify({
    checkoutSha: headSha, expectedScenarios: ['AC-7'], results: [],
  }) };
  const candidateRefs = [{ id: 'pr:' + project.repository + '#' + pullNumber, version: headSha },
    { id: manifest.id, version: manifest.revisionId }];
  const decision = { id: 'g5-decision', runId, nodeId: 'gate', type, status: 'decided', outcome: 'accept', actor: owner,
    evidence: [{ subjectRefs: candidateRefs.map(subject) }] };
  const run = { id: runId, input: { projectId: project.id }, contract_pins: [pin], status: 'completed', mode: 'manual',
    graph: { nodes: [{ id: 'gate', decisionType: type, candidateNodes: ['prepare'] }] },
    nodeStates: { prepare: { status: 'completed', artifacts: candidateRefs, attempts: [] },
      gate: { status: 'completed', attempts: [{ decisionId: decision.id }] } } };
  await editSnapshot(first.store, state => {
    state.runs[runId] = run;
    state.decisions.push(decision);
  });
  const github = {
    getMergeReceipt: async () => null, getRef: async () => baseSha,
    getPullSnapshot: async () => ({ headSha, baseSha, baseRef: 'main', changes: [{ path: 'src/app.mjs' }] }),
    loadValidator: async () => ({
      async readVerificationCriteria(input) {
        const files = await readApprovedContract(input, (path, ref) => (ref ? history.get(ref) : tree)?.get(path));
        return JSON.parse(files.get(root + '/' + first.proposal.folder + '/product/criteria.json'));
      },
      judgeVerificationManifest: () => ({ status: 'pass', gaps: [] }),
    }),
    getCheckStatus: async () => [{ name: 'build', status: 'completed', conclusion: 'success' }],
    merge: async (_request, authorize) => { await authorize(); return mergeCommitSha; },
  };
  return mergeImplementation({ engine: first.engine, github, project, runId, pullNumber, manifest, decisionId: decision.id });
}

const sectionHead = '1'.repeat(40), sectionMerge = '2'.repeat(40);
const sectionFiles = new Map([['design.md', Buffer.from('# Reviewed design\n')]]);

async function sectionProposal(h, first, github, { section = 'technical', id = 'publish-' + section,
  pullNumber = 21, headSha = sectionHead, automationMode = 'manual', automatic = false, findings, files = sectionFiles,
  configured = true, predecessor = first.proposal.tree, supersedes = null, baseSha = merge, deliverables,
  contractPins = [{ section: 'product', contractId: first.proposal.contractId, commit: merge }] } = {}) {
  const gate = section === 'design' ? 'g3' : 'g4';
  const config = h.config.adlcProjects.project;
  config.ctoId = 'cto';
  config.automationMode = automationMode;
  config.contractPublication[gate] = configured;
  const row = mergeProducers.find(row => row.section === section);
  const f = await readyGate(h.db, h.companyId, row, {
    id, contractPins, mode: automatic ? 'assisted' : 'manual', now: () => approvalTime, findings,
    sectionDeliverables: deliverables ?? Array.from(files, ([key, bytes]) => ({
      key, digest: sha256(bytes), ...(section === 'technical' && { revisionId: key + '-revision' }),
    })),
  });
  await bindRuntime(h.db, h.companyId, f);
  const { decision } = section === 'design' && !automatic ? await approveEscalatedDesign(f)
    : await f.api.decideNode({ ...f.args, ...(automatic && { actor: agent('design-director') }) });
  await publish(f, decision, { pullNumber });
  await h.discover();
  const request = async () => (await listMergeRequests(h.db, h.companyId, f.run.id))[0];
  assert.equal((await request()).disposition, 'admitted');
  const receipts = async () => (await f.engine.getRun(f.run.id)).contractMerges ?? [];

  const folder = root + '/' + first.proposal.folder;
  const lockPath = folder + '/contract.lock.json';
  const lock = JSON.parse(predecessor.get(lockPath));
  const tree = new Map(predecessor);
  lock.files = lock.files.filter(file => {
    if (file.section !== section || file.path === 'design/interaction.md') return true;
    tree.delete(folder + '/' + file.path);
    return false;
  });
  const frozen = decision.candidateBinding.candidates.find(ref => ref.artifactId === f.candidate.id);
  lock.sections[section] = { approvalManifest: { ...manifestRef(f.candidate), digest: frozen.digest },
    decisionId: decision.id, approvedAt: new Date(decision.at).toISOString(), supersedes };
  for (const [key, bytes] of files) {
    const path = section + '/' + key;
    tree.set(folder + '/' + path, bytes);
    lock.files.push({ path, digest: sha256(bytes), section });
  }
  lock.files.sort((a, b) => a.path < b.path ? -1 : Number(a.path > b.path));
  tree.set(lockPath, canonicalPublicationJson(lock));
  const pr = { ...github.pr, state: 'open', merged: false, merge_commit_sha: null, head: { ...github.pr.head, sha: headSha } };
  github.pulls.set(pullNumber, pr);
  const propose = (candidate = tree) => github.commit(headSha, candidate, [baseSha]);
  const land = (landed = tree, commit = sectionMerge) => {
    github.commit(commit, landed, [github.main, headSha]);
    github.main = commit;
    Object.assign(pr, { state: 'closed', merged: true, merge_commit_sha: commit });
  };
  propose();
  return { ...f, decision, request, receipts, tree, folder, lockPath, propose, land,
    status: () => github.statuses.findLast(status => status.sha === headSha && status.context === 'polyforge/contract-' + gate) };
}

test('G4 verifies and receipts a human merge, advances the G5 binding, and survives G2 replacement', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g4 = await sectionProposal(h, first, github);
  await h.verify();
  assert.deepEqual(g4.status(), { sha: sectionHead, state: 'success', context: 'polyforge/contract-g4', description: 'Contract verified' });
  assert.deepEqual(await g4.receipts(), []);
  g4.land();
  h.interrupt('adlc_merge_requests', h.companyId, 'recorded');
  await h.verify();
  const [receipt] = await g4.receipts();
  assert.equal(receipt.section, 'technical');
  assert.equal(receipt.folder, g4.folder);
  assert.equal(receipt.decisionId, g4.decision.id);
  assert.equal(receipt.lockDigest, sha256(g4.tree.get(g4.lockPath)));
  assert.equal(receipt.mergeCommitSha, sectionMerge);
  assert.equal(receipt.supersedes, null);
  assert.equal((await g4.request()).executionState, 'verified');
  await h.verify();
  assert.equal((await g4.request()).executionState, 'recorded');
  assert.deepEqual(await g4.receipts(), [receipt]);

  const history = new Map([[merge, first.proposal.tree], [sectionMerge, g4.tree]]);
  const technicalPath = g4.folder + '/technical/design.md';
  const drifted = new Map(g4.tree).set(technicalPath, Buffer.from('# Edited after approval\n'));
  await assert.rejects(checkG5Contract(first, drifted, advanced, history), { code: 'contract-drift' });
  assert.equal((await checkG5Contract(first, g4.tree, sectionMerge, history)).baseSha, sectionMerge);

  h.priorFolder = first.proposal.folder;
  const next = await verifiedProposal(h, { id: 'g2-after-g4', supersedes: merge, pullNumber: 20,
    contractPins: [{ section: 'product', contractId: first.proposal.contractId, commit: merge }] });
  const nextLock = JSON.parse(next.proposal.tree.get(g4.lockPath));
  const g4Lock = JSON.parse(g4.tree.get(g4.lockPath));
  nextLock.sections.technical = g4Lock.sections.technical;
  nextLock.files.push(g4Lock.files.at(-1));
  const nextTree = new Map([...next.proposal.tree, [technicalPath, sectionFiles.get('design.md')],
    [g4.lockPath, canonicalPublicationJson(nextLock)]]);
  github.commit(advanced, nextTree, [sectionMerge]);
  github.pulls.set(20, { ...github.pr, state: 'open', merged: false, merge_commit_sha: null,
    head: { ...github.pr.head, sha: advanced } });
  await h.verify();
  assert.equal((await next.requests())[0].executionState, 'verified', JSON.stringify(h.warnings));
  github.main = advanced;
  Object.assign(github.pulls.get(20), { state: 'closed', merged: true, merge_commit_sha: advanced });
  await h.verify();
  assert.equal((await next.receipts())[0].lockDigest, sha256(nextTree.get(g4.lockPath)));
});

test('G3 accepts the human owner on the auto gate and rechecks the approver before recording', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g3 = await sectionProposal(h, first, github, { section: 'design' });
  assert.equal(g3.decision.type, 'g3-visual-auto-approval');
  await h.verify();
  assert.equal(g3.status()?.state, 'success', JSON.stringify(h.warnings));
  g3.land();
  h.config.adlcProjects.project.ownerId = 'different-owner';
  await h.verify();
  assert.deepEqual(await g3.receipts(), []);
  assert.equal((await g3.request()).executionState, 'merged-unverified');
  assert.equal(g3.status()?.description, 'publication-unauthorized');
});

test('G3 authorizes an assisted design director only with the bound, passing audit', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g3 = await sectionProposal(h, first, github, { section: 'design', automatic: true, automationMode: 'assisted',
    findings: [{ severity: 'P3' }] });
  await editSnapshot(g3.store, state => {
    state.decisions.find(record => record.id === g3.decision.id).evidence.forEach(item => {
      item.subjectRefs = item.subjectRefs.filter(ref => ref.artifactId !== g3.audit.id);
    });
  });
  await h.verify();
  assert.equal(g3.status()?.description, 'publication-unauthorized');
  await editSnapshot(g3.store, state => {
    state.decisions.find(record => record.id === g3.decision.id).evidence = g3.decision.evidence;
  });
  h.config.adlcProjects.project.automationMode = 'manual';
  await h.verify();
  assert.equal(g3.status()?.description, 'publication-unauthorized');
  h.config.adlcProjects.project.automationMode = 'assisted';
  await h.verify();
  assert.equal(g3.status()?.state, 'success', JSON.stringify(h.warnings));
  g3.land();
  await h.verify();
  assert.equal((await g3.receipts())[0].section, 'design');
});

test('section worker refuses legacy unauthorized approvals and stale pins', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const auto = await sectionProposal(h, first, github, { section: 'design', automatic: true });
  const owned = await sectionProposal(h, first, github, { section: 'design',
    pullNumber: 22, headSha: '3'.repeat(40), id: 'owner-design' });
  const technical = await sectionProposal(h, first, github, { pullNumber: 23, headSha: '4'.repeat(40),
    automationMode: 'assisted' });
  const config = h.config.adlcProjects.project;
  await h.verify();
  for (const fixture of [auto, owned, technical]) assert.equal(fixture.status()?.state, 'success', JSON.stringify(h.warnings));
  const baseline = await first.store.read();

  function editAudit(run, decision, editManifest, editAudit) {
    const output = run.nodeStates[auto.row.candidateNodeId].attempts.at(-1).output.creativeArtifacts;
    const manifest = output.visual_manifest;
    editManifest?.(manifest);
    const frozen = decision.candidateBinding.candidates.find(ref => ref.artifactId === manifest.id);
    const freeze = (value, binding) => {
      const bytes = Buffer.from(canonical(value));
      Object.assign(binding, { bytes: bytes.toString('base64'), digest: sha256(bytes) });
    };
    freeze(manifest, frozen);
    const audit = run.nodeStates['design-audit'].attempts.at(-1).output.creativeArtifacts.visual_audit;
    audit.manifestDigest = frozen.digest;
    editAudit?.(audit);
    freeze(audit, decision.candidateBinding.audit);
  }

  const cases = [
    ['actor without roles', technical, ({ decision }) => { delete decision.actor.roles; }],
    ['decision without evidence', auto, ({ decision }) => { delete decision.evidence; }],
    ['actor roles as a string', technical, ({ decision }) => { decision.actor.roles = 'cto'; }],
    ['decision evidence as an object', auto, ({ decision }) => { decision.evidence = {}; }],
    ['evidence subjectRefs as objects', auto, ({ decision }) => {
      for (const item of decision.evidence) item.subjectRefs = {};
    }],
    ['supplemental evidence without subjectRefs', technical, ({ decision }) => {
      decision.evidence.push({ kind: 'review-note', summary: 'Supplemental note' }, { kind: 'conflict_resolution', decisionId: 'other' });
    }, null],
    ['out-of-system manifest', auto, ({ run, decision }) => {
      editAudit(run, decision, manifest => { manifest.systemScope = 'out-of-system'; });
    }],
    ['manifest behavior change', auto, ({ run, decision }) => {
      editAudit(run, decision, manifest => { manifest.behaviorChanged = true; });
    }],
    ['audit behavior change', auto, ({ run, decision }) => {
      editAudit(run, decision, null, audit => { audit.behaviorChanged = true; });
    }],
    ...['P0', 'P1'].map(severity => [severity + ' audit finding', auto, ({ run, decision }) => {
      editAudit(run, decision, null, audit => { audit.findings = [{ severity }]; });
    }]),
    ['audit manifest-digest mismatch', auto, ({ run, decision }) => {
      editAudit(run, decision, null, audit => { audit.manifestDigest = '0'.repeat(64); });
    }],
    ['audit payload mismatch', auto, ({ run }) => {
      run.nodeStates['design-audit'].attempts.at(-1).output.creativeArtifacts.visual_audit.findings = [{ severity: 'P3' }];
    }],
    ['incomplete design-audit', auto, ({ run }) => { run.nodeStates['design-audit'].status = 'pending'; }],
    ['agent on g3-visual-approval', auto, ({ decision }) => { decision.type = 'g3-visual-approval'; }],
    ['agent posing as the owner', owned, ({ decision }) => { decision.actor.kind = 'agent'; }],
    ['wrong ctoId', technical, () => { config.ctoId = 'other-cto'; }],
    ['wrong CTO role', technical, ({ decision }) => { decision.actor.roles = ['architect']; }],
    ['wrong CTO actor kind', technical, ({ decision }) => { decision.actor.kind = 'human'; }],
    ['G4 pin update after approval', technical, ({ state, run }) => {
      state.audit.push({ kind: 'run.contract_pins_updated', runId: run.id });
    }, 'contract-supersedes-stale'],
  ];
  for (const [name, fixture, change, cause = 'publication-unauthorized'] of cases) {
    await t.test(name, async () => {
      await editSnapshot(first.store, state => {
        const run = state.runs[fixture.run.id];
        const decision = state.decisions.find(record => record.id === fixture.decision.id);
        change({ state, run, decision });
      });
      try {
        await h.verify();
        if (cause === null) {
          assert.equal(fixture.status()?.state, 'success', JSON.stringify(h.warnings));
        } else {
          assert.equal((await fixture.request()).executionReason, cause, JSON.stringify(h.warnings));
          assert.equal(fixture.status()?.description, cause);
        }
      } finally {
        config.ctoId = 'cto';
        await editSnapshot(first.store, state => {
          state.runs = baseline.runs;
          state.decisions = baseline.decisions;
          state.audit = baseline.audit;
        });
      }
    });
  }
});

test('section verification rejects unapproved bytes, paths, and product edits', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g3 = await sectionProposal(h, first, github, { section: 'design' });
  const changed = Buffer.from('# Unapproved change\n');
  const modifiedLock = JSON.parse(g3.tree.get(g3.lockPath));
  modifiedLock.sections.product.decisionId = 'other-approval';
  for (const [path, bytes, cause] of [
    [g3.folder + '/design/design.md', changed, 'contract-deliverable-invalid'],
    [g3.folder + '/design/extra.md', changed, 'contract-proposal-differs'],
    ['src/app.mjs', changed, 'contract-proposal-differs'],
    [g3.folder + '/design/interaction.md', changed, 'contract-proposal-differs'],
    [g3.folder + '/product/prd.md', changed, 'contract-proposal-differs'],
    [g3.lockPath, canonicalPublicationJson(modifiedLock), 'contract-proposal-differs'],
    [root + '/INDEX.json', Buffer.from('[]\n'), 'contract-proposal-differs'],
  ]) {
    g3.propose(new Map(g3.tree).set(path, bytes));
    await h.verify();
    assert.equal(g3.status()?.description, cause, path);
  }
  const g4 = await sectionProposal(h, first, github, { files: new Map([['nested/CoDeOwNeRs', changed]]) });
  const interaction = await sectionProposal(h, first, github, { section: 'design', id: 'claim-interaction',
    files: new Map([['Interaction.MD', changed]]), pullNumber: 22, headSha: '3'.repeat(40) });
  const duplicate = await sectionProposal(h, first, github, { section: 'design', id: 'duplicate-deliverable',
    files: new Map([['design.md', changed], ['Design.md', changed]]), pullNumber: 23, headSha: '4'.repeat(40) });
  const ciPath = await sectionProposal(h, first, github, { id: 'ci-path', pullNumber: 24, headSha: '5'.repeat(40) });
  h.config.adlcProjects.project.ciPaths = [ciPath.folder + '/technical/design.md'];
  await h.verify();
  for (const invalid of [g4, interaction, duplicate]) {
    assert.equal(invalid.status()?.description, 'contract-deliverable-invalid');
  }
  assert.equal(ciPath.status()?.description, 'contract-proposal-differs');
});

test('G4 section replacement must remove dropped files and records its predecessor', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g4 = await sectionProposal(h, first, github, { files: new Map([['old/design.md', sectionFiles.get('design.md')]]) });
  g4.land();
  await h.verify();
  assert.equal((await g4.request()).executionState, 'recorded');
  const next = await sectionProposal(h, first, github, { id: 'replace-g4', pullNumber: 22, headSha: advanced,
    baseSha: sectionMerge, predecessor: g4.tree, supersedes: sectionMerge,
    files: new Map([['new.md', Buffer.from('# New approved file\n')]]) });
  const dropped = g4.folder + '/technical/old/design.md';
  next.propose(new Map(next.tree).set(dropped, g4.tree.get(dropped)));
  await h.verify();
  assert.equal(next.status()?.description, 'contract-proposal-differs');
  next.propose();
  await h.verify();
  assert.equal(next.status()?.state, 'success', JSON.stringify(h.warnings));
  next.land(next.tree, '3'.repeat(40));
  await h.verify();
  assert.equal((await next.receipts())[0].supersedes, sectionMerge);
});

test('G3 requires exactly one valid product pin and a current product receipt', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g3 = await sectionProposal(h, first, github, { section: 'design', contractPins: [] });
  await h.verify();
  assert.equal(g3.status()?.description, 'contract-product-missing');
  const pin = { section: 'product', contractId: first.proposal.contractId, commit: merge };
  for (const invalidPins of [[{ ...pin, commit: 'invalid' }], [pin, { ...pin, contractId: 'PRC-OTHER' }]]) {
    await editSnapshot(g3.store, state => { state.runs[g3.run.id].input.contract_pins = invalidPins; });
    await h.verify();
    assert.equal(g3.status()?.description, 'contract-product-missing');
  }
  await editSnapshot(g3.store, state => {
    const run = state.runs[g3.run.id];
    run.input.contract_pins = run.contract_pins = [pin];
    const receipt = state.audit.find(event => event.kind === 'contract.merged');
    receipt.repository = 'other/repository';
  });
  await h.verify();
  assert.equal(g3.status()?.description, 'contract-product-missing');
  await editSnapshot(g3.store, state => {
    const receipt = state.audit.find(event => event.kind === 'contract.merged');
    receipt.repository = project.repository;
    state.audit.push({ ...receipt, mergeCommitSha: advanced, supersedes: merge });
  });
  await h.verify();
  assert.equal(g3.status()?.description, 'contract-supersedes-stale');
});

test('G4 keeps its product pin when another contract at the same commit is superseded', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  await editSnapshot(first.store, state => {
    const product = state.audit.find(event => event.kind === 'contract.merged');
    const other = { ...product, contractId: 'PRC-OTHER', pullNumber: 40 };
    state.audit.push(other, { ...other, pullNumber: 41, mergeCommitSha: advanced, supersedes: merge });
  });
  const g4 = await sectionProposal(h, first, github);
  await h.verify();
  assert.equal(g4.status()?.state, 'success', JSON.stringify(h.warnings));
});

test('G4 verifies and records with an unchanged non-Latin row for another contract in the index', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const indexPath = root + '/INDEX.json';
  const index = JSON.parse(first.proposal.tree.get(indexPath));
  index.push({ ...index[0], contractId: 'PRC-OTHER', epic: '\u5546\u54c1' });
  const predecessor = new Map(first.proposal.tree).set(indexPath, canonicalPublicationJson(index));
  github.commit(advanced, predecessor, [merge]);
  github.main = advanced;
  const g4 = await sectionProposal(h, first, github, { predecessor, baseSha: advanced });
  await h.verify();
  assert.equal(g4.status()?.state, 'success', JSON.stringify(h.warnings));
  g4.land();
  await h.verify();
  assert.equal((await g4.request()).executionState, 'recorded');
});

for (const transient of [false, true]) {
  test('G3 records after the G4 merge it builds on' + (transient ? ' when observing G4 retries' : ''), postgresOnly, async t => {
    const h = await migratedHost(t);
    const { first, github } = await landFirstContract(h);
    const g4 = await sectionProposal(h, first, github);
    const g3 = await sectionProposal(h, first, github, { section: 'design', predecessor: g4.tree,
      pullNumber: 22, headSha: '3'.repeat(40), baseSha: sectionMerge });
    g4.land();
    g3.land(g3.tree, '4'.repeat(40));
    if (transient) {
      h.host.http.fetch = (url, options) => url.endsWith('/pulls/21')
        ? new Response(null, { status: 503 }) : github.fetch(url, options);
    }
    await h.verify();
    if (transient) {
      assert.equal((await g4.request()).executionState, undefined);
      assert.ok(h.warnings.some(({ details }) => details.runId === g4.run.id && details.cause === 'github-request-unavailable'));
      assert.deepEqual(await g4.receipts(), []);
      assert.equal((await g3.request()).executionState, undefined);
      h.host.http.fetch = github.fetch;
      await h.verify();
    }
    assert.equal((await g4.request()).executionState, 'recorded');
    assert.notEqual((await g3.request()).executionState, 'merged-unverified');
    await h.verify();
    assert.equal((await g3.request()).executionState, 'recorded');
    const { audit } = await first.store.read();
    assert.deepEqual(audit.filter(event => event.kind === 'contract.merged').map(event => event.section),
      ['product', 'technical', 'design']);
  });
}

test('G4 waits for G3 that merges after being observed open', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g3 = await sectionProposal(h, first, github, { section: 'design' });
  const g4 = await sectionProposal(h, first, github, { predecessor: g3.tree, baseSha: sectionMerge,
    pullNumber: 22, headSha: '3'.repeat(40) });
  let landed = false;
  h.host.http.fetch = async (url, options) => {
    const response = await github.fetch(url, options);
    if (!landed && url.endsWith('/pulls/21')) {
      landed = true;
      g3.land();
      g4.land(g4.tree, '4'.repeat(40));
    }
    return response;
  };
  await h.verify();
  assert.equal((await g4.request()).executionState, undefined);
  assert.deepEqual(await g4.receipts(), []);
  await h.verify();
  assert.equal((await g4.request()).executionState, 'recorded');
  const { audit } = await first.store.read();
  assert.deepEqual(audit.filter(event => event.kind === 'contract.merged').map(event => event.section),
    ['product', 'design', 'technical']);
});

test('a stopped G2 replacement withdraws success while its merged G4 predecessor is paused', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g4 = await sectionProposal(h, first, github);
  h.priorFolder = first.proposal.folder;
  const g2 = await verifiedProposal(h, { id: 'stopped-replacement', supersedes: merge, pullNumber: 20,
    contractPins: [{ section: 'product', contractId: first.proposal.contractId, commit: merge }] });
  const replacementHead = '3'.repeat(40);
  github.commit(replacementHead, g2.proposal.tree, [merge]);
  const pr = { ...github.pr, state: 'open', merged: false, merge_commit_sha: null,
    head: { ...github.pr.head, sha: replacementHead } };
  github.pulls.set(20, pr);
  const status = () => github.statuses.findLast(status => status.sha === replacementHead);
  await h.verify();
  assert.equal(status()?.state, 'success', JSON.stringify(h.warnings));

  g4.land();
  github.commit(advanced, g2.proposal.tree, [sectionMerge, replacementHead]);
  github.main = advanced;
  Object.assign(pr, { state: 'closed', merged: true, merge_commit_sha: advanced });
  await editSnapshot(first.store, state => {
    state.runs[g4.run.id].status = 'paused';
    state.runs[g2.run.id].status = 'stopped';
  });
  await h.verify();
  assert.equal((await g2.requests())[0].executionState, 'merged-unverified');
  assert.equal((await g2.requests())[0].executionReason, 'publication-run-on-hold');
  assert.equal(status()?.state, 'failure');
  assert.equal(status()?.description, 'publication-run-on-hold');
  assert.deepEqual(await g2.receipts(), []);
  assert.equal((await g4.engine.getRun(g4.run.id)).status, 'paused');
  assert.deepEqual(await g4.receipts(), []);
});

test('G2 uses the product pin selected by supersedes to wait for G4', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g4 = await sectionProposal(h, first, github);
  h.priorFolder = first.proposal.folder;
  const g2 = await verifiedProposal(h, { id: 'replacement-with-two-pins', supersedes: merge, pullNumber: 20,
    contractPins: [{ section: 'product', contractId: 'PRC-OTHER', commit: base },
      { section: 'product', contractId: first.proposal.contractId, commit: merge }] });
  const replacementHead = '3'.repeat(40);
  github.commit(replacementHead, g2.proposal.tree, [merge]);
  const pr = { ...github.pr, state: 'open', merged: false, merge_commit_sha: null,
    head: { ...github.pr.head, sha: replacementHead } };
  github.pulls.set(20, pr);
  await h.verify();
  assert.equal((await g2.requests())[0].executionState, 'verified', JSON.stringify(h.warnings));
  const postedStatus = github.statuses.findLast(status => status.sha === replacementHead);
  assert.equal(postedStatus?.state, 'success');

  g4.land();
  const lock = JSON.parse(g2.proposal.tree.get(g4.lockPath));
  const technicalLock = JSON.parse(g4.tree.get(g4.lockPath));
  const technicalPath = g4.folder + '/technical/design.md';
  lock.sections.technical = technicalLock.sections.technical;
  lock.files.push(technicalLock.files.at(-1));
  const replacementTree = new Map(g2.proposal.tree)
    .set(technicalPath, g4.tree.get(technicalPath))
    .set(g4.lockPath, canonicalPublicationJson(lock));
  github.commit(advanced, replacementTree, [sectionMerge, replacementHead]);
  github.main = advanced;
  Object.assign(pr, { state: 'closed', merged: true, merge_commit_sha: advanced });

  await h.verify();
  assert.equal((await g2.requests())[0].executionState, 'verified');
  assert.deepEqual(github.statuses.filter(status => status.sha === replacementHead), [postedStatus]);
  assert.deepEqual(h.warnings.filter(({ details }) => details.runId === g2.run.id), [{
    message: 'Contract verification is waiting for an earlier merge',
    details: { runId: g2.run.id, predecessorRunId: g4.run.id, cause: 'contract-proposal-differs' },
  }]);
  assert.deepEqual(await g2.receipts(), []);
  assert.equal((await g4.request()).executionState, 'recorded');
  await h.verify();
  assert.equal((await g2.requests())[0].executionState, 'recorded');
  const [receipt] = await g2.receipts();
  assert.equal(receipt.contractId, first.proposal.contractId);
  assert.equal(receipt.supersedes, merge);
});

test('G4 withdraws success when different bytes land with no unrecorded predecessor', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g4 = await sectionProposal(h, first, github);
  await h.verify();
  assert.equal(g4.status()?.state, 'success');
  g4.land(new Map(g4.tree).set(g4.folder + '/technical/design.md', Buffer.from('# Unapproved change\n')));
  await h.verify();
  assert.equal((await g4.request()).executionState, 'merged-unverified');
  assert.equal((await g4.request()).executionReason, 'contract-proposal-differs');
  assert.deepEqual(await g4.receipts(), []);
  assert.equal(g4.status()?.state, 'failure');
});

test('a stale G4 approval cannot replace a section receipt recorded after approval', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const earlier = await sectionProposal(h, first, github, { id: 'earlier-approved' });
  const newer = await sectionProposal(h, first, github, { id: 'newer-approved', pullNumber: 22, headSha: advanced,
    files: new Map([['design.md', Buffer.from('# Newer approval\n')]]) });
  await h.verify();
  assert.equal(earlier.status()?.state, 'success');
  assert.equal(newer.status()?.state, 'success');
  newer.land();
  // Leave the earlier approval's success in place until the worker observes its merge.
  h.host.http.fetch = (url, options) => url.endsWith('/pulls/21')
    ? new Response(null, { status: 503 }) : github.fetch(url, options);
  await h.verify();
  assert.equal((await newer.request()).executionState, 'recorded');
  assert.equal(earlier.status()?.state, 'success');
  h.host.http.fetch = github.fetch;

  const lock = JSON.parse(earlier.tree.get(earlier.lockPath));
  lock.sections.technical.supersedes = sectionMerge;
  earlier.land(new Map(earlier.tree).set(earlier.lockPath, canonicalPublicationJson(lock)), '3'.repeat(40));
  await h.verify();
  assert.equal((await earlier.request()).executionState, 'merged-unverified');
  assert.equal((await earlier.request()).executionReason, 'contract-supersedes-stale');
  assert.deepEqual(await earlier.receipts(), []);
  assert.equal(earlier.status()?.state, 'failure');
  assert.equal(earlier.status()?.description, 'contract-supersedes-stale');
});

test('G4 refuses a stale product pin when the receipt revision fence detects a concurrent publication', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g4 = await sectionProposal(h, first, github);
  await h.verify();
  assert.equal(g4.status()?.state, 'success');
  g4.land();
  const record = GraphEngine.prototype.recordContractMerge;
  GraphEngine.prototype.recordContractMerge = async function (...args) {
    await editSnapshot(g4.store, state => {
      const current = state.audit.find(event => event.kind === 'contract.merged' && event.section === 'product');
      state.audit.push({ ...current, pullNumber: 22, mergeCommitSha: advanced, supersedes: merge });
    });
    return record.apply(this, args);
  };
  try { await h.verify(); }
  finally { GraphEngine.prototype.recordContractMerge = record; }
  assert.equal((await g4.request()).executionReason, 'contract-supersedes-stale');
  assert.equal((await g4.request()).executionState, 'merged-unverified');
  assert.deepEqual(await g4.receipts(), []);
  assert.equal(g4.status()?.description, 'contract-supersedes-stale');
});

test('G2 and G4 statuses stay in their contexts and disabled G3 and G4 post nothing', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const g4 = await sectionProposal(h, first, github, { configured: false });
  const g3 = await sectionProposal(h, first, github, { id: 'disabled-g3', section: 'design', configured: false,
    pullNumber: 22, headSha: '3'.repeat(40) });
  const g2 = await verifiedProposal(h, { id: 'other-g2', pullNumber: 20 });
  const indexPath = root + '/INDEX.json';
  const index = [...JSON.parse(first.proposal.tree.get(indexPath)), ...JSON.parse(g2.proposal.tree.get(indexPath))]
    .sort((a, b) => a.contractId.localeCompare(b.contractId));
  github.commit(advanced, new Map([...first.proposal.tree, ...g2.proposal.tree]).set(indexPath, canonicalPublicationJson(index)),
    [merge]);
  github.pulls.set(20, { ...github.pr, state: 'open', merged: false, merge_commit_sha: null,
    head: { sha: advanced, ref: 'contract/feat-orders_' + g2.proposal.contractId } });
  await h.verify();
  assert.deepEqual(github.statuses.map(({ sha, context }) => [sha, context]), [[advanced, 'polyforge/contract-g2']]);
  assert.equal(g4.status(), undefined);
  assert.equal(g3.status(), undefined);
  h.config.adlcProjects.project.contractPublication.g4 = true;
  await h.verify();
  assert.deepEqual(github.statuses.map(({ sha, context, state }) => [sha, context, state]), [
    [advanced, 'polyforge/contract-g2', 'success'], [sectionHead, 'polyforge/contract-g4', 'success'],
  ]);
});

test('G2 retries unavailable merge ancestry and records when it becomes visible', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  const github = connectGitHub(h, f.proposal);
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  await h.verify();
  assert.deepEqual(h.warnings, [{ message: 'G2 contract verification will retry',
    details: { runId: f.run.id, cause: 'github-main-ancestry-unproven' } }]);
  assert.deepEqual(await f.receipts(), []);
  github.commit(merge, f.proposal.tree, [base, head]);
  github.main = merge;
  await h.verify();
  assert.equal((await f.requests())[0].executionState, 'recorded');
  assert.equal((await f.receipts()).length, 1);
});


test('G2 skips malformed rows before a valid row and still scans unapproved folders', postgresOnly, async t => {
  const h = await migratedHost(t);
  const bad = await verifiedProposal(h, { id: 'aaa-bad', pullNumber: 11 });
  const missing = await verifiedProposal(h, { id: 'aaa-missing', pullNumber: 12 });
  const good = await verifiedProposal(h, { id: 'zzz-good' });
  await h.db.execute('UPDATE ' + h.namespace + ".adlc_merge_requests SET disposition='rejected-admission', request_json=jsonb_set(request_json, '{payload}', 'null'::jsonb) WHERE run_id=$1", [bad.run.id]);
  await h.db.execute('UPDATE ' + h.namespace + ".adlc_merge_requests SET request_json='null'::jsonb WHERE run_id=$1", [missing.run.id]);
  const github = connectGitHub(h, good.proposal);
  const unapproved = root + '/2026/09/26091007_feat-extra_PRC-000000000001';
  github.commit(base, new Map([emptyIndex, [unapproved + '/product/prd.md', Buffer.from('Unapproved')]]));
  github.commit(head, new Map([...good.proposal.tree, [unapproved + '/product/prd.md', Buffer.from('Unapproved')]]), [base]);
  await h.verify();
  assert.equal(github.statuses.at(-1)?.state, 'success');
  assert.ok(h.warnings.some(({ details }) => details.folder === unapproved));
  github.commit(merge, good.proposal.tree, [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  await h.verify();
  assert.equal((await good.receipts()).length, 1);
});

test('G2 replacement ignores an invalid unrelated entry at the predecessor commit', postgresOnly, async t => {
  const h = await migratedHost(t);
  const first = await verifiedProposal(h);
  const github = connectGitHub(h, first.proposal);
  const indexPath = root + '/INDEX.json';
  const id = 'PRC-000000000001';
  const entry = { contractId: id, folder: '2026/09/26091007_feat-extra_' + id, status: 'active' };
  const index = (tree, unrelated) => new Map(tree).set(indexPath,
    canonicalPublicationJson([unrelated, ...JSON.parse(tree.get(indexPath))]));
  github.commit(merge, index(first.proposal.tree, { ...entry, status: 'invalid' }), [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  await h.verify();
  assert.equal((await first.receipts()).length, 1);

  h.priorFolder = first.proposal.folder;
  const next = await verifiedProposal(h, { id: 'replacement', supersedes: merge, pullNumber: 20,
    contractPins: [{ section: 'product', contractId: first.proposal.contractId, commit: merge }] });
  github.commit(advanced, index(first.proposal.tree, entry), [merge]);
  github.main = advanced;
  const nextHead = 'e'.repeat(40);
  const nextTree = index(next.proposal.tree, entry);
  github.commit(nextHead, nextTree, [advanced]);
  Object.assign(github.pr, { state: 'open', merged: false, head: { ...github.pr.head, sha: nextHead } });
  await h.verify();
  assert.equal((await next.requests())[0].executionState, 'verified');
  github.main = nextHead;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: nextHead });
  await h.verify();
  assert.equal((await next.receipts()).length, 1);
});

test('G2 reuses a known status when another row starts using the same head', postgresOnly, async t => {
  const h = await migratedHost(t);
  const first = await verifiedProposal(h);
  const github = connectGitHub(h, first.proposal);
  github.pr.draft = true;
  await h.verify();
  await verifiedProposal(h, { id: 'other-row', pullNumber: 20 });
  await h.db.execute('UPDATE ' + h.namespace + ".adlc_merge_requests SET disposition='rejected-admission' WHERE run_id=$1", [first.run.id]);
  await h.verify();
  assert.deepEqual(github.statuses.map(status => status.state), ['failure']);
});

test('G2 re-posts after an interruption between status POST and persistence', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  const github = connectGitHub(h, f.proposal);
  await h.verify();
  const execute = h.host.db.execute;
  let interrupted = false;
  h.host.db.execute = (sql, args) => {
    if (github.statuses.length === 2 && !interrupted) {
      interrupted = true;
      throw new Error('Interrupted after POST');
    }
    return execute(sql, args);
  };
  github.pr.draft = true;
  await h.verify();
  assert.equal(interrupted, true);
  github.pr.draft = false;
  await h.verify();
  await h.verify();
  assert.deepEqual(github.statuses.map(status => status.state), ['success', 'failure', 'success']);
});

test('G2 does not withdraw a shared-head status while its active row is deferred', postgresOnly, async t => {
  const h = await migratedHost(t);
  const first = await verifiedProposal(h);
  const github = connectGitHub(h, first.proposal);
  await h.verify();
  await verifiedProposal(h, { id: 'other-row', pullNumber: 20 });
  await h.db.execute('UPDATE ' + h.namespace + ".adlc_merge_requests SET disposition='rejected-admission' WHERE run_id=$1", [first.run.id]);
  h.host.http.fetch = (url, options) => url.includes('/git/blobs/')
    ? new Response(null, { status: 503 }) : github.fetch(url, options);
  await h.verify();
  assert.deepEqual(github.statuses.map(status => status.state), ['success']);
});

test('G2 records on the first tick after a full-auto downgrade', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  h.config.adlcProjects.project.automationMode = 'full-auto';
  const github = connectGitHub(h, f.proposal);
  github.commit(merge, f.proposal.tree, [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  await h.verify();
  assert.equal((await f.receipts())[0]?.mode, 'manual');
  assert.ok((await f.store.read()).audit.some(event => event.kind === 'automation.mode_downgraded'));
});

for (const status of ['stopped', 'paused']) {
  test('G2 handles a landed PR on a ' + status + ' run', postgresOnly, async t => {
    const h = await migratedHost(t);
    const f = await verifiedProposal(h);
    const github = connectGitHub(h, f.proposal);
    github.commit(merge, f.proposal.tree, [base, head]);
    github.main = merge;
    Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
    await editSnapshot(f.store, state => { state.runs[f.run.id].status = status; });
    await h.verify();
    assert.deepEqual(await f.receipts(), []);
    if (status === 'stopped') {
      assert.equal((await f.requests())[0].executionState, 'merged-unverified');
      assert.equal((await f.requests())[0].executionReason, 'publication-run-on-hold');
      assert.ok(h.warnings.some(({ details }) => details.runId === f.run.id && details.cause === 'publication-run-on-hold'));
    } else {
      assert.equal((await f.requests())[0].executionState, undefined);
      await editSnapshot(f.store, state => { state.runs[f.run.id].status = 'running'; });
      await h.verify();
      assert.equal((await f.receipts()).length, 1);
    }
  });
}


test('G2 retries the receipt CAS within the tick after unrelated graph activity', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  const github = connectGitHub(h, f.proposal);
  github.commit(merge, f.proposal.tree, [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  const record = GraphEngine.prototype.recordContractMerge;
  let attempts = 0;
  GraphEngine.prototype.recordContractMerge = async function (...args) {
    if (++attempts === 1) await editSnapshot(f.store, state => { state.audit.push({ kind: 'unrelated' }); });
    return record.apply(this, args);
  };
  try { await h.verify(); }
  finally { GraphEngine.prototype.recordContractMerge = record; }
  assert.equal(attempts, 2);
  assert.equal((await f.receipts()).length, 1);
});

test('G2 writes an independent head status before evaluating a later row', postgresOnly, async t => {
  const h = await migratedHost(t);
  const first = await verifiedProposal(h, { id: 'aaa-first' });
  const next = await verifiedProposal(h, { id: 'zzz-next', pullNumber: 20 });
  const github = connectGitHub(h, first.proposal);
  github.pr.draft = true;
  github.commit(advanced, next.proposal.tree, [base]);
  github.pulls.set(20, { ...github.pr, draft: false, head: {
    sha: advanced, ref: 'contract/feat-orders_' + next.proposal.contractId,
  } });
  let postedBeforeNext = false;
  h.host.http.fetch = (url, options) => {
    if (url.endsWith('/git/commits/' + advanced)) postedBeforeNext = github.statuses[0]?.sha === head;
    return github.fetch(url, options);
  };
  await h.verify();
  assert.equal(postedBeforeNext, true);
  assert.deepEqual(github.statuses.map(({ sha, state }) => [sha, state]), [[head, 'failure'], [advanced, 'success']]);
});

for (const race of ['interrupted acknowledgment', 'discovery rejection']) {
  test('G2 withdraws success after ' + race + ' during the first status write', postgresOnly, async t => {
    const h = await migratedHost(t);
    const f = await verifiedProposal(h);
    const github = connectGitHub(h, f.proposal);
    const reject = async () => {
      const revision = (await f.store.read()).revision;
      await rejectSupersededMergeRequests(h.db, h.companyId, revision, {
        runId: f.run.id, nodeId: f.row.nodeId, kind: 'contract_publication_request', currentAttempt: null,
      });
    };
    // Discovery needs a newer graph revision to supersede the admitted attempt.
    if (race === 'discovery rejection') {
      await editSnapshot(f.store, state => { state.audit.push({ kind: 'unrelated' }); });
      const query = h.host.db.query;
      h.host.db.query = async (sql, args) => {
        const rows = await query(sql, args);
        if (sql.startsWith('SELECT fingerprint FROM')) await reject();
        return rows;
      };
    } else {
      const execute = h.host.db.execute;
      h.host.db.execute = async (sql, args) => {
        if (sql.includes('SET pending=') && github.statuses.length === 1) {
          h.host.db.execute = execute;
          throw new Error('Interrupted after POST');
        }
        return execute(sql, args);
      };
    }
    await h.verify();
    assert.deepEqual(github.statuses.map(status => status.state), ['success']);
    if (race === 'interrupted acknowledgment') {
      await editSnapshot(f.store, state => { state.audit.push({ kind: 'unrelated' }); });
      await reject();
    }
    assert.equal((await f.requests())[0].disposition, 'rejected-admission');
    await h.verify();
    assert.deepEqual(github.statuses.map(({ state, description }) => [state, description]),
      [['success', 'Contract verified'], ['failure', 'publication-approval-stale']]);
  });
}

test('G2 withdraws a known status despite a persistent 404 on another PR', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  const github = connectGitHub(h, f.proposal);
  await h.verify();
  await verifiedProposal(h, { id: 'missing-pr', pullNumber: 20 });
  await h.db.execute('UPDATE ' + h.namespace + ".adlc_merge_requests SET disposition='rejected-admission' WHERE run_id=$1", [f.run.id]);
  h.host.http.fetch = (url, options) => url.endsWith('/pulls/20')
    ? new Response(null, { status: 404 }) : github.fetch(url, options);
  await h.verify();
  await h.verify();
  assert.deepEqual(github.statuses.map(({ sha, state }) => [sha, state]), [[head, 'success'], [head, 'failure']]);
});

test('G2 posts success despite a persistent 404 on another PR', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  await verifiedProposal(h, { id: 'missing-pr', pullNumber: 20 });
  const github = connectGitHub(h, f.proposal);
  h.host.http.fetch = (url, options) => url.endsWith('/pulls/20')
    ? new Response(null, { status: 404 }) : github.fetch(url, options);
  await h.verify();
  await h.verify();
  assert.deepEqual(github.statuses.map(({ sha, state }) => [sha, state]), [[head, 'success']]);
});

test('G2 defers shared-head success while another PR head returns 503', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  await verifiedProposal(h, { id: 'other-row', pullNumber: 20 });
  const github = connectGitHub(h, f.proposal);
  github.pulls.set(20, { ...github.pr, draft: true });
  h.host.http.fetch = (url, options) => url.endsWith('/pulls/20')
    ? new Response(null, { status: 503 }) : github.fetch(url, options);
  await h.verify();
  assert.deepEqual(github.statuses, []);
  h.host.http.fetch = github.fetch;
  await h.verify();
  assert.deepEqual(github.statuses.map(({ sha, state }) => [sha, state]), [[head, 'failure']]);
});

test('G2 verifies and records a replacement that canonicalizes the index on main', postgresOnly, async t => {
  const h = await migratedHost(t);
  const { first, github } = await landFirstContract(h);
  const [original] = await first.receipts();
  h.priorFolder = first.proposal.folder;
  const next = await verifiedProposal(h, { id: 'canonical-replacement', supersedes: merge, pullNumber: 20,
    contractPins: [{ section: 'product', contractId: original.contractId, commit: merge }] });
  const indexPath = root + '/INDEX.json';
  const mainTree = new Map(first.proposal.tree).set(indexPath,
    Buffer.from(JSON.stringify(JSON.parse(first.proposal.tree.get(indexPath)), null, 4)));
  github.commit(advanced, mainTree, [merge]);
  github.main = advanced;
  const newHead = 'e'.repeat(40);
  github.commit(newHead, next.proposal.tree, [advanced]);
  Object.assign(github.pr, { state: 'open', merged: false, merge_commit_sha: null, head: { ...github.pr.head, sha: newHead } });
  await h.verify();
  assert.equal(github.statuses.at(-1)?.state, 'success', JSON.stringify(h.warnings));
  github.main = newHead;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: newHead });
  await h.verify();
  assert.equal((await next.receipts())[0]?.mergeCommitSha, newHead);
});

test('G2 withdraws a pending success after rejecting the landed publication', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  const github = connectGitHub(h, f.proposal);
  const attempts = [];
  h.host.http.fetch = (url, options) => {
    if (url.endsWith('/statuses/' + head)) {
      attempts.push(JSON.parse(options.body).state);
      if (attempts.length <= 2) return new Response(null, { status: 503 });
    }
    return github.fetch(url, options);
  };
  await h.verify();
  assert.deepEqual(attempts, ['success']);
  const changed = new Map(f.proposal.tree).set(root + '/' + f.proposal.folder + '/product/prd.md', Buffer.from('unapproved'));
  github.commit(merge, changed, [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  await h.verify();
  assert.equal((await f.requests())[0].executionState, 'merged-unverified');
  assert.deepEqual(await f.receipts(), []);
  await h.verify();
  await h.verify();
  assert.deepEqual(attempts, ['success', 'failure', 'failure']);
  assert.deepEqual(github.statuses.map(status => status.state), ['failure']);
});

test('G2 finalizes a rejected merge while another row sharing its head keeps failing', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  const other = await verifiedProposal(h, { id: 'other-row', pullNumber: 20 });
  const github = connectGitHub(h, f.proposal);
  h.host.http.fetch = (url, options) => url.endsWith('/pulls/20')
    ? new Response(null, { status: 404 }) : github.fetch(url, options);
  await h.verify();
  assert.deepEqual(github.statuses.map(({ sha, state }) => [sha, state]), [[head, 'success']]);
  // The other row once shared this head, so its status history holds the same key.
  const requests = h.namespace + '.adlc_merge_requests';
  await h.db.execute('UPDATE ' + requests + ' SET verification_status=(SELECT verification_status FROM ' + requests
    + ' WHERE run_id=$1) WHERE run_id=$2', [f.run.id, other.run.id]);
  const changed = new Map(f.proposal.tree).set(root + '/' + f.proposal.folder + '/product/prd.md', Buffer.from('unapproved'));
  github.commit(merge, changed, [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  await h.verify();
  await h.verify();
  assert.equal((await f.requests())[0].executionState, 'merged-unverified');
  assert.deepEqual(await f.receipts(), []);
  assert.equal(github.statuses.at(-1)?.state, 'failure');
});

test('G2 retries a stopped run withdrawal after its queue row becomes terminal', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  const github = connectGitHub(h, f.proposal);
  await h.verify();
  github.commit(merge, f.proposal.tree, [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  await editSnapshot(f.store, state => { state.runs[f.run.id].status = 'stopped'; });
  let failures = 0;
  h.host.http.fetch = (url, options) => {
    if (url.endsWith('/statuses/' + head) && failures++ === 0) return new Response(null, { status: 503 });
    return github.fetch(url, options);
  };
  await h.verify();
  assert.equal((await f.requests())[0].executionState, 'merged-unverified');
  assert.deepEqual(github.statuses.map(status => status.state), ['success']);
  await h.verify();
  await h.verify();
  assert.equal(failures, 2);
  assert.deepEqual(github.statuses.map(({ state, description }) => [state, description]),
    [['success', 'Contract verified'], ['failure', 'publication-run-on-hold']]);
});

test('G2 retries a durable withdrawal through a second project when the first credentials fail', postgresOnly, async t => {
  const h = await migratedHost(t);
  const f = await verifiedProposal(h);
  const github = connectGitHub(h, f.proposal);
  await h.verify();
  github.commit(merge, f.proposal.tree, [base, head]);
  github.main = merge;
  Object.assign(github.pr, { state: 'closed', merged: true, merge_commit_sha: merge });
  await editSnapshot(f.store, state => { state.runs[f.run.id].status = 'stopped'; });
  h.host.http.fetch = (url, options) => url.endsWith('/statuses/' + head)
    ? new Response(null, { status: 503 }) : github.fetch(url, options);
  await h.verify();
  assert.equal((await f.requests())[0].executionState, 'merged-unverified');
  assert.deepEqual(github.statuses.map(status => status.state), ['success']);

  await editSnapshot(new PaperclipStore(h.db, h.otherCompanyId), () => {});
  const query = h.host.db.query;
  h.host.db.query = (statement, args) => statement.startsWith('SELECT company_id FROM')
    ? query(statement + ' ORDER BY (company_id = $1) DESC', [h.companyId]) : query(statement, args);
  const credentialAttempts = [];
  h.host.secrets.resolve = (ref, { companyId }) => {
    credentialAttempts.push(companyId);
    if (companyId === h.companyId) throw new Error('Unavailable key');
    assert.equal(companyId, h.otherCompanyId);
    return github.resolve(ref);
  };
  h.host.http.fetch = github.fetch;
  await h.verify();
  assert.deepEqual(github.statuses.map(({ state, description }) => [state, description]),
    [['success', 'Contract verified'], ['failure', 'publication-run-on-hold']]);
  assert.deepEqual(credentialAttempts.slice(0, 2), [h.companyId, h.otherCompanyId]);
});

test('G2 posts open PR success and failure despite unrelated graph activity', postgresOnly, async t => {
  const h = await migratedHost(t);
  const first = await verifiedProposal(h, { id: 'aaa-passing' });
  await verifiedProposal(h, { id: 'zzz-failing', pullNumber: 20 });
  const github = connectGitHub(h, first.proposal);
  github.pulls.set(20, { ...github.pr, draft: true, head: { ...github.pr.head, sha: advanced } });
  const reads = new Map();
  let revisions = 0;
  h.host.http.fetch = async (url, options) => {
    const match = url.match(/\/pulls\/(\d+)$/);
    if (match) {
      const [, pull] = match;
      reads.set(pull, (reads.get(pull) ?? 0) + 1);
      if (reads.get(pull) === 2) {
        await editSnapshot(first.store, state => { state.audit.push({ kind: 'unrelated' }); });
        revisions++;
      }
    }
    return github.fetch(url, options);
  };
  await h.verify();
  assert.equal(revisions, 2);
  assert.deepEqual(github.statuses.map(({ sha, state }) => [sha, state]), [[head, 'success'], [advanced, 'failure']]);
});
