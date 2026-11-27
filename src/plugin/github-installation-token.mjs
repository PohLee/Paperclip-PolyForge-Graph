import { createPrivateKey, sign } from 'node:crypto';
import { createHostGitHubTransport } from './github-http-transport.mjs';
import { validGitHubApp, validGitHubId } from './github-app-config.mjs';

export const githubContractPermissions = Object.freeze({
  contents: 'read', pull_requests: 'read', statuses: 'write',
});
const path = 'githubApp.privateKeyRef';
const refreshWindow = 60_000;
const readonly = new Set(['GET', 'HEAD']);
const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
const fault = (code, cause) => Object.assign(new Error(code, { cause }), { code });

function permissionsFor(permissions) {
  const expected = githubContractPermissions;
  if (!permissions || Object.keys(permissions).length !== Object.keys(expected).length
    || Object.entries(expected).some(([name, level]) => !Object.hasOwn(permissions, name) || permissions[name] !== level)) {
    throw fault('github-token-invalid-permissions');
  }
  return expected;
}

function validateToken(body, repositoryId, permissions, now) {
  const expiry = Date.parse(body?.expires_at);
  if (typeof body?.token !== 'string' || !/^[!-~]+$/.test(body.token) || expiry <= now + refreshWindow
    || !Number.isFinite(expiry) || body.repository_selection === 'all'
    || (body.repositories !== undefined && (!Array.isArray(body.repositories)
      || body.repositories.length !== 1 || body.repositories[0]?.id !== repositoryId))
    || (body.permissions !== undefined && (!body.permissions
      || Object.entries(permissions).some(([name, level]) => body.permissions[name] !== level)
      || Object.entries(body.permissions).some(([name, level]) =>
        permissions[name] !== level && !(name === 'metadata' && level === 'read'))))) {
    throw fault('github-token-invalid-response');
  }
  return { token: body.token, expiry };
}

export function createInstallationTokenProvider({ host, companyId, app, now = Date.now,
  fetch: fetchToken = createHostGitHubTransport(host) }) {
  const entries = new Map();
  let binding;
  function updateApp(next) {
    if (!validGitHubApp(next) || typeof companyId !== 'string' || !companyId) throw fault('github-token-invalid-binding');
    entries.clear();
    binding = { appId: next.appId, installationId: next.installationId, privateKeyRef: { ...next.privateKeyRef } };
  }
  updateApp(app);

  function keyFor(repositoryId, permissions) {
    if (!validGitHubId(repositoryId)) throw fault('github-token-invalid-repository');
    return JSON.stringify([companyId, binding.appId, binding.installationId, repositoryId,
      Object.entries(permissions).sort(([left], [right]) => left.localeCompare(right))]);
  }

  async function mint({ appId, installationId, privateKeyRef }, repositoryId, permissions) {
    let response;
    try {
      const key = createPrivateKey(await host.secrets.resolve(privateKeyRef, { companyId, configPath: path }));
      if (key.asymmetricKeyType !== 'rsa') throw fault('github-token-invalid-key');
      const seconds = Math.floor(now() / 1000);
      const payload = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
        iat: seconds - 60, exp: seconds + 480, iss: String(appId),
      });
      const jwt = payload + '.' + sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url');
      response = await fetchToken('https://api.github.com/app/installations/' + installationId + '/access_tokens', {
        method: 'POST', redirect: 'error',
        headers: { authorization: 'Bearer ' + jwt, accept: 'application/vnd.github+json',
          'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
        body: JSON.stringify({ repository_ids: [repositoryId], permissions }),
      });
    } catch {
      throw fault('github-token-mint-failed');
    }
    if (!response.ok) throw fault('github-token-mint-rejected');
    let body;
    try { body = await response.json(); } catch { throw fault('github-token-invalid-response'); }
    return validateToken(body, repositoryId, permissions, now());
  }

  async function getToken({ repositoryId, permissions: input = githubContractPermissions }) {
    const permissions = permissionsFor(input);
    const key = keyFor(repositoryId, permissions);
    let entry = entries.get(key);
    if (entry?.expiry > now() + refreshWindow) return entry.token;
    if (!entry?.pending) {
      entry = {};
      const active = entry;
      entries.set(key, active);
      active.pending = mint(binding, repositoryId, permissions).then(result => {
        if (entries.get(key) !== active) throw fault('github-token-invalidated');
        entries.set(key, result);
        return result.token;
      }, error => {
        if (entries.get(key) === active) entries.delete(key);
        throw error;
      });
    }
    return entry.pending;
  }

  function invalidate(scope) {
    if (!scope) entries.clear();
    else entries.delete(keyFor(scope.repositoryId, permissionsFor(scope.permissions ?? githubContractPermissions)));
  }

  async function withToken({ repositoryId, permissions = githubContractPermissions }, method, send) {
    const scope = { repositoryId, permissions };
    const originalBinding = binding;
    const key = keyFor(repositoryId, permissionsFor(permissions));
    async function attempt() {
      const token = await getToken(scope);
      if (binding !== originalBinding || entries.get(key)?.token !== token) throw fault('github-token-invalidated');
      let response;
      try { response = await send(token); }
      catch (error) { throw fault('github-token-transport-failed', error); }
      if (response.status === 401 && entries.get(key)?.token === token) entries.delete(key);
      return response;
    }
    const response = await attempt();
    if (response.status === 401 && readonly.has(method) && binding === originalBinding) return attempt();
    return response;
  }

  return { getToken, invalidate, updateApp, withToken };
}
