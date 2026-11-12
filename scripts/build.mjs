import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { CORE_RUNTIME } from '../src/core/compatibility.mjs';
import { createRuntimeArtifact } from './runtime-artifact.mjs';
import { pack as buildAdlcPack } from '../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';
import { pack as buildCreativePack } from '../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/index.mjs';

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
