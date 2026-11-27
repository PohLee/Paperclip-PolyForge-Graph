import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GraphEngine, MemoryStore, runValidationDigest } from '../../src/core/index.mjs';
import { assertAutomationModeCeiling } from '../../src/host/automation-mode.mjs';
import { createGitHubAppAdapter, mergeContract } from '../../src/host/contract-merge.mjs';
import { canonicalPublicationJson, readApprovedContract } from '../../src/host/contract-publication.mjs';
import { approvalBody, approvalTime, authoredProposal, publicationGitHub, repositoryId } from '../helpers/g2-publication-fixture.mjs';

const main = 'a'.repeat(40);
const head = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const prd = '# Billing';
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture({ actor = { id: 'owner', kind: 'human', roles: ['human-owner'] }, type = 'requirements-acceptance', outcome = 'accept', area = 'product', candidateRevision = 'rev1', contractsRoot } = {}) {
  const store = new MemoryStore();
  const engine = new GraphEngine({ store });
  const decision = { id: 'g2', runId: 'run', nodeId: 'gate', type, actor,
    status: 'decided', outcome, evidence: [{ subjectRefs: [{ artifactId: 'manifest', version: 'rev1' }] }] };
  await store.write({ revision: 1, packs: {}, audit: [], idempotency: {}, decisions: [decision], runs: {
    run: { id: 'run', status: 'completed', input: { projectId: 'project' },
      graph: { nodes: [{ id: 'gate', decisionType: decision.type, candidateNodes: ['prepare'], candidateKinds: ['manifest'] }] },
      nodeStates: { prepare: { status: 'completed', artifacts: ['rev1', candidateRevision].map(version =>
        ({ id: 'manifest', version, kind: 'manifest' })) }, gate: { status: 'completed', attempts: [{ decisionId: decision.id }] } } }
  } }, 0);
  const manifest = { id: 'manifest', revisionId: 'rev1', bytes: JSON.stringify({
    deliverables: [{ key: 'prd', digest: digest(prd) }]
  }) };
  const root = contractsRoot ?? 'knowledge/contracts';
  const product = authoredProposal({ id: 'prior-product', at: approvalTime },
    { id: 'product-manifest', revisionId: 'r1', bytes: JSON.stringify(approvalBody()) });
  const { contractId } = product;
  const folder = root + '/' + product.folder;
  const productTree = new Map([...product.tree].map(([path, bytes]) =>
    [path.replace(/^knowledge\/contracts/, root), bytes]));
  const lockPath = folder + '/contract.lock.json';
  const productLock = productTree.get(lockPath);
  const lock = JSON.parse(productLock);
  lock.files.push({ path: area + '/extra.md', section: area, digest: digest(prd) });
  const changes = new Map([
    [folder + '/' + area + '/extra.md', prd], [lockPath, canonicalPublicationJson(lock)],
  ]);
  await engine.recordContractMerge('run', { repository: 'org/repo', section: 'product', contractId,
    pullNumber: 1, mergeCommitSha: main, folder, lockDigest: digest(productLock), supersedes: null });
  const plan = { contractId, supersedes: null, currentRevision: null, changes, deliverables: new Map([['prd', prd]]) };
  const snapshot = { headSha: head, baseSha: main, baseRef: 'main',
    changes: [...changes].map(([path, bytes]) => ({ path, bytes, mode: '100644', status: 'added' })) };
  const refs = [];
  let calls = 0;
  const github = {
    getRef: async ({ ref }) => { assert.equal(ref, 'refs/heads/main'); return main; },
    getPullSnapshot: async () => snapshot,
    getMergeReceipt: async () => null,
    readContractFile: () => async (path, ref) => {
      if (ref === merged && changes.has(path)) return Buffer.from(changes.get(path));
      return productTree.get(path);
    },
    loadValidator: async ({ ref }) => {
      refs.push(ref);
      return ref === main ? { recompute: async () => plan } : { recompute: () => assert.fail('Untrusted validator ran') };
    },
    merge: async ({ baseSha, headSha }) => {
      calls++;
      assert.equal(baseSha, main);
      assert.equal(headSha, head);
      return merged;
    }
  };
  return { args: { engine, github, project: { id: 'project', ownerId: 'owner', repository: 'org/repo', contractsRoot },
    runId: 'run', pullNumber: 42, section: 'product', decisionId: 'g2', manifest },
    store, folder, snapshot, plan, productTree, refs, calls: () => calls };
}

