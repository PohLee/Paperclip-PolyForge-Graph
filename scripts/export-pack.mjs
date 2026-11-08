import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GraphEngine, MemoryStore } from '../src/core/index.mjs';

const [entry, packId, output] = process.argv.slice(2);
if (!entry || !packId || !output) throw new Error('Usage: node scripts/export-pack.mjs <trusted-local-index.mjs> <pack-id> <output.json>');
const module = await import(pathToFileURL(resolve(entry)).href);
const matches = (module.packs ?? [module.pack]).filter(pack => pack?.id === packId);
if (matches.length !== 1) throw new Error('The entry must export exactly one selected Pack version');
const pack = matches[0];
await new GraphEngine({ store: new MemoryStore() }).registerPack(pack);
await writeFile(resolve(output), JSON.stringify({ pack }, null, 2) + '\n', { flag: 'wx' });
console.log(`Exported ${pack.id}@${pack.version} to ${resolve(output)}`);
