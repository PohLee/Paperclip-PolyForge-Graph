import { access, readFile } from 'node:fs/promises';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import semver from 'semver';
import { readPackSnapshot } from './pack-snapshot.mjs';

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
    .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (deploymentConfig === null || deploymentConfig.packEntries === undefined) return null;
  const entries = deploymentConfig.packEntries;
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

// Several immutable versions may be installed, but managed organizational
// profiles have one stable resource key per Pack role or skill.
export function latestPackReleases(catalog) {
  const latest = new Map();
  for (const pack of catalog) {
    const prior = latest.get(pack.id);
    if (!prior || semver.gt(pack.version, prior.version)) latest.set(pack.id, pack);
  }
  return [...latest.values()];
}

// A fresh worker gives force reload a fresh ESM module graph, including nested
// static imports. Pack releases crossing this boundary must be serializable
// data; executable wrapper functions are resolved by trusted host code.
async function loadEntriesFresh(entries, stopAfterFirst) {
  const worker = new Worker(new URL('./catalog-loader-worker.mjs', import.meta.url), {
    workerData: { entries, stopAfterFirst },
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  });
  return new Promise((resolveResult, rejectResult) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
      void worker.terminate();
    };
    const timeout = setTimeout(() => finish(rejectResult, new Error('Pack catalog reload timed out')), 15000);
    worker.once('message', message => {
      if (message?.error) finish(rejectResult, new Error(message.error));
      else finish(resolveResult, message?.packs ?? []);
    });
    worker.once('error', error => finish(rejectResult, error));
    worker.once('exit', code => {
      if (!settled) finish(rejectResult, new Error(`Pack catalog worker exited with code ${code} before returning data`));
    });
  });
}

export async function loadCatalog({ force = false, entries: suppliedEntries } = {}) {
  const packs = new Map();
  if (suppliedEntries !== undefined && (!Array.isArray(suppliedEntries) ||
      suppliedEntries.some(entry => typeof entry !== 'string' || !entry.trim()))) {
    throw new Error('Pack entries must be an array of paths');
  }
  const root = suppliedEntries === undefined ? await packageRoot() : null;
  const configured = suppliedEntries ?? await configuredEntries(root);
  if (configured === null) {
    let snapshot;
    try { snapshot = await readFile(resolve(root, 'dist/packs-catalog.json'), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT' || (typeof __POLYFORGE_BUILT__ !== 'undefined' && __POLYFORGE_BUILT__)) throw error;
    }
    if (snapshot !== undefined) {
      if (typeof __POLYFORGE_BUILT__ !== 'undefined' && __POLYFORGE_BUILT__ &&
          (typeof __PACK_SNAPSHOT_SHA256__ === 'undefined' ||
           createHash('sha256').update(snapshot).digest('hex') !== __PACK_SNAPSHOT_SHA256__)) {
        throw new Error('Built Pack catalog snapshot does not match build digest');
      }
      return readPackSnapshot(JSON.parse(snapshot));
    }
  }
  if (configured !== null && !configured.length) throw new Error('Explicit Pack entries must not be empty');
  const entries = new Set((configured ?? fallbackEntries(root))
    .map((entry) => resolve(entry)));
  for (const entry of entries) {
    if (configured === null && packs.size) break;
    try { await access(entry); } catch (error) { if (configured !== null) throw error; continue; }
    if (force) continue;
    const module = await import(pathToFileURL(entry).href);
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
  if (force) {
    const freshPacks = await loadEntriesFresh([...entries], configured === null);
    for (const pack of freshPacks) {
      if (!pack?.id || !pack?.version || !Array.isArray(pack.graphs) || !pack.roles) {
        throw new Error('Invalid Pack entry returned by fresh catalog worker');
      }
      const key = resourceKey(pack.id, pack.version);
      if (packs.has(key)) throw new Error(`Duplicate published Pack ${pack.id}@${pack.version}`);
      packs.set(key, pack);
    }
  }
  if (!packs.size) throw new Error('No Pack index.mjs found: configure POLYFORGE_PACK_ENTRIES or POLYFORGE_ADLC_PACK_ENTRY');
  return [...packs.values()];
}

export function selectPack(catalog, packId, version = null) {
  const matches = catalog.filter((pack) => pack.id === packId && (!version || pack.version === version));
  if (!matches.length) throw new Error(`Pack ${packId}${version ? `@${version}` : ''} is not installed`);
  return latestPackReleases(matches)[0];
}
