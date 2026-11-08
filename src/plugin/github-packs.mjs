import { createHash } from 'node:crypto';
import semver from 'semver';
import { MemoryStore, GraphEngine } from '../core/index.mjs';

const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const table = db => {
  if (!/^plugin_[a-z0-9_]+$/.test(db.namespace)) throw new Error('Invalid database namespace');
  return `${db.namespace}.graph_imported_packs`;
};
export async function importedPacks(db) {
  return (await db.query(`SELECT document FROM ${table(db)} ORDER BY pack_id,version`, [])).map(row => json(row.document));
}
export function mergeCatalogs(local, imported) {
  const result = new Map();
  for (const pack of [...local, ...imported]) {
    const key = `${pack.id}@${pack.version}`;
    if (result.has(key) && canonical(result.get(key)) !== canonical(pack)) throw new Error(`Published Pack ${key} changed without a version bump`);
    result.set(key, pack);
  }
  return [...result.values()];
}
export function githubSource(value) {
  const repository = String(value?.repository ?? '').replace(/^https:\/\/github\.com\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) throw new Error('Use a GitHub owner/repository or repository URL');
  const ref = String(value?.ref ?? '').trim();
  const path = String(value?.path ?? '').trim();
  if (!ref || ref.length > 200 || !/^[A-Za-z0-9_./-]+$/.test(ref) || ref.split('/').some(p => p === '..')) throw new Error('Choose a branch, tag or commit');
  if (!path.endsWith('.json') || path.length > 500 || !/^[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Choose a repository-relative Pack JSON file');
  return { repository, ref, path };
}
async function fetchJson(url, fetcher, maxBytes = 5 * 1024 * 1024) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}. Check the public repository, ref and file path.`);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('Pack JSON exceeds the 5 MB import limit');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('The GitHub file must be exported Pack JSON, not JavaScript'); }
}
export function createGithubPacks({ db, registry, fetcher = fetch }) {
  return {
    async sources(companyId) {
      return (await db.query(`SELECT pack_id,version,source,digest FROM ${table(db)} WHERE company_id=$1 ORDER BY created_at DESC`, [companyId]))
        .map(row => ({ packId: row.pack_id, version: row.version, source: json(row.source), digest: row.digest }));
    },
    async preview(input) {
      const source = githubSource(input);
      const commit = /^[a-f0-9]{40}$/i.test(source.ref) ? source.ref :
        (await fetchJson(`https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`, fetcher)).sha;
      if (!/^[a-f0-9]{40}$/i.test(commit ?? '')) throw new Error('GitHub did not resolve an immutable commit');
      const document = await fetchJson(`https://raw.githubusercontent.com/${source.repository}/${commit}/${source.path}`, fetcher);
      const pack = document.pack ?? document;
      if (!semver.valid(pack?.version)) throw new Error('Pack version must be a valid semantic version');
      const validator = new GraphEngine({ store: new MemoryStore() });
      await validator.registerPack(pack);
      const digest = createHash('sha256').update(canonical(pack)).digest('hex');
      return { pack, preview: { packId: pack.id, version: pack.version, digest,
        source: { ...source, ref: commit }, requestedRef: source.ref,
        roles: Object.keys(pack.roles), graphs: pack.graphs.map(graph => graph.id),
        coreRange: pack.compatibility?.coreRange ?? '*' } };
    },
    async install(companyId, candidate) {
      const { pack, preview } = candidate;
      return registry.install(companyId, pack, async () => {
        await db.execute(`INSERT INTO ${table(db)} (pack_id,version,company_id,document,source,digest)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (pack_id,version) DO NOTHING`,
        [pack.id, pack.version, companyId, JSON.stringify(pack), JSON.stringify(preview.source), preview.digest]);
        const rows = await db.query(`SELECT digest FROM ${table(db)} WHERE pack_id=$1 AND version=$2`, [pack.id, pack.version]);
        if (rows[0]?.digest !== preview.digest) throw new Error('Published Pack already exists with different content. Publish a new version.');
      });
    },
  };
}
