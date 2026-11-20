import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceIdentity, classifyWorkspaceRecovery, createWorkspaceLeaseStore, authorizeWorkspaceIdentity } from '../../src/host/workspace-lease.mjs';
import { admitDeclaredWorkspaceWrite } from '../../src/plugin/workspace-admission.mjs';
import { checkMcpDeploymentInventory, checkMcpConfigBudget } from '../../src/host/mcp-deployment-policy.mjs';

const caps = { fencedWrites: true, revokesExpiredWriter: true, isolatedGitCredentials: true };
test('real path aliases and linked worktrees share a contention identity; recovery detects changed workspace', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'pfg-lease-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo'); const linked = path.join(base, 'linked');
  await mkdir(path.join(repo, '.git', 'worktrees', 'one'), { recursive: true });
  await mkdir(linked);
  await writeFile(path.join(linked, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'one')}\n`);
  await writeFile(path.join(repo, '.git', 'worktrees', 'one', 'commondir'), '../..\n');
  const a = await resolveWorkspaceIdentity(repo); const b = await resolveWorkspaceIdentity(linked);
  assert.equal(a.key, b.key);
  await assert.rejects(authorizeWorkspaceIdentity(b, [linked]), { code: 'identity_mismatch' });
  assert.equal((await authorizeWorkspaceIdentity(b, [base])).key, a.key);
  assert.equal(classifyWorkspaceRecovery({ expected: a, actual: b }), 'identity_mismatch');
  assert.equal(classifyWorkspaceRecovery({ expected: a, actual: a }), 'ready');
  assert.equal(classifyWorkspaceRecovery({ creationState: 'partial_created' }), 'partial_created');
  assert.equal(classifyWorkspaceRecovery({ expected: a }), 'transient');
  try {
    const alias = path.join(base, 'alias'); await symlink(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await resolveWorkspaceIdentity(alias)).key, a.key);
    assert.equal((await resolveWorkspaceIdentity(alias)).root, a.root);
  } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  await assert.rejects(resolveWorkspaceIdentity(path.join(base, 'missing')), { code: 'partial_created' });
});

test('configuration budgets limit depth, breadth and pattern text without executing patterns', () => {
  let deep = {}; for (let i = 0; i < 14; i++) deep = { child: deep };
  assert.equal(checkMcpConfigBudget(deep).ok, false);
  assert.equal(checkMcpConfigBudget({ pattern: 'x'.repeat(257) }).ok, false);
  assert.equal(checkMcpConfigBudget({ pattern: '(a+)+$' }).ok, true);
  assert.equal(checkMcpConfigBudget(JSON.parse('{"__proto__":{}}')).ok, false);
  assert.equal(checkMcpConfigBudget(Array(101).fill(null)).ok, false);
});

test('durable lease contract handles contention, stale fencing, release and re-acquisition', async () => {
  // This fake models SQL atomicity; PostgreSQL execution requires host integration testing.
  let row; let now = 0;
  const db = { namespace: 'plugin_test', async query(sql, args) {
    assert.match(sql, /^SELECT /);
    if (sql.startsWith('SELECT fence ')) return row ? [{ fence: row.fence }] : [];
    if (!row || row.owner !== args[1] || row.fence !== Number(args[2]) || row.released || row.expires <= now) return [];
    return [{ ...row }];
  }, async execute(sql, args) {
    if (sql.startsWith('INSERT')) {
      if (row && ((!row.released && row.expires > now) || row.fence !== Number(args[4]))) return { rowCount: 0 };
      row = { owner: args[1], fence: Number(args[3]), expires: now + args[2], released: false };
      return { rowCount: 1 };
    }
    if (!row || row.owner !== args[1] || row.fence !== Number(args[2]) || row.released || row.expires <= now) return { rowCount: 0 };
    if (sql.includes('SET released')) row.released = true; else row.expires = now + args[3];
    return { rowCount: 1 };
  } };
  const store = createWorkspaceLeaseStore(db, caps); const key = 'a'.repeat(64);
  const first = await store.acquire({ key, owner: 'one', ttlSeconds: 10 });
  assert.equal(first.fence, 1);
  assert.equal(await store.acquire({ key, owner: 'two', ttlSeconds: 10 }), null);
  now = 11;
  const second = await store.acquire({ key, owner: 'two', ttlSeconds: 10 });
  assert.equal(second.fence, 2);
  assert.equal(await store.release({ key, owner: 'one', fence: 1 }), false);
  assert.equal(await store.release({ key, owner: 'two', fence: 2 }), true);
  assert.equal((await store.acquire({ key, owner: 'three', ttlSeconds: 10 })).fence, 3);
  assert.throws(() => createWorkspaceLeaseStore(db, {}), { code: 'host_capability_missing' });
});

test('declared writes fail closed while undeclared work is explicitly unmanaged', async () => {
  assert.deepEqual(await admitDeclaredWorkspaceWrite({ host: {}, declaration: undefined }), { mode: 'legacy_unmanaged' });
  await assert.rejects(admitDeclaredWorkspaceWrite({ host: {}, declaration: 'exclusive' }), { code: 'host_capability_missing' });
  await assert.rejects(admitDeclaredWorkspaceWrite({ host: { workspaceCapabilities: caps, admitFencedWorkspace: async () => ({}) }, declaration: 'exclusive' }), { code: 'host_capability_missing' });
});

test('MCP inventory requires bounded exact secret-free schema and minimum versions', () => {
  const inventory = { schema: 'polyforge.mcp-inventory.v1', complete: true, servers: [{ id: 'git', kind: 'git', version: '2026.11.18' }] };
  assert.equal(checkMcpDeploymentInventory(inventory).ok, true);
  assert.equal(checkMcpDeploymentInventory({ ...inventory, complete: false }).ok, false);
  assert.equal(checkMcpDeploymentInventory({ ...inventory, servers: [{ ...inventory.servers[0], version: '2026.11.17' }] }).ok, false);
  assert.equal(checkMcpDeploymentInventory({ ...inventory, servers: [{ ...inventory.servers[0], env: {} }] }).ok, false);
  assert.equal(checkMcpDeploymentInventory({ ...inventory, servers: [...inventory.servers, ...inventory.servers] }).ok, false);
  assert.equal(checkMcpDeploymentInventory({ ...inventory, servers: [{ id: 'fs', kind: 'filesystem', version: '2026.8.31' }] }).ok, false);
});

test('pinned graph write declaration is checked before slot admission', async () => {
  const { createDispatchAdmission } = await import('../../src/plugin/dispatch-admission.mjs');
  const run = { id: 'r', status: 'running', deliveryKey: 'delivery', graph: { nodes: [{ id: 'n', workspace: { writeAccess: 'exclusive' } }] }, nodeStates: { n: { status: 'pending', attempts: [] } } };
  let reservations = 0;
  const admission = await createDispatchAdmission({ reserveSlot: async () => { reservations++; return true; } }, async () => []).prepare('company', run);
  assert.deepEqual(await admission.admit('n', 1, 'work'), {
    admitted: false, status: 'blocked', reason: 'workspace_admission_unavailable', code: 'host_capability_missing',
  });
  assert.equal(reservations, 0);
});

test('workspace policy precedes capacity and own-key admission', async (t) => {
  const { createDispatchAdmission } = await import('../../src/plugin/dispatch-admission.mjs');
  for (const writeAccess of ['exclusive', 'invalid']) for (const own of [false, true]) {
    await t.test(`${writeAccess}, existing=${own}`, async () => {
      const run = { id: 'r', status: 'running', deliveryKey: 'delivery', deliveryLimits: { parallelAgents: 0 },
        graph: { nodes: [{ id: 'n', workspace: { writeAccess } }] }, nodeStates: { n: { status: 'pending', attempts: [] } } };
      let reservations = 0;
      const admission = await createDispatchAdmission({ reserveSlot: async () => { reservations++; return true; } },
        async () => own ? [{ runId: 'r', nodeId: 'n', attempt: 1, phase: 'work' }] : []).prepare('company', run);
      const result = await admission.admit('n', 1, 'work');
      assert.equal(result.admitted, false);
      assert.equal(result.status, 'blocked');
      assert.equal(result.reason, writeAccess === 'exclusive' ? 'workspace_admission_unavailable' : 'invalid_workspace_declaration');
      assert.equal(reservations, 0);
    });
  }
});

test('admission returns structured success and deferral without repeating reservations', async () => {
  const { createDispatchAdmission } = await import('../../src/plugin/dispatch-admission.mjs');
  const run = { id: 'r', status: 'running', deliveryKey: 'delivery', deliveryLimits: { parallelAgents: 1 },
    graph: { nodes: [{ id: 'a' }, { id: 'b' }] }, nodeStates: {
      a: { status: 'pending', attempts: [] }, b: { status: 'pending', attempts: [] },
    } };
  let reservations = 0;
  const admission = await createDispatchAdmission({ reserveSlot: async () => { reservations++; return true; } }, async () => []).prepare('company', run);
  assert.deepEqual(await admission.admit('a', 1, 'work'), { admitted: true });
  assert.deepEqual(await admission.admit('a', 1, 'work'), { admitted: true });
  assert.deepEqual(await admission.admit('b', 1, 'work'), { admitted: false, status: 'deferred_agent_limit' });
  assert.equal(reservations, 1);
  await assert.rejects(admission.admit('missing', 1, 'work'), /not in the pinned graph/);
  const contended = await createDispatchAdmission({ reserveSlot: async () => false }, async () => []).prepare('company', run);
  assert.deepEqual(await contended.admit('a', 1, 'work'), { admitted: false, status: 'deferred_agent_limit' });
  const brokenStore = await createDispatchAdmission({ reserveSlot: async () => { throw new Error('Store unavailable'); } }, async () => []).prepare('company', run);
  await assert.rejects(brokenStore.admit('a', 1, 'work'), /Store unavailable/);
});

test('host receipt is bound to the resolved authorized identity, dispatch and expiry', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pfg-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  const identity = await resolveWorkspaceIdentity(root);
  const context = { companyId: 'c', runId: 'r', nodeId: 'n', attempt: 1, phase: 'work' };
  let receipt = { ...context, workspaceKey: identity.key, fence: '1', enforced: true, expiresAt: new Date(Date.now() + 60000).toISOString() };
  const host = { workspaceCapabilities: caps, resolveTrustedWorkspace: async () => ({ identity, allowedRoots: [root] }), admitFencedWorkspace: async () => receipt };
  assert.equal((await admitDeclaredWorkspaceWrite({ declaration: 'exclusive', context, host })).mode, 'fenced');
  receipt = { ...receipt, runId: 'another' };
  await assert.rejects(admitDeclaredWorkspaceWrite({ declaration: 'exclusive', context, host }), { code: 'identity_mismatch' });
  receipt = { ...receipt, runId: 'r', expiresAt: new Date(0).toISOString() };
  await assert.rejects(admitDeclaredWorkspaceWrite({ declaration: 'exclusive', context, host }), { code: 'identity_mismatch' });
});
