import test from 'node:test';
import assert from 'node:assert/strict';

test('MVP process fixture closes its child only after successful callbacks and replays', async t => {
  const priorFetch = globalThis.fetch;
  const fixtureEnv = { PAPERCLIP_TASK_ID: 'child', PAPERCLIP_AGENT_ID: 'agent',
    PAPERCLIP_RUN_ID: 'heartbeat', PAPERCLIP_API_KEY: 'synthetic-test-token' };
  const priorEnv = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixtureEnv);
  t.after(() => {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const failure of [null, 'duplicate-submit', 'self-review', 'cas-once', 'cas-always', 'invalid-submit']) {
    await t.test(failure ?? 'successful triage', async () => {
      const calls = [];
      let submissions = 0;
      globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname;
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ method: options.method, path, body });
        assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
        assert.equal(options.headers['X-Paperclip-Run-Id'], 'heartbeat');
        let data = {};
        if (options.method === 'GET' && path === '/api/issues/child') data = {
          id: 'child', companyId: 'company', title: 'Assess synthetic request',
          description: 'PolyForge Graph run graph-run, node assess-request, attempt 1.\nRoot Paperclip issue: root.'
        };
        else if (options.method === 'GET') data = { run: {
          id: 'graph-run', packVersion: 'fixture', input: { source_request: { id: 'root', version: 'v1' } },
          graph: { nodes: [{ id: 'assess-request', role: 'product-owner', decisionTraceRequired: true,
            produces: ['triage_report', 'request_brief'], review: { supervisorRole: 'cpo' } }] },
          nodeStates: { 'assess-request': { status: 'pending', artifacts: [] } }
        } };
        else if (body?.operation === 'record-work-decision') data = { result: { id: 'work-decision' } };
        else if (body?.operation === 'submit') {
          submissions++;
          if (failure === 'cas-always' || failure === 'cas-once' && submissions === 1) {
            return new Response(JSON.stringify({ error: 'Run changed since validation; revalidate before applying' }), { status: 400 });
          }
          if (failure === 'invalid-submit') return new Response('{"error":"invalid artifact rejected"}', { status: 400 });
          if (failure === 'duplicate-submit' && submissions === 2) return new Response('{"error":"replay rejected"}', { status: 400 });
        } else if (body?.operation === 'self-review' && failure === 'self-review') {
          return new Response('{"error":"review rejected"}', { status: 400 });
        }
        return new Response(JSON.stringify(data), { status: 200 });
      };
      const execution = import(`../../scripts/e2e-fixture-agent.mjs?test=${failure ?? 'success'}`);
      const succeeds = !failure || failure === 'cas-once';
      if (!succeeds) await assert.rejects(execution, /rejected|Run changed since validation/);
      else await execution;
      const submitted = calls.filter(call => call.body?.operation === 'submit');
      assert.equal(submitted.length, failure === 'invalid-submit' ? 1 : failure?.startsWith('cas-') ? 3 : 2);
      for (const submission of submitted) assert.deepEqual(submission.body, submitted[0].body);
      assert.deepEqual(submitted[0].body.decisionIds, ['work-decision']);
      const closures = calls.filter(call => call.method === 'PATCH');
      assert.equal(closures.length, succeeds ? 1 : 0);
      if (succeeds) {
        assert.deepEqual(calls.at(-1), { method: 'PATCH', path: '/api/issues/child', body: { status: 'done' } });
        assert.ok(calls.some(call => call.body?.operation === 'self-review'));
      }
    });
  }
});