test('the legacy action cannot merge a new G2 publication', async () => {
  const { args, calls } = await fixture();
  await assert.rejects(mergeContract(args), /Use the G2 contract verification worker/);
  assert.equal(calls(), 0);
});

test('merges a design contract on the owner G3 approval and keeps interaction design out of it', async () => {
  const g3 = { type: 'g3-visual-approval', outcome: 'approve', area: 'design' };
  const { args } = await fixture(g3);
  assert.equal((await mergeContract({ ...args, section: 'design' })).mergeCommitSha, merged);

  const interaction = await fixture(g3);
  interaction.snapshot.changes.push({ path: interaction.folder + '/design/interaction.md', bytes: '# Flow', mode: '100644', status: 'modified' });
  await assert.rejects(mergeContract({ ...interaction.args, section: 'design' }), /path is forbidden/);

  const held = await fixture({ ...g3, outcome: 'hold' });
  await assert.rejects(mergeContract({ ...held.args, section: 'design' }), /gate approval is required/);

  const g2Only = await fixture({ area: 'design' });
  await assert.rejects(mergeContract({ ...g2Only.args, section: 'design' }), /gate approval is required/);

  const agent = await fixture({ ...g3, actor: { id: 'owner', kind: 'agent', roles: ['human-owner'] } });
  await assert.rejects(mergeContract({ ...agent.args, section: 'design' }), /approver is unauthorized/);
});

test('assisted G3 allows only a design director with a clean audit bound to an in-system manifest', async () => {
  const { args } = await fixture({ actor: { id: 'director', kind: 'agent', roles: ['design-director'] },
    type: 'g3-visual-auto-approval', outcome: 'approve', area: 'design' });
  args.section = 'design';
  args.project.automationMode = 'assisted';
  const run = await args.engine.getRun(args.runId);
  const decisions = await args.engine.listDecisions({ runId: args.runId });
  args.engine.getRun = async () => run;
  args.engine.listDecisions = async () => decisions;
  run.mode = 'assisted';
  const manifest = JSON.parse(args.manifest.bytes);
  const auditRef = { artifactId: 'audit', version: 'rev1' };
  function evidence(scope, behaviorChanged, findings, auditChanged = false) {
    const { deliverables } = manifest;
    args.manifest.bytes = JSON.stringify({ systemScope: scope, deliverables, behaviorChanged }, null, 2);
    const canonical = JSON.stringify({ behaviorChanged,
      deliverables: deliverables.map(({ key, digest }) => ({ digest, key })), systemScope: scope });
    const audit = { manifestDigest: digest(canonical), behaviorChanged: auditChanged, findings };
    args.auditBytes = JSON.stringify(audit);
    run.nodeStates['design-audit'] = { status: 'completed', attempts: [{
      artifacts: [{ id: auditRef.artifactId, version: auditRef.version, kind: 'visual_audit' }],
      output: { creativeArtifacts: { visual_audit: audit } },
    }] };
  }
  evidence('out-of-system', false, []);
  await assert.rejects(mergeContract(args), /approver is unauthorized/);
  evidence('in-system', true, []);
  await assert.rejects(mergeContract(args), /approver is unauthorized/);
  evidence('in-system', false, [{ severity: 'P1' }]);
  await assert.rejects(mergeContract(args), /approver is unauthorized/);
  evidence('in-system', false, []);
  args.auditBytes = JSON.stringify({ manifestDigest: digest('other'), findings: [] });
  await assert.rejects(mergeContract(args), /approver is unauthorized/);
  evidence('in-system', false, []);
  await assert.rejects(mergeContract(args), /approver is unauthorized/);
  decisions[0].evidence[0].subjectRefs.push(auditRef);
  evidence('in-system', false, [], true);
  await assert.rejects(mergeContract(args), /approver is unauthorized/);
  evidence('in-system', false, []);
  run.nodeStates['design-audit'].status = 'pending';
  await assert.rejects(mergeContract(args), /approver is unauthorized/);
  run.nodeStates['design-audit'].status = 'completed';
  decisions[0].type = run.graph.nodes[0].decisionType = 'g3-visual-approval';
  await assert.rejects(mergeContract(args), /approver is unauthorized/);
  decisions[0].type = run.graph.nodes[0].decisionType = 'g3-visual-auto-approval';
  assert.equal((await mergeContract(args)).mergeCommitSha, merged);
});

