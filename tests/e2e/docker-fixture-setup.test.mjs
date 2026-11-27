import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pack } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';

test('Docker MVP fixture enables its company Pack and checks exact managed roles', async t => {
  const stateDir = await mkdtemp(resolve(tmpdir(), 'polyforge-docker-setup-'));
  const priorStateDir = process.env.POLYFORGE_E2E_STATE_DIR;
  const priorFetch = globalThis.fetch;
  process.env.POLYFORGE_E2E_STATE_DIR = stateDir;
  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorStateDir === undefined) delete process.env.POLYFORGE_E2E_STATE_DIR;
    else process.env.POLYFORGE_E2E_STATE_DIR = priorStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });
  await writeFile(resolve(stateDir, 'auth.json'), JSON.stringify({ cookie: 'fixture=session', userId: 'owner' }));
  const { runE2E } = await import('../../scripts/e2e.mjs');
  const exactBindings = Object.fromEntries(Object.keys(pack.roles).map(role => [`${pack.id}:${role}`, `agent-${role}`]));

  for (const variant of ['exact', 'wrong-namespace', 'missing', 'extra', 'provision-unavailable', 'unsafe-company']) {
    await t.test(variant, async () => {
      const calls = [];
      const bindings = { ...exactBindings, ceo: 'company-ceo' };
      const firstKey = Object.keys(bindings)[0];
      if (variant === 'wrong-namespace') {
        bindings[firstKey.replace(`${pack.id}:`, 'other:')] = bindings[firstKey];
        delete bindings[firstKey];
      }
      if (variant === 'missing') delete bindings[firstKey];
      if (variant === 'extra') bindings[`${pack.id}:obsolete-role`] = 'obsolete-agent';
      const reachedStart = new Error('Reached first Graph start');
      let provisionAttempts = 0, pluginReads = 0;
      globalThis.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ path, body });
        let data;
        if (path === '/api/health') data = { status: 'ok' };
        else if (path === '/api/auth/get-session') {
          assert.equal(options.headers.Cookie, 'fixture=session', 'fixture must use its isolated auth directory');
          data = { user: { id: 'owner' } };
        } else if (path === '/api/plugins/pohlee.polyforge-graph') {
          if (variant === 'exact' && ++pluginReads === 1) return new Response('{"error":"temporary RPC timeout"}', { status: 503 });
          data = { status: 'ready' };
        } else if (path === '/api/companies') {
          if (variant === 'unsafe-company') return new Response('{"error":"temporary RPC timeout"}', { status: 502 });
          data = { id: 'company' };
        }
        else if (path === '/api/companies/company/projects') data = { id: 'project' };
        else if (path === '/api/companies/company/issues') {
          assert.equal(body.projectId, 'project', 'native Shadow review requires a project-scoped root');
          data = { id: 'issue' };
        }
        else if (body?.operation === 'enable-pack') data = { enabled: true };
        else if (body?.operation === 'provision-pack') {
          provisionAttempts++;
          if (variant === 'provision-unavailable' || variant === 'exact' && provisionAttempts < 3) {
            return new Response('{"error":"temporary RPC timeout"}', { status: provisionAttempts === 1 ? 502 : 503 });
          }
          data = { roleBindings: bindings, ceo: { agentId: 'company-ceo' }, skills: Object.keys(pack.skills) };
        }
        else if (body?.operation === 'configure') data = { configured: true };
        else if (body?.operation === 'configure-organization') data = { configured: true };
        else if (body?.operation === 'configure-shadow-policy') data = { configured: true };
        else if (body?.operation === 'product-decision') data = { result: { id: 'baseline' } };
        else if (body?.operation === 'start') throw reachedStart;
        else assert.fail(`Unexpected fixture request: ${path}`);
        return new Response(JSON.stringify(data), { status: 200 });
      };
      await assert.rejects(runE2E({ restart: false }), error => variant === 'exact'
        ? error === reachedStart
        : ['provision-unavailable', 'unsafe-company'].includes(variant) ? /50[23]/.test(error.message)
        : error.code === 'ERR_ASSERTION' && /managed role bindings/.test(error.message));
      if (variant === 'unsafe-company') {
        assert.equal(calls.filter(call => call.path === '/api/companies').length, 1, 'unkeyed creation must not replay');
        return;
      }
      const commands = calls.filter(call => call.body?.operation);
      assert.equal(commands[0].body.operation, 'enable-pack');
      assert.deepEqual(commands[0].body, {
        companyId: 'company', operation: 'enable-pack', packId: pack.id, version: pack.version,
        reason: 'Configure isolated Docker fixture: enable-pack',
        idempotencyKey: `e2e:enable-pack:company:${pack.id}:${pack.version}`
      });
      assert.equal(commands[1].body.operation, 'provision-pack');
      assert.equal(commands[1].body.packId, pack.id);
      assert.equal(commands[1].body.version, pack.version);
      const provisions = commands.filter(call => call.body.operation === 'provision-pack');
      assert.equal(provisions.length, ['exact', 'provision-unavailable'].includes(variant) ? 3 : 1);
      for (const provision of provisions) assert.deepEqual(provision.body, provisions[0].body);
      assert.equal(commands.some(call => call.body.operation === 'start'), variant === 'exact');
      if (variant === 'exact') {
        const configured = commands.find(call => call.body.operation === 'configure').body;
        assert.deepEqual(configured.userRoles.owner, [`${pack.id}:cpo`]);
        assert.equal(configured.roleBindings.ceo, 'company-ceo');
        assert.equal(commands.find(call => call.body.operation === 'configure-organization').body.derive, true);
        assert.deepEqual(commands.find(call => call.body.operation === 'configure-shadow-policy').body.policy, {
          enabled: true, allowSameAgent: true, allowAgentTrigger: false, allowGraphTrigger: true,
          maxDurationSeconds: 120, allowedAdapterTypes: ['process']
        });
        const start = commands.find(call => call.body.operation === 'start').body;
        assert.equal(start.graphId, 'request-triage');
        assert.ok(pack.graphs.some(graph => graph.id === start.graphId));
        assert.deepEqual(start.input.source_request, { id: 'issue', version: 'v1' });
      }
    });
  }
});
