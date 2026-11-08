import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import semver from 'semver';

export const ARTIFACT_FILES = Object.freeze(['package.json', 'dist/core/index.js', 'dist/manifest.js', 'dist/worker.js', 'dist/ui/index.js',
  'dist/catalog-loader-worker.mjs', 'dist/trusted-pack-adapters.mjs', 'dist/check-runner.js', 'dist/host/check-runner.js', 'dist/host/experiment.js']);
export const RUNTIME_ARTIFACT_FORMAT = 'polyforge-runtime-artifact-v2';
export const MIGRATIONS_DIR = 'migrations';
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function checkedFile(root, name) {
  const candidate = resolve(root, name);
  if (!inside(root, candidate)) throw new Error(`Runtime artifact path escapes candidate root: ${name}`);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Runtime artifact path must be a regular file: ${name}`);
  const actual = await realpath(candidate);
  if (!inside(root, actual)) throw new Error(`Runtime artifact symlink escapes candidate root: ${name}`);
  return readFile(actual);
}

async function migrationDigests(root) {
  const directory = resolve(root, MIGRATIONS_DIR);
  const dirInfo = await lstat(directory);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error('Runtime migrations path must be a regular directory');
  const result = {};
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Runtime migration symlink is not allowed: ${relative(root, path)}`);
      if (info.isDirectory()) { await visit(path); continue; }
      if (!info.isFile()) throw new Error(`Runtime migration entry must be a regular file: ${relative(root, path)}`);
      const actual = await realpath(path);
      if (!inside(root, actual)) throw new Error(`Runtime migration path escapes candidate root: ${relative(root, path)}`);
      const name = `${MIGRATIONS_DIR}/${relative(directory, path).split(sep).join('/')}`;
      result[name] = sha256(await readFile(actual));
    }
  }
  await visit(directory);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export async function createRuntimeArtifact(root, runtime, pluginVersion) {
  const candidateRoot = await realpath(resolve(root));
  const files = {};
  for (const name of ARTIFACT_FILES) files[name] = sha256(await checkedFile(candidateRoot, name));
  const artifact = { format: RUNTIME_ARTIFACT_FORMAT, pluginId: 'pohlee.polyforge-graph',
    pluginVersion, runtime, files, migrations: await migrationDigests(candidateRoot) };
  const artifactPath = resolve(candidateRoot, 'dist/runtime-artifact.json');
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

/** Verify bytes only. Candidate modules are never imported or executed. */
export async function verifyRuntimeArtifact(candidateRoot) {
  const root = await realpath(resolve(candidateRoot));
  const metadataBytes = await checkedFile(root, 'dist/runtime-artifact.json');
  const artifact = JSON.parse(metadataBytes.toString('utf8'));
  if (artifact.format !== RUNTIME_ARTIFACT_FORMAT || artifact.pluginId !== 'pohlee.polyforge-graph' ||
      !semver.valid(artifact.pluginVersion) ||
      !artifact.runtime || artifact.runtime.version !== artifact.pluginVersion ||
      !Number.isInteger(artifact.runtime.schemaVersion) || artifact.runtime.schemaVersion < 1 ||
      !artifact.runtime.contracts || !artifact.runtime.capabilities ||
      Object.keys(artifact.files ?? {}).sort().join('|') !== [...ARTIFACT_FILES].sort().join('|') ||
      !artifact.migrations || typeof artifact.migrations !== 'object' || Array.isArray(artifact.migrations)) {
    throw new Error(`Invalid candidate runtime artifact metadata (expected ${RUNTIME_ARTIFACT_FORMAT}; regenerate legacy artifacts)`);
  }
  for (const name of ARTIFACT_FILES) {
    const expected = artifact.files[name];
    if (!digestPattern.test(expected) || sha256(await checkedFile(root, name)) !== expected) {
      throw new Error(`Candidate artifact byte mismatch: ${name}`);
    }
  }
  const currentMigrations = await migrationDigests(root);
  const expectedMigrations = Object.keys(artifact.migrations).sort();
  if (expectedMigrations.some(name => !name.startsWith(`${MIGRATIONS_DIR}/`) || name.includes('\\') ||
      name.split('/').some(part => !part || part === '.' || part === '..')) ||
      expectedMigrations.join('|') !== Object.keys(currentMigrations).sort().join('|')) {
    throw new Error('Candidate migration inventory mismatch');
  }
  for (const name of expectedMigrations) {
    if (!digestPattern.test(artifact.migrations[name]) || artifact.migrations[name] !== currentMigrations[name]) {
      throw new Error(`Candidate migration byte mismatch: ${name}`);
    }
  }
  const packageMetadata = JSON.parse((await checkedFile(root, 'package.json')).toString('utf8'));
  if (packageMetadata.version !== artifact.pluginVersion) throw new Error('Candidate package version does not match runtime metadata');
  return { artifact, metadataDigest: sha256(metadataBytes), candidateRoot: root };
}
