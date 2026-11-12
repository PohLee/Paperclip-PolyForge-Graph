import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPackSnapshot, readPackSnapshot, packDigest } from '../src/plugin/pack-snapshot.mjs';

export async function readBuildPackSource(dir) {
  const root = resolve(dir);
  const load = path => import(pathToFileURL(resolve(root, path)).href);
  const { packs } = await load('index.mjs');
  const { pack: adlc } = await load('packs/adlc/index.mjs');
  const { pack: creative } = await load('packs/adlc-creative-team/index.mjs');
  if (!Array.isArray(packs)) throw new Error('Pack root index must export packs');
  if (packs.map(pack => pack?.id).sort().join('|') !== 'adlc|creative-team|marketing' ||
      adlc?.id !== 'adlc' || creative?.id !== 'creative-team') {
    throw new Error('Pack root must contain exactly the main ADLC, Creative and Marketing packs');
  }
  const snapshot = createPackSnapshot(packs);
  readPackSnapshot(snapshot);
  for (const pack of [adlc, creative]) {
    if (!pack || !packs.some(item => item.id === pack.id && item.version === pack.version && packDigest(item) === packDigest(pack)))
      throw new Error('Trusted adapter Pack and catalog do not match');
  }
  return { root, snapshot, adlc, creative };
}
