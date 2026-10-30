import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphEngine } from '../../../src/core/index.mjs';
import { pack, createCreativeHostApi } from '../index.mjs';

const packRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = new GraphEngine({ availableCapabilities: {} });
await engine.registerPack(pack);
const host = createCreativeHostApi({
  engine,
  artifactRootForRun: run => path.join(packRoot, '.host-artifacts', run.id),
  resolveActor: ({ claimedActor }) => {
    if (!claimedActor || !['human','agent'].includes(claimedActor.kind)) throw new Error('Authenticate the host caller before starting work');
    return { ...claimedActor, executionId: claimedActor.executionId ?? 'smoke-host-session' };
  },
  hasImageProvider: async () => false,
});
const run = await host.startRun({
  packId: pack.id,
  packVersion: pack.version,
  graphId: 'creative-intake',
  mode: 'manual',
  actor: { id: 'smoke-human', kind: 'human', roles: ['human-owner'], executionId: 'smoke-host-session' },
});
const ready = await engine.getReadyNodes(run.id);
console.log(`Loaded ${pack.id}@${pack.version}: ${pack.graphs.length} graphs, ${Object.keys(pack.roles).length} roles, ${Object.keys(pack.skills).length} skills.`);
console.log(`Started creative-intake; first ready task: ${ready.map(item => item.id).join(', ') || '(none)'}.`);
