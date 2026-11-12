import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyRuntimeArtifact } from './runtime-artifact.mjs';

// Bind the public evidence identity to an actual archive and the deployed bytes.
export async function candidateMetadata(archive, candidate) {
  if (typeof archive !== 'string' || !archive.trim() || typeof candidate !== 'string' || !candidate.trim())
    throw new Error('Candidate archive and extracted root are required');
  const tarball = resolve(archive), root = resolve(candidate);
  const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  const { artifact } = await verifyRuntimeArtifact(root);
  for (const name of ['dist/runtime-artifact.json', ...Object.keys(artifact.files), ...Object.keys(artifact.migrations)]) {
    const archived = execFileSync('tar', ['-xOf', tarball, `package/${name}`], { maxBuffer: 10 * 1024 * 1024 });
    if (!archived.equals(await readFile(resolve(root, name)))) throw new Error(`Extracted candidate differs from archive: ${name}`);
  }
  return { sha256, version: artifact.pluginVersion };
}
