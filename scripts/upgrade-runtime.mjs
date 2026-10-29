import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
import { checkedBase, runRuntimePreflight } from './runtime-preflight.mjs';

export function parseUpgradeOptions(argv) {
  const options = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply') { options.apply = true; continue; }
    const value = argv[++i];
    if (!value || !['--base', '--auth', '--candidate', '--report'].includes(flag) || options[flag.slice(2)]) {
      throw new Error('Use --base HOST_ROOT --auth PRIVATE_ADMIN_AUTH_JSON --candidate CANDIDATE_ROOT --report REVIEWED_REPORT_JSON [--apply]');
    }
    options[flag.slice(2)] = value;
  }
  if (!options.base || !options.auth || !options.candidate || !options.report) {
    throw new Error('Host, auth, candidate and reviewed report paths are all required');
  }
  return options;
}

export function assertReviewedPreflight(reviewed, fresh) {
  if (reviewed?.mode !== 'verified-artifact-all-companies' || reviewed.ok !== true ||
      reviewed.artifactBytesVerified !== true || reviewed.adminProof?.isInstanceAdmin !== true ||
      fresh.ok !== true || fresh.adminProof?.isInstanceAdmin !== true ||
      reviewed.base !== fresh.base || reviewed.pluginId !== fresh.pluginId ||
      reviewed.runtimeMetadataDigest !== fresh.runtimeMetadataDigest ||
      reviewed.candidateRoot !== fresh.candidateRoot ||
      JSON.stringify(reviewed.artifactFiles) !== JSON.stringify(fresh.artifactFiles) ||
      JSON.stringify(reviewed.companyIds) !== JSON.stringify(fresh.companyIds) ||
      reviewed.results?.length !== reviewed.companyIds?.length ||
      fresh.results?.length !== fresh.companyIds?.length) {
    throw new Error('Reviewed candidate, instance-wide company set or compatible preflight changed; review a new report');
  }
}

export async function upgradeRuntime(options, fetchImpl = fetch) {
  const reviewed = JSON.parse(await readFile(options.report, 'utf8'));
  const fresh = await runRuntimePreflight(options, fetchImpl);
  assertReviewedPreflight(reviewed, fresh);
  if (!options.apply) return { status: 'ready-for-explicit-apply', applied: false,
    reviewedReport: resolve(options.report), freshPreflight: fresh };
  const base = checkedBase(options.base);
  const auth = JSON.parse(await readFile(options.auth, 'utf8'));
  const headers = { Origin: base.origin, 'Content-Type': 'application/json',
    ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : { Cookie: auth.cookie }) };
  const installedResponse = await fetchImpl(new URL('/api/plugins/pohlee.polyforge-graph', base), {
    method: 'GET', redirect: 'manual', headers,
  });
  if (!installedResponse.ok) throw new Error('Cannot verify the installed plugin source before upgrade');
  const installed = await installedResponse.json();
  // Paperclip upgrades its stored package source; the endpoint accepts no candidate path.
  // A container/remote path needs host-side byte attestation, which this host lacks.
  if (!isAbsolute(installed.packagePath ?? '') ||
      resolve(installed.packagePath) !== resolve(options.candidate)) {
    throw new Error('Installed source is not the verified local candidate path. Run this wrapper on the Paperclip host with that exact path; remote/container path mappings cannot be attested here. No upgrade was requested.');
  }
  const response = await fetchImpl(new URL('/api/plugins/pohlee.polyforge-graph/upgrade', base), {
    method: 'POST', redirect: 'manual', headers, body: '{}' });
  const raw = await response.text();
  let result;
  try { result = raw ? JSON.parse(raw) : null; }
  catch { throw new Error(`Official Paperclip upgrade returned non-JSON response (${response.status})`); }
  if (!response.ok || response.status >= 300) {
    throw new Error(`Official Paperclip upgrade rejected candidate (${response.status}): ${result?.error ?? 'unknown error'}`);
  }
  if (result?.version !== fresh.runtime.version) {
    throw new Error(`Official upgrade returned version ${result?.version ?? 'unknown'}; expected ${fresh.runtime.version}. Inspect host state.`);
  }
  return { status: 'official-upgrade-called', applied: true, result,
    reviewedReport: resolve(options.report), preflight: fresh };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await upgradeRuntime(parseUpgradeOptions(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
