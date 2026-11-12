import { createHash } from 'node:crypto';

// Matches the existing trusted adapter identity, not Pack release.digest.
export const canonicalPackJson = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const packDigest = pack => `sha256:${createHash('sha256').update(canonicalPackJson(pack)).digest('hex')}`;

export function createPackSnapshot(packs) {
  return { schemaVersion: 1, packs: packs.map(pack => ({ pack, digest: packDigest(pack) })) };
}

export function readPackSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.packs) || !snapshot.packs.length)
    throw new Error('Invalid Pack catalog snapshot');
  const seen = new Set();
  return snapshot.packs.map(row => {
    const pack = row?.pack;
    if (!pack?.id || !pack?.version || !Array.isArray(pack.graphs) || !pack.roles ||
        row.digest !== packDigest(pack)) throw new Error('Invalid Pack catalog snapshot or digest');
    const key = `${pack.id}:${pack.version}`;
    if (seen.has(key)) throw new Error(`Duplicate published Pack ${key}`);
    seen.add(key);
    return pack;
  });
}
