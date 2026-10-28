import { randomBytes } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const authFile = join(process.env.USERPROFILE || '', '.codex', 'auth.json');
if (!process.env.USERPROFILE) throw new Error('USERPROFILE is required to locate the existing local Codex login');
await access(authFile);
const path = new URL('../.env.real', import.meta.url);
let current = '';
try { current = await readFile(path, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const entries = new Map(current.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
  const pos = line.indexOf('=');
  return [line.slice(0, pos), line.slice(pos + 1)];
}));
for (const name of ['POLYFORGE_REAL_DB_PASSWORD', 'POLYFORGE_REAL_BETTER_AUTH_SECRET',
  'POLYFORGE_REAL_AGENT_JWT_SECRET', 'POLYFORGE_REAL_TOOL_ACTION_SIGNING_SECRET']) {
  if (!entries.get(name)) entries.set(name, randomBytes(32).toString('hex'));
}
entries.set('POLYFORGE_CODEX_AUTH_FILE', authFile.replaceAll('\\', '/'));
await writeFile(path, [...entries].map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
  { encoding: 'utf8', mode: 0o600 });
console.log('Real-runtime Compose secrets and local read-only Codex auth path are ready in ignored .env.real.');