test('project mode ceiling permits lower modes and requires an explicit full-auto opt-in', () => {
  assert.throws(() => assertAutomationModeCeiling('assisted', { automationMode: 'manual' }), /ceiling/);
  assert.throws(() => assertAutomationModeCeiling('autonomous', { automationMode: 'assisted', allowFullAuto: true }), /ceiling/);
  assert.throws(() => assertAutomationModeCeiling('autonomous', { automationMode: 'full-auto' }), /ceiling/);
  assert.doesNotThrow(() => assertAutomationModeCeiling('assisted', { automationMode: 'full-auto' }));
  assert.doesNotThrow(() => assertAutomationModeCeiling('autonomous', { automationMode: 'full-auto', allowFullAuto: true }));
});

test('a G4 approval predating a superseding product pin cannot publish after resume', async () => {
  const { args, store } = await fixture({ type: 'technical-contract-approval', area: 'technical',
    actor: { id: 'cto', kind: 'agent', roles: ['cto'] } });
  args.section = 'technical';
  args.project.ctoId = 'cto';
  const host = { kind: 'system', id: 'host', roles: [] };
  const first = 'd'.repeat(40), second = 'e'.repeat(40);
  const pin = { contractId: 'product', section: 'product', commit: first };
  const state = await store.read();
  const run = state.runs.run;
  run.status = 'running';
  run.mode = 'manual';
  run.pack = { decisionRules: [{ type: 'technical-contract-approval', mode: 'manual',
    allowedKinds: ['agent'], allowedRoles: ['cto'], requiredEvidence: ['approval'] }] };
  Object.assign(run.graph.nodes[0], { type: 'decision', role: 'cto', outcomes: ['accept'] });
  run.graph.start = 'prepare';
  run.graph.nodes.push({ id: 'prepare', type: 'task' }, { id: 'publish', type: 'end' });
  run.nodeStates.publish = { status: 'pending', attempts: [] };
  run.graph.edges = [{ from: 'prepare', to: 'gate' }, { from: 'gate', to: 'publish', when: 'accept' }];
  run.conflicts = [];
  run.contract_pins = [pin];
  state.runs.publication = { id: 'publication', status: 'completed', input: { projectId: 'project' } };
  state.audit.push({ kind: 'decision.recorded', runId: run.id, decisionId: args.decisionId });
  await store.write({ ...state, revision: state.revision + 1 }, state.revision);
  const publication = { repository: 'org/repo', contractId: pin.contractId, section: pin.section };
  await args.engine.recordContractMerge('publication', { ...publication, pullNumber: 1, mergeCommitSha: first, supersedes: null });
  await args.engine.recordContractMerge('publication', { ...publication, contractId: 'replacement', pullNumber: 2, mergeCommitSha: second, supersedes: first });
  await args.engine.updateContractPins({ runId: run.id, pins: [{ ...pin, contractId: 'replacement', commit: second }], actor: host,
    reason: 'Supersession', idempotencyKey: 'update', expectedRunDigest: runValidationDigest(await args.engine.getRun(run.id)) });
  await args.engine.resumeRun({ runId: run.id, actor: host, reason: 'Pins updated' });
  args.github.merge = async (_request, authorize) => { await authorize(); assert.fail('Old G4 authorized publication'); };
  await assert.rejects(mergeContract(args), /Contract pins changed after/);

  const resumed = await store.read();
  resumed.runs.run.nodeStates.gate.status = 'pending';
  await store.write({ ...resumed, revision: resumed.revision + 1 }, resumed.revision);
  const { decision } = await args.engine.decideNode({ runId: run.id, nodeId: 'gate', outcome: 'accept',
    actor: { id: 'cto', kind: 'agent', roles: ['cto'], executionId: 'new-review' }, reason: 'Review the replacement pin',
    evidence: [{ kind: 'approval', subjectRefs: [{ artifactId: 'manifest', version: 'rev1' }] }] });
  args.github.merge = async (_request, authorize) => { await authorize(); return merged; };
  assert.equal((await mergeContract({ ...args, decisionId: decision.id })).mergeCommitSha, merged);
});

