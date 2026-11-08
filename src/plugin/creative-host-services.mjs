import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const OPERATIONS = Object.freeze({
  loadExternalArtifact: '/v1/creative/artifacts/load',
  getArtifactProvenance: '/v1/creative/artifacts/provenance',
  resolveDecisionEvidence: '/v1/creative/evidence/resolve',
  loadBrandContext: '/v1/creative/brand-context/load',
  authorizeBrandSelection: '/v1/creative/brand-selection/authorize',
  hasImageProvider: '/v1/creative/image-provider/check',
  decodeImage: '/v1/creative/image/decode',
});

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function findPackageRoot() {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const metadata = await readFile(resolve(current, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (metadata?.name === '@pohlee/paperclip-polyforge-graph') return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('PolyForge plugin package root not found');
    current = parent;
  }
}

function parseConfig(config, env) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { reason: 'creativeHost operator config is missing' };
  const { artifactRoot, gatewayUrl, gatewayTokenEnv, timeoutMs = DEFAULT_TIMEOUT_MS,
    allowedImageProviderIds = [] } = config;
  if (typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot)) return { reason: 'creativeHost.artifactRoot must be an absolute trusted Docker-volume path' };
  if (typeof gatewayUrl !== 'string') return { reason: 'creativeHost.gatewayUrl is not configured' };
  let endpoint;
  try { endpoint = new URL(gatewayUrl); } catch { return { reason: 'creativeHost.gatewayUrl is invalid' }; }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.pathname !== '/' && endpoint.pathname !== '')) return { reason: 'creativeHost.gatewayUrl must be an origin without credentials, path, query, or fragment' };
  if (typeof gatewayTokenEnv !== 'string' || !/^POLYFORGE_CREATIVE_[A-Z0-9_]+$/.test(gatewayTokenEnv) ||
      typeof env[gatewayTokenEnv] !== 'string' || !env[gatewayTokenEnv].trim()) {
    return { reason: 'creativeHost.gatewayTokenEnv must name a configured POLYFORGE_CREATIVE_* secret' };
  }
  if (!Array.isArray(allowedImageProviderIds) || allowedImageProviderIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(id))) {
    return { reason: 'creativeHost.allowedImageProviderIds must be an array of exact provider IDs' };
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) return { reason: 'creativeHost.timeoutMs must be an integer from 100 to 30000' };
  return { config: { artifactRoot: resolve(artifactRoot), endpoint: endpoint.origin, token: env[gatewayTokenEnv], timeoutMs,
    allowedImageProviderIds: [...new Set(allowedImageProviderIds)] } };
}

