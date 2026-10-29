import { access, readFile } from 'node:fs/promises';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// The module lives in src/plugin when read directly and in dist after bundling.
// Find the package boundary in both layouts; the Paperclip worker deliberately
// receives a restricted environment, so deployment must also work without env.
async function packageRoot() {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const metadata = await readFile(resolve(current, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (metadata?.name === '@pohlee/paperclip-polyforge-graph') return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('PolyForge plugin package root not found');
    current = parent;
  }
}
async function configuredEntries(root) {
  const collection = [...(process.env.POLYFORGE_PACK_ENTRIES ?? '').split(delimiter).filter(Boolean),
    process.env.POLYFORGE_PACKS_ENTRY].filter(Boolean);
  if (collection.length) return collection;
  if (process.env.POLYFORGE_ADLC_PACK_ENTRY) return [process.env.POLYFORGE_ADLC_PACK_ENTRY];
  const deploymentConfig = await readFile(resolve(root, 'polyforge.runtime.json'), 'utf8')
    .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  const entries = deploymentConfig.packEntries ?? [];
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string' || !entry.trim())) {
    throw new Error('polyforge.runtime.json packEntries must be an array of paths');
  }
  return entries.map(entry => resolve(root, entry));
};
const fallbackEntries = (root) => [
  resolve(root, '../Paperclip-PolyForge-Graph-Packs/index.mjs'),
  resolve(root, '../Paperclip-PolyForge-Graph-ADLC/index.mjs'),
  resolve(root, '../packs/index.mjs'),
];

export const resourceKey = (packId, localId) => `${packId}:${localId}`;

export async function loadCatalog({ force = false, entries: suppliedEntries } = {}) {
  const packs = new Map();
  if (suppliedEntries !== undefined && (!Array.isArray(suppliedEntries) ||
      suppliedEntries.some(entry => typeof entry !== 'string' || !entry.trim()))) {
    throw new Error('Pack entries must be an array of paths');
  }
  const root = suppliedEntries === undefined ? await packageRoot() : null;
  const configured = suppliedEntries ?? await configuredEntries(root);
  const entries = new Set((configured.length ? configured : suppliedEntries === undefined ? fallbackEntries(root) : [])
    .map((entry) => resolve(entry)));
  for (const entry of entries) {
    if (!configured.length && packs.size) break;
    try { await access(entry); } catch { continue; }
    const module = await import(pathToFileURL(entry).href + (force ? `?reload=${randomUUID()}` : ''));
    const available = Array.isArray(module.packs) ? module.packs : module.pack ? [module.pack] : [];
    for (const pack of available) {
      if (!pack?.id || !pack?.version || !Array.isArray(pack.graphs) || !pack.roles) {
        throw new Error(`Invalid Pack entry at ${entry}`);
      }
      const key = resourceKey(pack.id, pack.version);
      if (packs.has(key) && packs.get(key) !== pack) {
        throw new Error(`Duplicate published Pack ${pack.id}@${pack.version}`);
      }
      packs.set(key, pack);
    }
  }
  if (!packs.size) throw new Error('No Pack index.mjs found: configure POLYFORGE_PACK_ENTRIES or POLYFORGE_ADLC_PACK_ENTRY');
  return [...packs.values()];
}

export function selectPack(catalog, packId, version = null) {
  const matches = catalog.filter((pack) => pack.id === packId && (!version || pack.version === version));
  if (!matches.length) throw new Error(`Pack ${packId}${version ? `@${version}` : ''} is not installed`);
  return matches.at(-1);
}
