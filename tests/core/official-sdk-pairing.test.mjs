import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PLUGIN_CAPABILITIES } from '@paperclipai/plugin-sdk';
import semver from 'semver';
import manifest from '../../src/plugin/manifest.mjs';

test('target SDK supports declared capabilities and the workflow tool alongside existing tools', async () => {
  assert.equal(manifest.minimumHostVersion, '2026.1106.0');
  assert.equal(semver.gte('2026.1106.0', manifest.minimumHostVersion), true);
  for (const oldVersion of ['2026.1023.0', '2026.1022.0', '0.3.1']) {
    assert.equal(semver.gte(oldVersion, manifest.minimumHostVersion), false, oldVersion);
  }
  assert.deepEqual(manifest.capabilities.filter(capability => !PLUGIN_CAPABILITIES.includes(capability)), []);
  assert.deepEqual(manifest.tools.map(tool => tool.name), ['graph-command', 'workflow-run', 'company-command']);
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url)));
  assert.equal(pkg.dependencies['@paperclipai/plugin-sdk'], '2026.1106.0');
  assert.equal(lock.packages['node_modules/@paperclipai/plugin-sdk'].dependencies['@paperclipai/shared'], '2026.1106.0');
  assert.equal(lock.packages['node_modules/@paperclipai/shared'].version, '2026.1106.0');
});

test('compose files pin the target image and real bootstrap uses its runtime', async () => {
  const hostVersion = '2026.1117.0';
  const pin = `ghcr.io/paperclipai/paperclip:${hostVersion}@sha256:bdf38d10544dc6c831e16dc027f23ad586353ef3be1a1b2c6979e63b956aceb1`;
  assert.ok(semver.gte(hostVersion, manifest.minimumHostVersion));
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
