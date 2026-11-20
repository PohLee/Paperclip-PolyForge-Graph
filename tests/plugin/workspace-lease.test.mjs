import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceIdentity, createWorkspaceLeaseStore } from '../../src/host/workspace-lease.mjs';
import { createPostgresShadowDatabase, postgresShadowAvailable } from '../helpers/postgres-shadow.mjs';

const caps = { fencedWrites: true, revokesExpiredWriter: true, isolatedGitCredentials: true };
const key = 'b'.repeat(64);

test('missing commondir is a main worktree, dangling commondir is partial creation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pfg-commondir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  assert.equal((await resolveWorkspaceIdentity(root)).commonDir, process.platform === 'win32' ? path.join(root, '.git').toLowerCase() : path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'commondir'), '../missing-common\n');
  await assert.rejects(resolveWorkspaceIdentity(root), { code: 'partial_created' });
  await writeFile(path.join(root, 'common-file'), 'not a directory');
  await writeFile(path.join(root, '.git', 'commondir'), '../common-file\n');
  await assert.rejects(resolveWorkspaceIdentity(root), { code: 'identity_mismatch' });
});

test('a dangling commondir metadata symlink is a partial worktree', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pfg-commondir-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitDir = path.join(root, '.git');
  await mkdir(gitDir);
  try { await symlink(path.join(gitDir, 'missing-metadata'), path.join(gitDir, 'commondir'), 'file'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Creating file symlinks requires permission');
    throw error;
  }
  await assert.rejects(resolveWorkspaceIdentity(root), { code: 'partial_created' });
});

test('acquire never adopts a subsequent same-owner fence between execute and SELECT', async () => {
  let reads = 0;
  const db = { namespace: 'plugin_test', async execute(sql, args) {
    assert.match(sql, /^INSERT /);
    assert.deepEqual(args, [key, 'same-owner', 10, '9007199254740993', '9007199254740992']);
    assert.match(sql, /fence=\$5/);
    return { rowCount: 1 };
  }, async query(sql, args) {
    assert.match(sql, /^SELECT /);
    if (++reads === 1) return [{ fence: '9007199254740992' }];
    assert.match(sql, /owner=\$2 AND fence=\$3 AND NOT released AND expires_at > now\(\)/);
    assert.deepEqual(args, [key, 'same-owner', '9007199254740993']);
    // The later epoch has fence 9007199254740994, so the exact SELECT misses.
    return [];
  } };
  assert.equal(await createWorkspaceLeaseStore(db, caps).acquire({ key, owner: 'same-owner', ttlSeconds: 10 }), null);
});

test('lost acquisition CAS and renewal cannot return another lease receipt', async () => {
  let reads = 0;
  const db = { namespace: 'plugin_test', async query(sql) {
    assert.match(sql, /^SELECT /); reads++;
    return [{ fence: '1' }];
  }, async execute(sql) {
    assert.match(sql, /^(INSERT|UPDATE) /);
    return { rowCount: 0 };
  } };
  const store = createWorkspaceLeaseStore(db, caps);
  assert.equal(await store.acquire({ key, owner: 'one', ttlSeconds: 10 }), null);
  assert.equal(await store.renew({ key, owner: 'one', fence: '1', ttlSeconds: 10 }), null);
  assert.equal(await store.release({ key, owner: 'one', fence: '1' }), false);
  assert.equal(reads, 1);
});

test('PostgreSQL lease writes use SDK execute and keep ownership under contention and epoch races',
  { skip: !postgresShadowAvailable }, async t => {
    const { db, sql, namespace } = await createPostgresShadowDatabase(t);
    const migration = await readFile(new URL('../../migrations/018_workspace_lease.sql', import.meta.url), 'utf8');
    await sql.unsafe(migration.replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace));
    const strict = { namespace, async query(statement, params) {
      assert.match(statement, /^SELECT /);
      return db.query(statement, params);
    }, async execute(statement, params) {
      assert.match(statement, /^(INSERT|UPDATE|DELETE) /);
      assert.doesNotMatch(statement, /RETURNING/i);
      return db.execute(statement, params);
    } };
    const store = createWorkspaceLeaseStore(strict, caps);
    const contenders = await Promise.all(['one', 'two'].map(owner => store.acquire({ key, owner, ttlSeconds: 60 })));
    assert.equal(contenders.filter(Boolean).length, 1);
    const first = contenders.find(Boolean);
    const renewed = await store.renew({ key, owner: first.owner, fence: first.fence, ttlSeconds: 60 });
    assert.equal(String(renewed.fence), '1');
    assert.equal(await store.release({ key, owner: 'wrong', fence: first.fence }), false);
    assert.equal(await store.release({ key, owner: first.owner, fence: first.fence }), true);

    let replaceAfterWrite = true;
    const raced = createWorkspaceLeaseStore({ ...strict, async execute(statement, params) {
      const result = await strict.execute(statement, params);
      if (replaceAfterWrite && statement.startsWith('INSERT') && result.rowCount === 1) {
        replaceAfterWrite = false;
        await sql.unsafe(`UPDATE ${namespace}.graph_workspace_lease SET expires_at=now()-interval '1 second' WHERE workspace_key=$1`, [key]);
        const replacement = await store.acquire({ key, owner: 'same-owner', ttlSeconds: 60 });
        assert.equal(String(replacement.fence), '3');
      }
      return result;
    } }, caps);
    assert.equal(await raced.acquire({ key, owner: 'same-owner', ttlSeconds: 60 }), null);
    assert.equal(await store.renew({ key, owner: first.owner, fence: first.fence, ttlSeconds: 60 }), null);
    assert.equal(await store.release({ key, owner: 'same-owner', fence: '2' }), false);
    assert.equal(await store.release({ key, owner: 'same-owner', fence: '3' }), true);
    assert.equal(String((await store.acquire({ key, owner: 'next', ttlSeconds: 60 })).fence), '4');
  });
