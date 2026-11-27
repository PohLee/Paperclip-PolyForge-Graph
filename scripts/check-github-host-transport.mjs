import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHostGitHubTransport, readGitHubBlob } from '../src/plugin/github-http-transport.mjs';

const serverRoot = process.argv[2];
if (!serverRoot) throw new Error('Pass the installed @paperclipai/server package directory');
const serviceUrl = pathToFileURL(resolve(serverRoot, 'dist/services/plugin-host-services.js'));
const sdkEntry = import.meta.resolve('@paperclipai/plugin-sdk');
const sdkVersion = JSON.parse(await readFile(new URL('../package.json', sdkEntry), 'utf8')).version;
const serverVersion = JSON.parse(await readFile(new URL('../../package.json', serviceUrl), 'utf8')).version;
const { startWorkerRpcHost } = await import(new URL('./worker-rpc-host.js', sdkEntry));

const bytes = Buffer.from([0, 255, 128, 13, 10]);
const sha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const bearer = 'Bearer synthetic-transport-probe';
const headers = { authorization: bearer };
const replies = new Map([
  ['/redirect-same', [307, { location: 'https://api.github.com/redirect-target' }, 'same host']],
  ['/redirect-cross', [308, { location: 'https://cross-probe.invalid/redirect-target' }, 'cross host']],
  ['/blob', [200, { 'content-type': 'application/json' },
    JSON.stringify({ sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') })]],
  ['/empty', [204, {}, '']],
]);
const requests = [], lookups = [];
const stdin = new PassThrough();
const stdout = new PassThrough();
const lines = createInterface({ input: stdout });
const original = { lookup: dns.lookup, https: https.request, http: http.request, fetch: globalThis.fetch };
let unexpectedNetworkCalls = 0;
let worker;

try {
  dns.lookup = async hostname => {
    lookups.push(hostname);
    return [{ address: '8.8.8.8', family: 4 }];
  };
  http.request = globalThis.fetch = () => {
    unexpectedNetworkCalls++;
    throw new Error('Unexpected network path');
  };
  https.request = (options, callback) => {
    requests.push({ path: options.path, host: options.host, servername: options.servername,
      authorization: options.headers.authorization, method: options.method });
    const req = new EventEmitter();
    req.end = () => {
      const [status, responseHeaders, body] = replies.get(options.path) ?? [500, {}, 'unexpected target'];
      const response = new PassThrough();
      response.statusCode = status;
      response.headers = responseHeaders;
      callback(response);
      setImmediate(() => response.end(body));
    };
    return req;
  };
  syncBuiltinESMExports();
  const { buildHostServices } = await import(serviceUrl);
  const services = buildHostServices({}, 'probe', 'probe', { forPlugin: () => ({}) }, () => {});

  const plugin = { definition: { async setup(host) {
    const transport = createHostGitHubTransport(host);
    for (const path of ['/redirect-same', '/redirect-cross']) {
      await assert.rejects(transport('https://api.github.com' + path, { headers }), { message: 'github-transport-redirect' });
    }
    const blob = await transport('https://api.github.com/blob', { headers });
    assert.deepEqual(await readGitHubBlob(blob, sha), bytes);
    try {
      const response = await host.http.fetch('https://api.github.com/empty', { headers, method: 'DELETE' });
      assert.equal(response.status, 204);
      console.log('SDK delivered empty 204');
    } catch (error) {
      assert.ok(error instanceof TypeError, 'Expected SDK empty-204 Response error');
      console.log('SDK threw TypeError on empty 204');
    }
  } } };
  worker = startWorkerRpcHost({ plugin, stdin, stdout, rpcTimeoutMs: 5000 });

  const initialized = await new Promise((resolve, reject) => {
    const send = message => stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    const timer = setTimeout(() => reject(new Error('Worker probe timed out')), 8000);
    timer.unref();
    lines.on('line', async line => {
      try {
        const message = JSON.parse(line);
        if (message.method === 'http.fetch') {
          const result = await services.http.fetch(message.params);
          send({ id: message.id, result });
        } else if (message.id === 1000) {
          clearTimeout(timer);
          resolve(message);
        } else {
          throw new Error('Unexpected RPC in GitHub transport probe');
        }
      } catch (error) { clearTimeout(timer); reject(error); }
    });
    send({ id: 1000, method: 'initialize', params: {
      manifest: { id: 'probe', capabilities: ['http.outbound'] }, config: {},
    } });
  });
  assert.equal(initialized.result?.ok, true, initialized.error?.message);
  assert.deepEqual(requests.map(request => request.path), [...replies.keys()]);
  assert.deepEqual(requests.map(request => request.method), ['GET', 'GET', 'GET', 'DELETE']);
  assert.deepEqual(lookups, Array(4).fill('api.github.com'));
  assert.ok(requests.every(request => request.authorization === bearer && request.host === '8.8.8.8'
    && request.servername === 'api.github.com'));
  assert.equal(unexpectedNetworkCalls, 0);
  console.log(`SDK ${sdkVersion} / host ${serverVersion}: 307 and 308 blocked with zero target hits. Binary blob round-tripped.`);
} finally {
  worker?.stop();
  lines.close();
  stdin.destroy();
  stdout.destroy();
  dns.lookup = original.lookup;
  https.request = original.https;
  http.request = original.http;
  globalThis.fetch = original.fetch;
  syncBuiltinESMExports();
}
