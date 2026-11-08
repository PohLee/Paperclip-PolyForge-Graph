import { parentPort, workerData } from 'node:worker_threads';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

try {
  const packs = [];
  const releases = new Map();
  for (const entry of workerData.entries) {
    try { await access(entry); } catch { continue; }
    if (!/\.mjs$/i.test(entry)) throw new Error('Pack catalog entries must be installed .mjs modules');
    const module = await import(pathToFileURL(entry).href);
    const available = Array.isArray(module.packs) ? module.packs : module.pack ? [module.pack] : [];
    // postMessage performs the structured clone. Function-bearing Pack data is
    // intentionally rejected; trusted wrapper functions stay in host modules.
    for (const pack of available) {
      const key = `${pack?.id}:${pack?.version}`;
      if (releases.has(key) && releases.get(key) !== pack) throw new Error(`Duplicate published Pack ${pack.id}@${pack.version}`);
      if (!releases.has(key)) { releases.set(key, pack); packs.push(pack); }
    }
    if (workerData.stopAfterFirst && packs.length) break;
  }
  parentPort.postMessage({ packs });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
