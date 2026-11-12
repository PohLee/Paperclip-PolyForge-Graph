import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { packDigest } from './pack-snapshot.mjs';
import { createAdlcHostApi } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/runtime/host-api.mjs';
import { createCreativeHostApi, creativeRequiredServicesByGraph } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/runtime/host-api.mjs';

const embeddedPack = typeof __TRUSTED_ADLC_PACK__ === 'string';
export const adapterBuildMode = embeddedPack ? 'compiled-bundle' : 'source-test';
const adlcPack = embeddedPack ? JSON.parse(__TRUSTED_ADLC_PACK__)
  : (await import('../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs')).pack;
const embeddedCreativePack = typeof __TRUSTED_CREATIVE_PACK__ === 'string';
const creativePack = embeddedCreativePack ? JSON.parse(__TRUSTED_CREATIVE_PACK__)
  : (await import('../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/index.mjs')).pack;

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

// This descriptor is compiled into the plugin from the known, local Pack
// installation. Pack catalog fields cannot add or replace an adapter.
export const trustedPackAdapters = Object.freeze([Object.freeze({
  adapterId: 'adlc-host-api',
  adapterVersion: '1',
  packId: adlcPack.id,
  packVersion: adlcPack.version,
  packDigest: packDigest(adlcPack),
  createHostApi: createAdlcHostApi,
}), Object.freeze({
  adapterId: 'creative-team-host-api',
  adapterVersion: '1',
  packId: creativePack.id,
  packVersion: creativePack.version,
  packDigest: packDigest(creativePack),
  graphRequirements: Object.freeze(Object.fromEntries(Object.entries(creativeRequiredServicesByGraph).map(([graphId, services]) =>
    [graphId, Object.freeze({ services, imageProvider: graphId === 'concept-sprint', imageDecoder: services.includes('decodeImage') })]))),
  createHostApi: createCreativeHostApi,
})]);

export const adapterBundleDigest = digest(await readFile(fileURLToPath(import.meta.url)));