test('G4 records despite unrelated graph writes during landed verification', async () => {
  const { args, store, folder } = await fixture({ type: 'technical-contract-approval', area: 'technical',
    actor: { id: 'cto', kind: 'agent', roles: ['cto'] } });
  args.section = 'technical';
  args.project.ctoId = 'cto';
  const read = args.github.readContractFile();
  let landedLockReads = 0;
  args.github.readContractFile = () => async (path, ref) => {
    if (ref === merged && path === folder + '/contract.lock.json') {
      landedLockReads++;
      const snapshot = await store.read();
      snapshot.audit.push({ kind: 'unrelated' });
      await store.write({ ...snapshot, revision: snapshot.revision + 1 }, snapshot.revision);
    }
    return read(path, ref);
  };

  const receipt = await mergeContract(args);
  assert.equal(receipt.mergeCommitSha, merged);
  assert.equal(landedLockReads, 1);
});

for (const [section, gate] of [
  ['design', { type: 'g3-visual-approval', outcome: 'approve' }],
  ['technical', { type: 'technical-contract-approval', actor: { id: 'cto', kind: 'agent', roles: ['cto'] } }],
]) {
  test('legacy ' + section + ' fences paths, checks digests and supersedes, and records the landed binding once', async () => {
    const { args, calls, folder, plan, snapshot, store } = await fixture({ ...gate, area: section });
    args.section = section;
    args.project.ctoId = 'cto';
    const path = snapshot.changes[0].path;
    snapshot.changes[0].path = folder + '/product/forbidden.md';
    await assert.rejects(mergeContract(args), /path is forbidden/);
    snapshot.changes[0].path = path;
    snapshot.changes[0].bytes = 'different bytes';
    await assert.rejects(mergeContract(args), /file digest mismatch/);
    snapshot.changes[0].bytes = plan.changes.get(path);
    plan.supersedes = 'f'.repeat(40);
    await assert.rejects(mergeContract(args), /supersedes is stale/);
    plan.supersedes = null;
    const receipt = await mergeContract(args);
    assert.equal(receipt.folder, folder);
    assert.equal(receipt.lockDigest, digest(plan.changes.get(folder + '/contract.lock.json')));
    assert.deepEqual(await mergeContract(args), receipt);
    assert.equal(calls(), 1);
    assert.equal((await store.read()).audit.filter(event => event.kind === 'contract.merged' && event.section === section).length, 1);
  });
}


