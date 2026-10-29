import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { verifyRuntimeArtifact } from './runtime-artifact.mjs';

const pluginId = 'pohlee.polyforge-graph';
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function parseRuntimeOptions(argv) {
  const options = { companies: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!value || !['--base', '--auth', '--runtime', '--candidate', '--company', '--output'].includes(flag)) {
      throw new Error('Use --base URL --auth PRIVATE_AUTH_JSON (--candidate CANDIDATE_ROOT | --runtime RUNTIME_JSON --company ID [--company ID]) [--output REPORT_JSON]');
    }
    if (flag === '--company') options.companies.push(value);
    else if (options[flag.slice(2)]) throw new Error(`Duplicate option ${flag}`);
    else options[flag.slice(2)] = value;
  }
  if (!options.base || !options.auth || Boolean(options.runtime) === Boolean(options.candidate) ||
      (options.runtime && !options.companies.length) || (options.candidate && options.companies.length)) {
    throw new Error('Candidate mode enumerates all companies; legacy raw runtime mode requires explicit company IDs');
  }
  return options;
}

export function checkedBase(value) {
  const base = new URL(value);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      !['https:', 'http:'].includes(base.protocol) ||
      (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('Use a host root over HTTPS or an explicit local fixture host');
  }
  return base;
}

export async function runRuntimePreflight(options, fetchImpl = fetch) {
  const base = checkedBase(options.base);
  const auth = JSON.parse(await readFile(options.auth, 'utf8'));
  if (!auth.token && !auth.cookie) throw new Error('Private auth file needs a board token or session cookie');
  const headers = { Origin: base.origin,
    ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : { Cookie: auth.cookie }) };
  const request = async (method, path, body) => {
    const response = await fetchImpl(new URL(path, base), { method, redirect: 'manual',
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; }
    catch { throw new Error(`${method} ${path}: non-JSON response (${response.status})`); }
    if (!response.ok || response.status >= 300) throw new Error(`${method} ${path}: HTTP ${response.status}: ${data?.error ?? 'request failed'}`);
    return data;
  };
  let runtime, metadataDigest, artifact = null, companyIds, adminProof = null;
  if (options.candidate) {
    const verified = await verifyRuntimeArtifact(options.candidate);
    ({ artifact, metadataDigest } = verified);
    runtime = artifact.runtime;
    const identity = await request('GET', '/api/cli-auth/me');
    if (identity?.isInstanceAdmin !== true) throw new Error('Candidate preflight requires a verified Paperclip instance admin');
    adminProof = { isInstanceAdmin: true, userId: identity.userId ?? identity.user?.id ?? null,
      source: identity.source ?? null };
    const companies = await request('GET', '/api/companies');
    if (!Array.isArray(companies) || companies.some(item => !item?.id) ||
        new Set(companies.map(item => item.id)).size !== companies.length) {
      throw new Error('Official company listing must be a complete unique array');
    }
    companyIds = companies.map(item => item.id).sort();
  } else {
    const bytes = await readFile(options.runtime);
    runtime = JSON.parse(bytes.toString('utf8'));
    metadataDigest = digest(bytes);
    companyIds = [...new Set(options.companies)].sort();
  }
  const results = [];
  for (const companyId of companyIds) {
    try {
      const value = await request('POST', `/api/plugins/${pluginId}/api/company`, {
        companyId, operation: 'preflight-runtime', runtime,
        reason: 'Operator requested a candidate runtime compatibility preflight',
        idempotencyKey: `runtime-preflight:${randomUUID()}` });
      results.push({ companyId, ...value });
    } catch (error) {
      results.push({ companyId, ok: false, error: error.message });
    }
  }
  return { at: new Date().toISOString(), base: base.origin, pluginId,
    mode: options.candidate ? 'verified-artifact-all-companies' : 'legacy-selected-companies',
    runtimeMetadataDigest: metadataDigest,
    artifactBytesVerified: Boolean(artifact),
    candidateRoot: options.candidate ? resolve(options.candidate) : null,
    artifactFiles: artifact?.files ?? null,
    adminProof, companyIds,
    scope: options.candidate ? 'Paperclip instance-admin company listing and every listed company preflight' :
      'Only explicitly listed companies; instance coverage is not established',
    runtime, ok: results.every(item => item.ok === true), results };
}

export async function writeRuntimeReport(path, report) {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseRuntimeOptions(process.argv.slice(2));
  const report = await runRuntimePreflight(options);
  if (options.output) await writeRuntimeReport(options.output, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 2;
}
