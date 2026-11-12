import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_RUNTIME } from '../src/core/compatibility.mjs';
import { createRuntimeArtifact } from './runtime-artifact.mjs';
import { readBuildPackSource } from './pack-build-source.mjs';
import { trustedPackImportPlugin } from './trusted-pack-imports.mjs';

const defaultPacksDir = fileURLToPath(new URL('../../Paperclip-PolyForge-Graph-Packs/', import.meta.url));
const packsDir = resolve(process.env.POLYFORGE_PACKS_SOURCE_DIR ?? defaultPacksDir);
const { snapshot, adlc: buildAdlcPack, creative: buildCreativePack } = await readBuildPackSource(packsDir);
function gitInfo(dir) {
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return `${git('rev-parse', 'HEAD')} dirty=${Boolean(git('status', '--porcelain'))}`;
  } catch { return 'unavailable'; }
}
console.log(`Graph source: ${process.cwd()} ${gitInfo(process.cwd())}`);
console.log(`Packs source: ${packsDir} ${gitInfo(packsDir)}`);
for (const { pack, digest } of snapshot.packs) console.log(`Pack ${pack.id}@${pack.version} ${digest}`);
await mkdir('dist', { recursive: true });
const snapshotBytes = `${JSON.stringify(snapshot)}\n`;
const snapshotDigest = createHash('sha256').update(snapshotBytes).digest('hex');
await writeFile('dist/packs-catalog.json', snapshotBytes);

await build({ entryPoints: ['scripts/check-runner.mjs'], outfile: 'dist/check-runner.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node24', packages: 'external', sourcemap: true, logLevel: 'info' });
await build({ entryPoints: ['src/host/check-runner.mjs'], outfile: 'dist/host/check-runner.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node24', packages: 'external', sourcemap: true, logLevel: 'info' });
await build({ entryPoints: ['src/host/experiment.mjs'], outfile: 'dist/host/experiment.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node24', packages: 'external', sourcemap: true, logLevel: 'info' });
await build({ entryPoints: ['src/core/index.mjs'], outfile: 'dist/core/index.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node24', packages: 'external', sourcemap: true, logLevel: 'info' });

await build({ entryPoints: ['src/plugin/trusted-pack-adapters.mjs'], outfile: 'dist/trusted-pack-adapters.mjs',
  bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external',
  plugins: [trustedPackImportPlugin(packsDir)],
  define: { __TRUSTED_ADLC_PACK__: JSON.stringify(JSON.stringify(buildAdlcPack)),
    __TRUSTED_CREATIVE_PACK__: JSON.stringify(JSON.stringify(buildCreativePack)) },
  sourcemap: true, logLevel: 'info' });

for (const entry of ['manifest', 'worker']) {
  await build({
    entryPoints: [`src/plugin/${entry}.mjs`],
    outfile: `dist/${entry}.js`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    packages: 'bundle',
    external: entry === 'worker' ? ['./trusted-pack-adapters.mjs'] : [],
    define: { __POLYFORGE_BUILT__: 'true', __PACK_SNAPSHOT_SHA256__: JSON.stringify(snapshotDigest), ...(entry === 'manifest'
      ? { __BUILT_PACK_CATALOG__: JSON.stringify(snapshot.packs.map(row => row.pack)) } : {}) },
    sourcemap: true,
    logLevel: 'info',
  });
}

await build({ entryPoints: ['src/plugin/catalog-loader-worker.mjs'], outfile: 'dist/catalog-loader-worker.mjs',
  bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external',
  sourcemap: true, logLevel: 'info' });

await build({
  entryPoints: ['src/plugin/ui.jsx'],
  outfile: 'dist/ui/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react-dom', '@paperclipai/plugin-sdk/ui'],
  sourcemap: true,
  logLevel: 'info',
});

const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
await createRuntimeArtifact(process.cwd(), CORE_RUNTIME, packageVersion);
await import('./check-worker-rpc.mjs');
