import { build } from 'esbuild';

await build({ entryPoints: ['scripts/check-runner.mjs'], outfile: 'dist/check-runner.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node24', packages: 'external', sourcemap: true, logLevel: 'info' });
await build({ entryPoints: ['src/host/check-runner.mjs'], outfile: 'dist/host/check-runner.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node24', packages: 'external', sourcemap: true, logLevel: 'info' });

for (const entry of ['manifest', 'worker']) {
  await build({
    entryPoints: [`src/plugin/${entry}.mjs`],
    outfile: `dist/${entry}.js`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    packages: 'external',
    sourcemap: true,
    logLevel: 'info',
  });
}

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
