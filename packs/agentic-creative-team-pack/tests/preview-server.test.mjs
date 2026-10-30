import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveExamplePath } from '../scripts/preview-examples.mjs';

test('example preview resolver allows only files in examples and rejects traversal and symlink escapes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'creative-preview-'));
  try {
    const examples = path.join(root, 'examples'), outside = path.join(root, 'secret.txt');
    await mkdir(examples); await writeFile(path.join(examples, 'interview-demo.html'), '<h1>Local demo</h1>'); await writeFile(outside, 'secret');
    assert.equal(await resolveExamplePath(examples, '/'), path.join(examples, 'interview-demo.html'));
    await assert.rejects(resolveExamplePath(examples, '/%2e%2e/secret.txt'));
    await assert.rejects(resolveExamplePath(examples, '/missing.html'));
    try { await symlink(outside, path.join(examples, 'outside.txt'), 'file'); await assert.rejects(resolveExamplePath(examples, '/outside.txt')); }
    catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
  } finally { await rm(root, { recursive: true, force: true }); }
});
