import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pack as adlc } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';
import { pack as creative } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/index.mjs';
import { canonical } from '../../src/core/canonical.mjs';
import { GraphEngine, runValidationDigest } from '../../src/core/index.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import { PaperclipStore, listMergeRequests, recordPackRuntime, setGraphConfig } from '../../src/plugin/store.mjs';
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

async function migratedHost(t) {
  const { db, sql, namespace, companyId, otherCompanyId } = await createPostgresShadowDatabase(t);
  await sql.unsafe(`CREATE TABLE ${namespace}.issues (id uuid PRIMARY KEY); CREATE TABLE ${namespace}.agents (id uuid PRIMARY KEY)`);
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => !/^00[78]_/.test(name)).sort()) {
    const source = await readFile(new URL(name, migrations), 'utf8');
    await sql.unsafe(source.replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace)
      .replaceAll(/REFERENCES public\.(companies|issues|agents)\(id\)/g, `REFERENCES ${namespace}.$1(id)`));
  }
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
        throw new Error('Simulated worker interruption');
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
  return { db, sql, namespace, host, config, companyId, otherCompanyId, warnings, snapshotReads,
    discover: () => jobs.get('adlc-merge-discover')(),
    interrupt: (table, companyId) => { interrupt = { table, companyId }; } };
}

async function bindRuntime(db, companyId, { run, descriptor }) {
  const { packId, packVersion, packDigest, adapterId, adapterVersion } = descriptor;
  await recordPackRuntime(db, companyId, run.id, { packId, packVersion, packDigest, adapterId, adapterVersion, adapterBundleDigest });
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
  preparing = false } = {}) {
  const pack = row.packId === 'adlc' ? adlc : creative;
  const descriptor = trustedPackAdapters.find(adapter => adapter.packId === pack.id);
  const graph = pack.graphs.find(graph => graph.id === row.graphId && graph.version === graphVersion);
  const store = new PaperclipStore(db, companyId);
  const engine = new GraphEngine({ store, mergeProducers, candidatePayload: descriptor.candidatePayload });
  const namespace = pack.id === adlc.id ? 'adlcProductMethods' : 'creativeArtifacts';
  const input = { paperclipCompanyId: companyId, paperclipIssueId: randomUUID(), projectId: project.id };
  const run = { id, pack, packId: pack.id, packVersion: pack.version, graph, input, mode: 'manual', status: 'running',
    conflicts: [], nodeStates: Object.fromEntries(graph.nodes.map(node => [node.id,
      ['end'].includes(node.type) || [row.nodeId, row.gateNodeId].includes(node.id)
        ? { status: 'pending', artifacts: [], attempts: [] } : completed(namespace, {})])) };
  const candidate = { id: 'manifest-' + id, version: '1' };
  let audit;
  if (row.section === 'product') {
    input.requirements_draft = 'draft';
    input.readiness_report = 'reviewed';
    const deliverables = ['prd', 'acceptance.feature'].map(key => ({ key, revisionId: key + '-revision', digest: 'a'.repeat(64) }));
    Object.assign(candidate, { supersedes: null, deliverables, egmReportRef: 'egm', assumptions: [], unresolvedEscalations: [] });
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
  if (missing) delete run.nodeStates[row.candidateNodeId].attempts[0].output;
  await editSnapshot(store, snapshot => {
    snapshot.runs[id] = run;
    for (const pin of input.contract_pins ?? []) snapshot.audit.push({ kind: 'contract.merged',
      projectId: project.id, contractId: pin.contractId, section: pin.section, mergeCommitSha: pin.commit });
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

async function publish(f, decision) {
  const { engine, run, row, api, candidate, audit } = f;
  const nodeId = row.nodeId;
  const node = run.graph.nodes.find(node => node.id === nodeId);
  const request = { id: 'request-' + run.id, version: '1', section: row.section, runId: run.id,
    decisionId: decision.id, manifest: manifestRef(candidate), ...(audit ? { audit: manifestRef(audit) } : {}),
    pullNumber: pr.pullNumber, ...(row.section === 'design' ? {} : { contract_pins: run.input.contract_pins ?? [] }),
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
  const end = (await engine.getReadyNodes(run.id)).find(node => node.type === 'end');
  await api.submitNode({ runId: run.id, nodeId: end.id, actor: { id: manifest.id, kind: 'system', roles: [], executionId: null } });
  assert.equal((await engine.getRun(run.id)).status, 'completed');
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

  h.interrupt('INSERT INTO ' + h.namespace + '.adlc_merge_requests', h.companyId);
  await h.discover();
  assert.equal(h.warnings.filter(row => row.message.includes('discovery failed')).length, 1);
  assert.equal((await listMergeRequests(h.db, h.companyId, fixtures[0].run.id)).length, 0);
  assert.equal((await listMergeRequests(h.db, h.otherCompanyId, other.run.id))[0].disposition, 'admitted');

  h.interrupt('INSERT INTO ' + h.namespace + '.adlc_merge_discovery', h.companyId);
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
    assert.equal(stored.fingerprint, sha256(canonical({ kind: stored.kind,
      payload: stored.request.payload, artifactRef: stored.request.artifactRef })));
  }
});

test('G2 confirmation freezes the exact document and rejects missing or changed payload', {
  skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL',
}, async t => {
  const h = await migratedHost(t);
  const row = mergeProducers[0];
  const absent = await readyGate(h.db, h.companyId, row, { id: 'no-payload', missing: true });
  await assert.rejects(absent.engine.decideNode(absent.args), /current validated candidate payload/);
  const f = await readyGate(h.db, h.companyId, row, { id: 'confirmation' });
  let body = JSON.stringify({ ...f.candidate, altered: true });
  const { run, engine, candidate } = f;
  const issueId = run.input.paperclipIssueId;
  await bindRuntime(h.db, h.companyId, f);
  await editSnapshot(f.store, snapshot => Object.assign(snapshot.runs[run.id], {
    status: 'paused', pendingHuman: { kind: 'decision', nodeId: row.gateNodeId, escalationDecisionId: 'escalation' },
  }));
  h.host.issues.documents = { get: async () => ({ id: candidate.id, latestRevisionId: candidate.version, body }) };
  h.host.issues.requestConfirmation = async (_issue, input) => ({ ...input, id: 'card', kind: 'request_confirmation',
    status: 'accepted', result: { outcome: 'accepted' }, resolvedByUserId: owner.id });
  const confirm = () => plugin.definition.onApiRequest({ routeKey: 'graph-read', companyId: h.companyId,
    params: { issueId }, query: { runId: run.id }, actor: { actorType: 'user', userId: owner.id } });
  assert.match((await confirm()).body.nativeDecisionError, /document body does not match/);
  assert.deepEqual(await engine.listDecisions({ runId: run.id }), []);
  body = JSON.stringify(candidate, null, 2);
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
