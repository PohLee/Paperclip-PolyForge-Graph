import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PLUGIN_CAPABILITIES } from '@paperclipai/plugin-sdk';
import semver from 'semver';
import manifest from '../../src/plugin/manifest.mjs';

test('target SDK supports every declared capability without changing public tools', async () => {
  assert.equal(manifest.minimumHostVersion, '2026.1106.0');
  assert.equal(semver.gte('2026.1106.0', manifest.minimumHostVersion), true);
  for (const oldVersion of ['2026.1023.0', '2026.1022.0', '0.3.1']) {
    assert.equal(semver.gte(oldVersion, manifest.minimumHostVersion), false, oldVersion);
  }
  assert.deepEqual(manifest.capabilities.filter(capability => !PLUGIN_CAPABILITIES.includes(capability)), []);
  assert.deepEqual(manifest.tools.map(tool => tool.name), ['graph-command', 'company-command']);
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url)));
  assert.equal(pkg.dependencies['@paperclipai/plugin-sdk'], '2026.1106.0');
  assert.equal(lock.packages['node_modules/@paperclipai/plugin-sdk'].dependencies['@paperclipai/shared'], '2026.1106.0');
  assert.equal(lock.packages['node_modules/@paperclipai/shared'].version, '2026.1106.0');
});

test('compose files pin the target image and real bootstrap uses its runtime', async () => {
  const pin = 'ghcr.io/paperclipai/paperclip:2026.1106.0@sha256:d6584f05cf57a4b26c117eb083725f18c1fe69ddafa7d16c9f8cce83f6fa17da';
  for (const name of ['e2e', 'enhancement', 'real']) {
    const text = await readFile(new URL(`../../compose.${name}.yml`, import.meta.url), 'utf8');
    assert.ok(text.includes(`image: ${pin}`), name);
    if (name === 'real') {
      assert.match(text, /cp \/run\/secrets\/polyforge-codex-auth\.json/);
      assert.match(text, /exec node server\/dist-runtime\/index\.mjs/);
      assert.doesNotMatch(text, /tsx\/dist\/loader|server\/dist\/index\.js/);
    }
  }
});
