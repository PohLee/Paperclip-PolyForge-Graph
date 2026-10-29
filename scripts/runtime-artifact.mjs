import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import semver from 'semver';

export const ARTIFACT_FILES = Object.freeze(['package.json', 'dist/core/index.js', 'dist/manifest.js', 'dist/worker.js', 'dist/ui/index.js']);
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

export async function createRuntimeArtifact(root, runtime, pluginVersion) {
  const files = {};
  for (const name of ARTIFACT_FILES) files[name] = sha256(await readFile(resolve(root, name)));
  const artifact = { format: 'polyforge-runtime-artifact-v1', pluginId: 'pohlee.polyforge-graph',
    pluginVersion, runtime, files };
  await writeFile(resolve(root, 'dist/runtime-artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

/** Verify bytes only. Candidate modules are never imported or executed. */
export async function verifyRuntimeArtifact(candidateRoot) {
  const root = resolve(candidateRoot);
  const metadataBytes = await readFile(resolve(root, 'dist/runtime-artifact.json'));
  const artifact = JSON.parse(metadataBytes.toString('utf8'));
  if (artifact.format !== 'polyforge-runtime-artifact-v1' || artifact.pluginId !== 'pohlee.polyforge-graph' ||
      !semver.valid(artifact.pluginVersion) ||
      !artifact.runtime || artifact.runtime.version !== artifact.pluginVersion ||
      !Number.isInteger(artifact.runtime.schemaVersion) || artifact.runtime.schemaVersion < 1 ||
      !artifact.runtime.contracts || !artifact.runtime.capabilities ||
      Object.keys(artifact.files ?? {}).sort().join('|') !== [...ARTIFACT_FILES].sort().join('|')) {
    throw new Error('Invalid candidate runtime artifact metadata');
  }
  for (const name of ARTIFACT_FILES) {
    const expected = artifact.files[name];
    if (!digestPattern.test(expected) || sha256(await readFile(resolve(root, name))) !== expected) {
      throw new Error(`Candidate artifact byte mismatch: ${name}`);
    }
  }
  const packageMetadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (packageMetadata.version !== artifact.pluginVersion) throw new Error('Candidate package version does not match runtime metadata');
  return { artifact, metadataDigest: sha256(metadataBytes), candidateRoot: root };
}
