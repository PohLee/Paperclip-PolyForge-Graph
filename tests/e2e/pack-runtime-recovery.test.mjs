import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPackRuntimeRecovery, packRuntimeSourceDigest } from '../../src/plugin/pack-runtime-recovery.mjs';
import { finalizePackRuntimeValidation, getLatestPackRuntimeValidation } from '../../src/plugin/pack-runtime-recovery-store.mjs';
import { GraphEngine, MemoryStore, runValidationDigest } from '../../src/core/index.mjs';
import { createPostgresTemporaryAgentDatabase, postgresTemporaryAgentAvailable } from '../helpers/postgres-temporary-agent.mjs';

const owner = { id: 'owner-1', kind: 'human', roles: ['human-owner'], executionId: null };
function snapshot() {
  return {
    revision: 7,
    runs: { run: { id: 'run', packId: 'adlc', packVersion: '0.3.2', pack: { id: 'adlc', version: '0.3.2' }, input: {
      feature: 'checkout', product_decision_refs: ['product-1'],
    }, graph: { id: 'implementation' }, nodeStates: { build: { status: 'completed', attempts: [{ output: { artifact: 'v1' } }] } } } },
    decisions: [
      { id: 'run-decision', runId: 'run', type: 'implementation_acceptance', outcome: 'accept' },
      { id: 'product-1', type: 'product', feature: 'checkout', status: 'approved', sourceRef: { kind: 'decision', id: 'source-1' } },
      { id: 'source-1', type: 'approval', status: 'approved' },
      { id: 'unrelated', type: 'product', feature: 'other', status: 'approved' },
    ],
  };
}
const identity = { packId: 'adlc', packVersion: '0.3.2', packDigest: packRuntimeSourceDigest(snapshot().runs.run.pack),
  adapterId: 'adlc-host-api', adapterVersion: '1', adapterBundleDigest: 'sha256:bundle' };

