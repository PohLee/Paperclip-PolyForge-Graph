import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../dist/worker.js', import.meta.url));
const built = await readFile(workerPath, 'utf8');
assert.doesNotMatch(built, /^import\s+.*from\s+["'](?:@paperclipai\/plugin-sdk|semver)["']/m,
  'The worker must bundle its package dependencies for reliable startup on mounted installs');

const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let output = '';
let errorOutput = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { errorOutput += chunk; });

try {
  const initialized = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Worker initialize exceeded 15 seconds: ${errorOutput.slice(0, 500)}`)), 15_000);
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Worker exited before initialize (code ${code}): ${errorOutput.slice(0, 500)}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      for (const line of output.split('\n').slice(0, -1)) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method && message.id !== undefined) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null })}\n`);
          continue;
        }
        if (message.id === 100000) {
          clearTimeout(timeout);
          resolve(message);
          return;
        }
      }
      output = output.slice(output.lastIndexOf('\n') + 1);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 100000, method: 'initialize', params: {
      manifest: { id: 'pohlee.polyforge-graph', tools: [{ name: 'graph-command' }, { name: 'company-command' }] },
      config: {}, databaseNamespace: 'worker_smoke',
    } })}\n`);
  });
  assert.equal(initialized.result?.ok, true, JSON.stringify(initialized.error ?? initialized));
  console.log('Built worker initialized over JSON-RPC within 15 seconds');
} finally {
  child.kill();
}
