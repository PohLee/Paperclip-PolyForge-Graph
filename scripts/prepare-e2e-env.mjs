import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../.env', import.meta.url);
let current = '';
try { current = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const entries = new Map(current.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
  const pos = line.indexOf('=');
  return [line.slice(0, pos), line.slice(pos + 1)];
}));
for (const name of ['POLYFORGE_BETTER_AUTH_SECRET', 'POLYFORGE_AGENT_JWT_SECRET', 'POLYFORGE_TOOL_ACTION_SIGNING_SECRET']) {
  if (!entries.get(name)) entries.set(name, randomBytes(32).toString('hex'));
}
await writeFile(path, [...entries].map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { encoding: 'utf8', flag: 'w' });
console.log('E2E secrets are present in .env (existing values preserved).');
