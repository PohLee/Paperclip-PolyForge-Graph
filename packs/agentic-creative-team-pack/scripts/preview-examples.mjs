import { createServer } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const examplesRoot = path.join(packRoot, 'examples');
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export async function resolveExamplePath(root, requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(new URL(requestPath, 'http://127.0.0.1').pathname); }
  catch { throw Object.assign(new Error('invalid URL path'), { statusCode: 400 }); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(segment => segment === '..')) throw Object.assign(new Error('path traversal is not allowed'), { statusCode: 400 });
  const relative = decoded.replace(/^\/+/, '') || 'interview-demo.html';
  const rootPath = await realpath(root);
  const candidatePath = path.resolve(rootPath, relative);
  const lexicalRelative = path.relative(rootPath, candidatePath);
  if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) throw Object.assign(new Error('only files under examples can be served'), { statusCode: 404 });
  let actualPath;
  try { actualPath = await realpath(candidatePath); } catch { throw Object.assign(new Error('example file not found'), { statusCode: 404 }); }
  const actualRelative = path.relative(rootPath, actualPath);
  if (actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) throw Object.assign(new Error('only files under examples can be served'), { statusCode: 404 });
  const info = await stat(actualPath);
  if (!info.isFile()) throw Object.assign(new Error('only files can be served'), { statusCode: 404 });
  return actualPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--port');
  const requestedPort = flag >= 0 ? Number(process.argv[flag + 1]) : 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new RangeError('--port must be 0–65535');
  const server = createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed'); return; }
    try {
      const file = await resolveExamplePath(examplesRoot, req.url);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') res.end(); else res.end(await (await import('node:fs/promises')).readFile(file));
    } catch (error) { res.writeHead(error.statusCode ?? 500, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }).end(error.statusCode ? error.message : 'Preview failed'); }
  });
  server.listen(requestedPort, '127.0.0.1', () => {
    const address = server.address();
    process.stdout.write(`Previewing examples at http://127.0.0.1:${address.port}/interview-demo.html\nOnly ${examplesRoot} is exposed. Press Ctrl+C to stop.\n`);
  });
}