test('legacy technical publication uses the exported adapter and the pinned installed recompute', async () => {
  const { args, plan, productTree } = await fixture({ type: 'technical-contract-approval', area: 'technical',
    actor: { id: 'cto', kind: 'agent', roles: ['cto'] } });
  args.section = 'technical';
  args.project.ctoId = 'cto';
  const repo = { full_name: args.project.repository };
  const landedTree = new Map([...productTree, ...[...plan.changes].map(([path, bytes]) => [path, Buffer.from(bytes)])]);
  const remote = publicationGitHub(args.project.repository, { contractId: plan.contractId, tree: landedTree });
  remote.commit(main, productTree);
  remote.commit(head, landedTree, [main]);
  remote.commit(merged, landedTree, [main, head]);
  let mainRef = main;
  let validated = false;
  args.github = createGitHubAppAdapter({
    receipts: new Map(), getInstallationToken: async () => 'repo-token',
    installedValidator: {
      async recompute(input, { readFile }) {
        assert.equal(input.baseSha, main);
        assert.equal(input.headSha, head);
        assert.equal(input.section, 'technical');
        assert.deepEqual(await readFile('knowledge/contracts/INDEX.json'), productTree.get('knowledge/contracts/INDEX.json'));
        validated = true;
        return plan;
      },
    },
    async fetch(url, options) {
      const { pathname, search } = new URL(url);
      const path = pathname.slice('/repos/org/repo/'.length);
      if (path === 'git/refs/heads/main') {
        if (options.method === 'PATCH') mainRef = JSON.parse(options.body).sha;
        return Response.json({ object: { sha: mainRef } });
      }
      if (path === 'pulls/42') return Response.json({ state: 'open', base: { sha: main, ref: 'main', repo },
        head: { sha: head }, changed_files: plan.changes.size, user: { login: 'author' } });
      if (path.startsWith('compare/')) {
        const comparison = await remote.fetch(url.replace('/repos/org/repo/', '/repositories/' + repositoryId + '/'), options);
        const data = await comparison.json();
        return Response.json({ ...data, files: data.files.map(file => ({ ...file, status: productTree.has(file.filename) ? 'modified' : 'added' })) });
      }
      if (path === 'git/trees/' + head && search) return Response.json({ tree: [...landedTree.keys()]
        .map(path => ({ path, type: 'blob', mode: '100644' })) });
      if (path === 'git/refs') return Response.json({});
      if (path === 'merges') return Response.json({ sha: merged, parents: [{ sha: main }, { sha: head }] });
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      return remote.fetch(url.replace('/repos/org/repo/', '/repositories/' + repositoryId + '/'), options);
    },
  });
  const receipt = await mergeContract(args);
  assert.equal(receipt.mergeCommitSha, merged);
  assert.equal(mainRef, merged);
  assert.equal(validated, true);
});

for (const recovered of [false, true]) {
  test('G4 refuses a stale product binding when recording a ' + (recovered ? 'recovered' : 'fresh') + ' merge', async () => {
    const { args, store, folder, plan, productTree } = await fixture({
      type: 'technical-contract-approval', area: 'technical', actor: { id: 'cto', kind: 'agent', roles: ['cto'] },
    });
    args.section = 'technical';
    args.project.ctoId = 'cto';
    const lockPath = folder + '/contract.lock.json';
    const replacementSha = 'd'.repeat(40);
    const replacementLock = JSON.parse(productTree.get(lockPath));
    const productPath = 'product/prd.md';
    const replacementBytes = Buffer.from('# New product requirements');
    replacementLock.files.find(file => file.path === productPath).digest = digest(replacementBytes);
    const replacementTree = new Map(productTree)
      .set(lockPath, canonicalPublicationJson(replacementLock))
      .set(folder + '/' + productPath, replacementBytes);
    const readContractFile = args.github.readContractFile;
    args.github.readContractFile = params => (path, ref) => ref === replacementSha
      ? replacementTree.get(path) : readContractFile(params)(path, ref);
    if (recovered) args.github.getMergeReceipt = async () => ({
      baseSha: main, headSha: head, mergeCommitSha: merged, contractId: plan.contractId, supersedes: null,
    });

    const record = args.engine.recordContractMerge.bind(args.engine);
    let raced = false;
    args.engine.recordContractMerge = async (...params) => {
      if (!raced) {
        raced = true;
        await record('run', { repository: 'org/repo', section: 'product', contractId: plan.contractId,
          pullNumber: 2, mergeCommitSha: replacementSha, folder, lockDigest: digest(replacementTree.get(lockPath)), supersedes: main });
      }
      return record(...params);
    };

    await assert.rejects(mergeContract(args), { code: 'contract-drift' });
    const publications = (await store.read()).audit.filter(event => event.kind === 'contract.merged');
    assert.deepEqual(publications.map(event => event.mergeCommitSha), [main, replacementSha]);
    const receipt = publications.at(-1);
    const readFile = args.github.readContractFile({});
    const approved = { contractId: plan.contractId, contractsRoot: 'knowledge/contracts', receipt };
    // G5 reads the current approved binding and refuses the stale landed G4 bytes.
    const files = await readApprovedContract(approved, (path, ref = replacementSha) => readFile(path, ref));
    assert.deepEqual(files.get(folder + '/' + productPath), replacementBytes);
    await assert.rejects(readApprovedContract(approved, (path, ref = merged) => readFile(path, ref)), { code: 'contract-drift' });
  });
}