test('authorized recovery validates one pinned run snapshot and commits its validation result', async () => {
  const state = snapshot(); let written;
  const recovery = createPackRuntimeRecovery({
    readSnapshot: async () => state,
    resolveOwner: async ({ companyId, claimedActor }) => {
      assert.equal(companyId, 'company-1'); return claimedActor;
    },
    resolveValidator: async run => {
      assert.equal(run.pack.id, 'adlc');
      return { identity, validateRun: async ({ run, decisions }) => {
        assert.equal(run.id, 'run');
        assert.deepEqual(decisions.map(item => item.id).sort(), ['product-1', 'run-decision', 'source-1', 'unrelated']);
        return { valid: true, issues: [], validatedSubjectRefs: [{ artifactId: 'build-output', version: 'v1' }] };
      } };
    },
    finalizeValidation: async input => { written = input; return { committed: true, validationRevision: 1, previousIdentity: null }; },
  });

  const result = await recovery.revalidate({ companyId: 'company-1', runId: 'run', actor: owner, reason: 'Revalidate existing run' });
  assert.equal(result.status, 'valid');
  assert.equal(result.validationRevision, 1);
  assert.deepEqual(written.identity, identity);
  assert.equal(written.expectedStateRevision, 7);
  assert.match(written.sourceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(written.actor.id, owner.id);
  assert.equal(written.reason, 'Revalidate existing run');
});

test('invalid or unavailable validators record actionable diagnostics without binding', async () => {
  const cases = [
    { resolveValidator: async () => ({ identity, validateRun: async () => ({ valid: false,
      issues: [{ code: 'artifact-invalid', path: 'build.output.artifact', message: 'Payload is malformed', action: 'Repair the source artifact and revalidate' }] }) }),
      expectedCode: 'artifact-invalid' },
    { resolveValidator: async () => null, expectedCode: 'trusted-adapter-unavailable' },
  ];
  for (const item of cases) {
    let written;
    const recovery = createPackRuntimeRecovery({ readSnapshot: async () => snapshot(),
      resolveOwner: async () => owner, resolveValidator: item.resolveValidator,
      finalizeValidation: async input => { written = input; return { committed: true, validationRevision: 2, previousIdentity: null }; },
    });
    const result = await recovery.revalidate({ companyId: 'company-1', runId: 'run', actor: owner, reason: 'Check old data' });
    assert.equal(result.status, 'invalid');
    assert.equal(result.issues[0].code, item.expectedCode);
    assert.equal(written.validation.status, 'invalid');
    assert.deepEqual(written.identity, item.expectedCode === 'trusted-adapter-unavailable' ? null : identity);
  }
});

test('revalidation fails closed on owner denial, missing reason, and a changed Graph state revision', async () => {
  let writes = 0;
  const base = { readSnapshot: async () => snapshot(), resolveValidator: async () => ({ identity,
    validateRun: async () => ({ valid: true, issues: [], validatedSubjectRefs: [] }) }),
    finalizeValidation: async () => { writes++; return { committed: false }; } };
  const denied = createPackRuntimeRecovery({ ...base, resolveOwner: async () => ({ id: 'agent', kind: 'agent', roles: [] }) });
  await assert.rejects(denied.revalidate({ companyId: 'company-1', runId: 'run', actor: owner, reason: 'Need check' }), /human owner/);
  const allowed = createPackRuntimeRecovery({ ...base, resolveOwner: async () => owner });
  await assert.rejects(allowed.revalidate({ companyId: 'company-1', runId: 'run', actor: owner, reason: '  ' }), /reason is required/);
  await assert.rejects(allowed.revalidate({ companyId: 'company-1', runId: 'run', actor: owner, reason: 'Revalidate after change' }), /changed during revalidation/);
  assert.equal(writes, 1);
});

test('PostgreSQL validation finalization is revision-guarded, append-only, and only valid results rebind the runtime', {
  skip: !postgresTemporaryAgentAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL',
}, async t => {
  const { db, sql, namespace, companyId } = await createPostgresTemporaryAgentDatabase(t);
  await sql.unsafe(`CREATE TABLE ${namespace}.companies (id uuid PRIMARY KEY)`);
  await sql.unsafe(`INSERT INTO ${namespace}.companies VALUES ($1)`, [companyId]);
  await sql.unsafe(`CREATE TABLE ${namespace}.graph_state (
    company_id uuid PRIMARY KEY REFERENCES ${namespace}.companies(id) ON DELETE CASCADE,
    revision bigint NOT NULL, document jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  for (const name of ['014_pack_runtime_binding.sql', '015_pack_runtime_validation.sql']) {
    const migration = (await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
      .replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace)
      .replaceAll('public.companies', `${namespace}.companies`);
    await sql.unsafe(migration);
  }
  const run = snapshot().runs.run;
  const originalBusinessRun = structuredClone(run);
  await sql.unsafe(`INSERT INTO ${namespace}.graph_state (company_id,revision,document) VALUES ($1,7,$2::jsonb)`,
    [companyId, JSON.stringify({ revision: 7, runs: { run }, decisions: [], audit: [] })]);
  const beforeDigest = runValidationDigest(run);
  const firstIdentity = identity;
  const initiallyValid = await finalizePackRuntimeValidation(db, { companyId, runId: 'run', expectedStateRevision: 7,
    sourceDigest: 'sha256:' + 'a'.repeat(64), validation: { status: 'valid', issues: [], validatedSubjectRefs: [] },
    identity: firstIdentity, actor: owner, reason: 'Attest the currently supported runtime' });
  assert.equal(initiallyValid.validationRevision, 1);
  assert.equal(initiallyValid.rebound, true);
  assert.equal(initiallyValid.newStateRevision, 8);
  const afterValidState = await sql.unsafe(`SELECT revision,document FROM ${namespace}.graph_state WHERE company_id=$1`, [companyId]);
  assert.equal(Number(afterValidState[0].revision), 8);
  assert.equal(afterValidState[0].document.revision, 8);
  assert.notEqual(runValidationDigest(afterValidState[0].document.runs.run), beforeDigest,
    'host validation token must invalidate transitions admitted against the prior run snapshot');
  assert.ok(afterValidState[0].document.runs.run.hostValidationId);
  const staleStore = new MemoryStore();
  await staleStore.write({ revision: 8, packs: {}, runs: { run: afterValidState[0].document.runs.run },
    decisions: [], audit: [], idempotency: {} }, 0);
  const staleEngine = new GraphEngine({ store: staleStore });
  await assert.rejects(staleEngine.submitNode({ runId: 'run', nodeId: 'build', actor: {
    id: 'worker', kind: 'agent', roles: [], executionId: 'execution-1' }, output: { value: 'stale' }, expectedRunDigest: beforeDigest
  }), /Run changed since validation/);
  assert.equal((await staleEngine.getRun('run')).hostValidationId, afterValidState[0].document.runs.run.hostValidationId);

  const invalid = await finalizePackRuntimeValidation(db, { companyId, runId: 'run', expectedStateRevision: 8,
    sourceDigest: 'sha256:' + 'b'.repeat(64), validation: { status: 'invalid', issues: [{ code: 'bad', path: 'node.output', message: 'Bad payload', action: 'Repair payload' }], validatedSubjectRefs: [] },
    identity: firstIdentity, actor: owner, reason: 'Record invalid data despite existing pin' });
  assert.equal(invalid.validationRevision, 2);
  assert.equal(invalid.rebound, false);
  assert.deepEqual(invalid.previousIdentity, firstIdentity);
  assert.equal((await getLatestPackRuntimeValidation(db, companyId, 'run')).status, 'invalid');
  const afterInvalidState = await sql.unsafe(`SELECT revision,document FROM ${namespace}.graph_state WHERE company_id=$1`, [companyId]);
  assert.equal(Number(afterInvalidState[0].revision), 9);
  assert.equal(afterInvalidState[0].document.revision, 9);
  assert.ok(afterInvalidState[0].document.runs.run.hostValidationId);
  const preservedBinding = await sql.unsafe(`SELECT pack_digest,adapter_version FROM ${namespace}.graph_pack_runtime WHERE company_id=$1 AND graph_run_id='run'`, [companyId]);
  assert.equal(preservedBinding[0].pack_digest, firstIdentity.packDigest);
  assert.equal(preservedBinding[0].adapter_version, firstIdentity.adapterVersion);

  const valid = await finalizePackRuntimeValidation(db, { companyId, runId: 'run', expectedStateRevision: 9,
    sourceDigest: 'sha256:' + 'c'.repeat(64), validation: { status: 'valid', issues: [], validatedSubjectRefs: [{ id: 'candidate', version: '1' }] },
    identity: firstIdentity, actor: owner, reason: 'Revalidate repaired payload' });
  assert.equal(valid.validationRevision, 3);
  assert.equal(valid.rebound, true);
  assert.deepEqual(valid.previousIdentity, firstIdentity);

  const nextIdentity = { ...identity, adapterVersion: '2', adapterBundleDigest: 'sha256:new-bundle' };
  const rebound = await finalizePackRuntimeValidation(db, { companyId, runId: 'run', expectedStateRevision: 10,
    sourceDigest: 'sha256:' + 'd'.repeat(64), validation: { status: 'valid', issues: [], validatedSubjectRefs: [] },
    identity: nextIdentity, actor: owner, reason: 'Revalidate for updated trusted runtime' });
  assert.equal(rebound.validationRevision, 4);
  assert.deepEqual(rebound.previousIdentity, firstIdentity);
  const businessState = await sql.unsafe(`SELECT document FROM ${namespace}.graph_state WHERE company_id=$1`, [companyId]);
  const businessRun = structuredClone(businessState[0].document.runs.run);
  delete businessRun.hostValidationId;
  assert.deepEqual(businessRun, originalBusinessRun, 'recovery must not rewrite Core run business history');
  assert.deepEqual(businessState[0].document.decisions, []);
  assert.deepEqual(businessState[0].document.audit, []);

  let updateLocked, releaseUpdate;
  const updateHasLock = new Promise(resolve => { updateLocked = resolve; });
  const holdUpdate = new Promise(resolve => { releaseUpdate = resolve; });
  const update = sql.begin(async tx => {
    await tx.unsafe(`UPDATE ${namespace}.graph_state SET revision=12,document=jsonb_set(document,'{revision}','12'::jsonb) WHERE company_id=$1`, [companyId]);
    updateLocked();
    await holdUpdate;
  });
  await updateHasLock;
  const stalePending = finalizePackRuntimeValidation(db, { companyId, runId: 'run', expectedStateRevision: 11,
    sourceDigest: 'sha256:' + 'e'.repeat(64), validation: { status: 'valid', issues: [], validatedSubjectRefs: [] },
    identity: firstIdentity, actor: owner, reason: 'Must not commit stale validation' });
  await new Promise(resolve => setTimeout(resolve, 40));
  releaseUpdate();
  await update;
  const stale = await stalePending;
  assert.deepEqual(stale, { committed: false });
  const latest = await getLatestPackRuntimeValidation(db, companyId, 'run');
  assert.equal(latest.revision, 4);
  assert.equal(latest.sourceGraphRevision, 10);
  assert.deepEqual(latest.identity, nextIdentity);
  const binding = await sql.unsafe(`SELECT adapter_version,adapter_bundle_digest FROM ${namespace}.graph_pack_runtime WHERE company_id=$1 AND graph_run_id='run'`, [companyId]);
  assert.equal(binding[0].adapter_version, '2');
  assert.equal(binding[0].adapter_bundle_digest, 'sha256:new-bundle');
});