async function readBoundedResponse(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('Creative gateway response exceeds the 4 MiB limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Creative gateway response exceeds the 4 MiB limit'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function safeArtifactRoot(root, companyId, runId) {
  const safeSegment = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..';
  if (!safeSegment(companyId) || !safeSegment(runId)) throw new Error('Creative artifact scope identifiers are invalid');
  const target = resolve(root, companyId, runId);
  if (!inside(root, target)) throw new Error('Creative artifact root escaped its trusted volume');
  let current = root;
  for (const part of [companyId, runId]) {
    current = resolve(current, part);
    await mkdir(current, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Creative artifact scope must be a real directory, not a symlink');
  }
  return target;
}

/**
 * Operator-configured, bounded RPC bridge for the trusted Creative wrapper.
 * It never accepts gateway URLs, filesystem roots, provider IDs, or tenant scope
 * from a Pack/run payload. Its readiness is based on a live gateway capability
 * response, not on configuration strings alone.
 */
export async function createCreativeHostServices({ root, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const packageRoot = root ?? await findPackageRoot();
  const deployment = await readFile(resolve(packageRoot, 'polyforge.runtime.json'), 'utf8')
    .then(JSON.parse).catch(error => ({ __creativeConfigError: error }));
  if (deployment?.__creativeConfigError) return Object.freeze({ available: false,
    reason: deployment.__creativeConfigError.code === 'ENOENT' ? 'creativeHost operator config is missing' : 'polyforge.runtime.json could not be parsed; Creative host services are unavailable',
    capabilities: [], imageProviderIds: [], services: {}, forRun: () => ({}) });
  if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment)) return Object.freeze({ available: false,
    reason: 'polyforge.runtime.json must contain a top-level object; Creative host services are unavailable',
    capabilities: [], imageProviderIds: [], services: {}, forRun: () => ({}) });
  const parsed = parseConfig(deployment.creativeHost, env);
  if (!parsed.config) return Object.freeze({ available: false, reason: parsed.reason, capabilities: [], imageProviderIds: [], services: {} });
  if (typeof fetchImpl !== 'function') return Object.freeze({ available: false, reason: 'Creative gateway fetch is unavailable', capabilities: [], imageProviderIds: [], services: {} });
  const config = parsed.config;
  async function post(path, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(`${config.endpoint}${path}`, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`Creative gateway ${path} returned HTTP ${response.status}`);
      const text = await readBoundedResponse(response);
      let body;
      try { body = JSON.parse(text); } catch { throw new Error(`Creative gateway ${path} returned invalid JSON`); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`Creative gateway ${path} response must be an object`);
      if (body.protocol !== 'polyforge-creative-host-v1') throw new Error(`Creative gateway ${path} returned an unsupported protocol`);
      return body;
    } finally { clearTimeout(timer); }
  }
  let live;
  let readinessReason = '';
  try {
    const body = await post('/v1/creative/capabilities', { protocolVersion: 1 });
    const data = body.result;
    if (body.protocol !== 'polyforge-creative-host-v1' || !data || !Array.isArray(data.services) ||
        data.services.some(name => !Object.hasOwn(OPERATIONS, name)) || !Array.isArray(data.imageProviderIds) ||
        data.imageProviderIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(id))) {
      throw new Error('Creative gateway capability response is invalid');
    }
    live = { services: new Set(data.services), imageProviderIds: new Set(data.imageProviderIds), decoder: data.imageDecoder === true };
  } catch (error) { readinessReason = `Creative gateway unavailable or untrusted: ${error.message}`; }
  let capabilities = live ? [...live.services] : [];
  const ensureTenant = (body, companyId, name) => {
    if (body.companyId !== companyId) throw new Error(`Creative gateway ${name} returned a mismatched company scope`);
    if (!Object.hasOwn(body, 'result')) throw new Error(`Creative gateway ${name} omitted its result`);
    return body.result;
  };
  async function canonicalArtifactRoot() {
    await mkdir(config.artifactRoot, { recursive: true });
    const rootInfo = await lstat(config.artifactRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Creative artifactRoot must be a real directory, not a symlink');
    const actualRoot = await realpath(config.artifactRoot);
    if (actualRoot !== config.artifactRoot) throw new Error('Creative artifactRoot path must not traverse symlinks');
    return actualRoot;
  }
  let artifactRootAvailable = false;
  if (live) {
    try { await canonicalArtifactRoot(); artifactRootAvailable = true; }
    catch (error) { readinessReason = `Creative artifact storage unavailable: ${error.message}`; }
  }
  capabilities = [...capabilities, ...(artifactRootAvailable ? ['artifactRootForRun'] : [])];
  const configuredProviders = new Set(config.allowedImageProviderIds);
  const servicesForScope = (companyId, scopedRunId) => {
    const rpc = (name, payloadFactory, validate = value => value) => async input => {
      if (!companyId || !live || !live.services.has(name)) throw new Error(`Creative gateway service ${name} is not ready`);
      const payload = payloadFactory({ ...input, companyId, scopedRunId });
      const body = await post(OPERATIONS[name], { companyId, ...payload });
      return validate(ensureTenant(body, companyId, name));
    };
    return {
    artifactRootForRun: async run => {
      if (!live) throw new Error(readinessReason || 'Creative gateway is not ready');
      return safeArtifactRoot(await canonicalArtifactRoot(), companyId, run?.id ?? scopedRunId);
    },
    loadExternalArtifact: async ({ ref, kind, run, input, actor }) => {
      if (!live?.services.has('loadExternalArtifact')) throw new Error('Creative gateway service loadExternalArtifact is not ready');
      const runId = run?.id ?? scopedRunId;
      const trustedRoot = await canonicalArtifactRoot();
      const body = await post(OPERATIONS.loadExternalArtifact, { companyId, runId, ref, kind,
      graphId: run?.graph?.id, requester: actor ? { id: actor.id, kind: actor.kind, roles: actor.roles, executionId: actor.executionId } : undefined,
      references: input?.externalRefs ?? undefined });
      const row = ensureTenant(body, companyId, 'loadExternalArtifact');
      if (!row || typeof row !== 'object' || row.id !== (ref?.id ?? ref?.artifactId) || row.version !== ref?.version || row.kind !== kind ||
          !row.payload || typeof row.payload !== 'object') throw new Error('Creative gateway returned the wrong external artifact identity');
      const sourceRunId = row.provenance?.sourceRunId;
      const artifactRoot = typeof sourceRunId === 'string' ? await safeArtifactRoot(trustedRoot, companyId, sourceRunId) : undefined;
      const { artifactRoot: _untrustedRoot, ...trustedRow } = row;
      return { ...trustedRow, ...(artifactRoot ? { artifactRoot } : {}) };
    },
    getArtifactProvenance: ref => rpc('getArtifactProvenance', () => ({ runId: scopedRunId, ref }), value => {
      if (!Array.isArray(value)) throw new Error('Creative artifact provenance result must be an array'); return value;
    })({}),
    resolveDecisionEvidence: rpc('resolveDecisionEvidence', ({ run, node, outcome, requiredKinds }) => ({ runId: run?.id ?? scopedRunId,
      graphId: run?.graph?.id, nodeId: node?.id, outcome, requiredKinds }), value => {
      if (!Array.isArray(value)) throw new Error('Creative decision evidence result must be an array'); return value;
    }),
    loadBrandContext: rpc('loadBrandContext', ({ projectId, graphId, actor }) => ({ runId: scopedRunId, projectId, graphId, actor:
      actor ? { id: actor.id, kind: actor.kind, roles: actor.roles, executionId: actor.executionId } : undefined }), value => {
      if (!value || typeof value !== 'object' || !Array.isArray(value.facts) || !Array.isArray(value.decisionRefs)) throw new Error('Creative brand context result is invalid'); return value;
    }),
    authorizeBrandSelection: rpc('authorizeBrandSelection', ({ selection, authors, actor, input }) => ({ runId: scopedRunId, selection, authors,
      actor: actor ? { id: actor.id, kind: actor.kind, roles: actor.roles, executionId: actor.executionId } : undefined,
      projectId: input?.projectId }), value => {
      if (typeof value !== 'boolean') throw new Error('Creative brand authorization result must be a boolean'); return value;
    }),
    hasImageProvider: async providerId => {
      if (!companyId || !configuredProviders.has(providerId) || !live?.imageProviderIds.has(providerId) ||
          !live.services.has('hasImageProvider')) return false;
      const body = await post(OPERATIONS.hasImageProvider, { companyId, runId: scopedRunId, providerId });
      const result = ensureTenant(body, companyId, 'hasImageProvider');
      return result?.providerId === providerId && result.authorized === true && result.callable === true;
    },
    decodeImage: async (bytes, mimeType) => {
      if (!live?.decoder || !live.services.has('decodeImage')) throw new Error('Creative image decoder is not ready');
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 20 * 1024 * 1024 || typeof mimeType !== 'string') {
        throw new Error('Creative image decoder input is invalid or too large');
      }
      if (!['image/jpeg', 'image/webp'].includes(mimeType)) throw new Error('Creative decoder is only used for JPEG/WebP');
      const body = await post(OPERATIONS.decodeImage, { companyId, runId: scopedRunId, mimeType, bytesBase64: Buffer.from(bytes).toString('base64') });
      const result = ensureTenant(body, companyId, 'decodeImage');
      if (!result || !['image/png', 'image/jpeg', 'image/webp'].includes(result.mimeType) ||
          !Number.isInteger(result.width) || result.width < 1 || !Number.isInteger(result.height) || result.height < 1) {
        throw new Error('Creative image decoder returned invalid verified dimensions');
      }
      if (result.mimeType !== mimeType) throw new Error('Creative image decoder MIME differs from the verified input bytes');
      return result;
    },
    };
  };
  const services = servicesForScope(null, null);
  const forRun = ({ companyId: scopedCompanyId, run } = {}) => servicesForScope(scopedCompanyId, run?.id ?? null);
  return Object.freeze({ available: Boolean(live), reason: readinessReason || null, capabilities,
    imageProviderIds: [...(live?.imageProviderIds ?? [])].filter(id => configuredProviders.has(id)),
    imageDecoderAvailable: Boolean(live?.decoder), artifactRoot: config.artifactRoot, services: Object.freeze(services), forRun });
}
