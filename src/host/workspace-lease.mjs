import { lstat, realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class WorkspaceLeaseError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkspaceLeaseError'; this.code = code; }
}
const fail = (code, message) => { throw new WorkspaceLeaseError(code, message); };
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
async function boundedFile(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > 4096) fail('identity_mismatch', 'Invalid Git metadata file');
  return (await readFile(file, 'utf8')).trim();
}
/** Resolve without running Git, repository hooks, or reading Git configuration. */
export async function resolveWorkspaceIdentity(workspace) {
  try {
    const root = await realpath(workspace);
    if (!(await stat(root)).isDirectory()) fail('identity_mismatch', 'Workspace is not a directory');
    const dotgit = path.join(root, '.git');
    const info = await stat(dotgit);
    let gitDir = dotgit;
    if (info.isFile()) {
      const content = await boundedFile(dotgit);
      if (!/^gitdir: [^\r\n]+$/.test(content)) fail('identity_mismatch', 'Invalid Git directory reference');
      gitDir = path.resolve(root, content.slice(8));
    } else if (!info.isDirectory()) fail('identity_mismatch', 'Invalid Git directory');
    gitDir = await realpath(gitDir);
    if (!(await stat(gitDir)).isDirectory()) fail('identity_mismatch', 'Invalid Git directory');
    let commonDir = gitDir;
    const commonFile = path.join(gitDir, 'commondir');
    const commonEntry = await lstat(commonFile).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (commonEntry) {
      const commonReference = await boundedFile(commonFile);
      if (!commonReference || /[\r\n]/.test(commonReference)) fail('identity_mismatch', 'Invalid common Git directory reference');
      // Missing metadata is valid for a main worktree; an existing reference to
      // missing metadata is a partially created workspace and cannot be ready.
      commonDir = await realpath(path.resolve(gitDir, commonReference));
      if (!(await stat(commonDir)).isDirectory()) fail('identity_mismatch', 'Invalid common Git directory');
    }
    const identity = { root: canonical(root), gitDir: canonical(gitDir), commonDir: canonical(commonDir) };
    // The common Git directory is the contention domain: linked worktrees share config.
    return { ...identity, key: createHash('sha256').update(identity.commonDir).digest('hex') };
  } catch (error) {
    if (error instanceof WorkspaceLeaseError) throw error;
    fail(error.code === 'ENOENT' ? 'partial_created' : 'transient', 'Cannot resolve workspace identity');
  }
}
export function assertWorkspaceHostCapabilities(capabilities) {
  if (capabilities?.fencedWrites !== true || capabilities?.revokesExpiredWriter !== true ||
      capabilities?.isolatedGitCredentials !== true) {
    fail('host_capability_missing', 'Host must enforce fencing, revoke expired writers, and isolate Git credentials');
  }
}
export function classifyWorkspaceRecovery({ expected, actual, creationState }) {
  if (creationState === 'partial_created') return 'partial_created';
  if (!actual) return 'transient';
  if (!expected || expected.key !== actual.key || expected.root !== actual.root || expected.gitDir !== actual.gitDir)
    return 'identity_mismatch';
  return 'ready';
}
/** Authorize both the worktree and Git metadata against host-provided roots. */
export async function authorizeWorkspaceIdentity(expected, allowedRoots) {
  if (!expected?.root || !Array.isArray(allowedRoots) || !allowedRoots.length || allowedRoots.length > 32)
    fail('identity_mismatch', 'Trusted workspace identity and allowed roots are required');
  const actual = await resolveWorkspaceIdentity(expected.root);
  if (classifyWorkspaceRecovery({ expected, actual }) !== 'ready')
    fail('identity_mismatch', 'Resolved workspace changed');
  const roots = await Promise.all(allowedRoots.map(async root => canonical(await realpath(root))));
  const within = value => roots.some(root => {
    const relative = path.relative(root, value);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (![actual.root, actual.gitDir, actual.commonDir].every(within))
    fail('identity_mismatch', 'Workspace or Git metadata is outside authorized roots');
  return actual;
}
function table(db) {
  if (!/^plugin_[a-z0-9_]+$/.test(db?.namespace ?? '')) throw new Error('Invalid host database namespace');
  return `${db.namespace}.graph_workspace_lease`;
}
function valid({ key, owner, ttlSeconds }) {
  if (!/^[a-f0-9]{64}$/.test(key ?? '') || typeof owner !== 'string' || !owner || owner.length > 256 ||
      !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error('Invalid workspace lease request');
}
/** Database lease alone does not fence processes; callers must supply an enforcing host. */
export function createWorkspaceLeaseStore(db, capabilities) {
  assertWorkspaceHostCapabilities(capabilities);
  const name = table(db);
  return {
    async acquire({ key, owner, ttlSeconds }) {
      valid({ key, owner, ttlSeconds });
      const previous = await db.query(`SELECT fence FROM ${name} WHERE workspace_key=$1`, [key]);
      const expectedFence = previous[0]?.fence ?? '0';
      const fence = String(BigInt(expectedFence) + 1n);
      // execute returns only rowCount. Bind a known next fence to a CAS so a
      // later SELECT cannot accidentally return a competing owner's receipt,
      // even when the competing acquisition uses the same owner string.
      const result = await db.execute(`INSERT INTO ${name} (workspace_key,owner,fence,expires_at,released)
        VALUES ($1,$2,$4,now()+$3 * interval '1 second',false)
        ON CONFLICT (workspace_key) DO UPDATE SET owner=EXCLUDED.owner,
          fence=EXCLUDED.fence, expires_at=EXCLUDED.expires_at, released=false
        WHERE (${name}.released OR ${name}.expires_at <= now()) AND ${name}.fence=$5`,
      [key, owner, ttlSeconds, fence, String(expectedFence)]);
      if (result.rowCount !== 1) return null;
      const rows = await db.query(`SELECT workspace_key,owner,fence,expires_at FROM ${name}
        WHERE workspace_key=$1 AND owner=$2 AND fence=$3 AND NOT released AND expires_at > now()`, [key, owner, fence]);
      return rows[0] ?? null;
    },
    async renew({ key, owner, fence, ttlSeconds }) {
      valid({ key, owner, ttlSeconds });
      if (!/^\d+$/.test(String(fence ?? ''))) throw new Error('Invalid fence');
      const result = await db.execute(`UPDATE ${name} SET expires_at=now()+$4 * interval '1 second'
        WHERE workspace_key=$1 AND owner=$2 AND fence=$3 AND NOT released AND expires_at > now()`, [key, owner, fence, ttlSeconds]);
      if (result.rowCount !== 1) return null;
      const rows = await db.query(`SELECT workspace_key,owner,fence,expires_at FROM ${name}
        WHERE workspace_key=$1 AND owner=$2 AND fence=$3 AND NOT released AND expires_at > now()`, [key, owner, fence]);
      return rows[0] ?? null;
    },
    async release({ key, owner, fence }) {
      valid({ key, owner, ttlSeconds: 1 });
      if (!/^\d+$/.test(String(fence ?? ''))) throw new Error('Invalid fence');
      const result = await db.execute(`UPDATE ${name} SET released=true
        WHERE workspace_key=$1 AND owner=$2 AND fence=$3 AND NOT released AND expires_at > now()`, [key, owner, fence]);
      return result.rowCount === 1;
    },
  };
}
