import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { client, root, pluginId, waitFor } from './enhancement-client.mjs';
import { runRuntimePreflight } from './runtime-preflight.mjs';

const checkpoint = resolve(root, '.e2e/enhancement-checkpoint.json');
const state = JSON.parse(await readFile(checkpoint, 'utf8'));
const { data } = await client();
const companyId = state.development.companyId;
const endpoint = `/api/plugins/${pluginId}`;
const read = () => data('GET', `${endpoint}/api/company?companyId=${companyId}`);
const record = async (name, proof) => {
  state.cases = state.cases.filter(item => item.name !== name);
  state.cases.push({ name, status: 'passed', at: new Date().toISOString(), proof });
  await writeFile(checkpoint, JSON.stringify(state, null, 2)); console.log(`PASS ${name}`);
};
const before = await read();
const native = await data('GET', `${endpoint}/config?companyId=${companyId}`);
const prior = before.evidenceProviders.find(item => item.id === 'local-fixture');
const { secretConfigured: _secretConfigured, ...provider } = prior;
provider.secretRef = native.configJson.evidence.providers[provider.id].secretRef;
const request = { companyId, operation: 'configure-evidence-providers', provider,
  reason: 'Verify exact configuration audit and replay on the local host',
  idempotencyKey: `final-evidence-config:${companyId}` };
const first = await data('POST', `${endpoint}/api/company`, request);
const replay = await data('POST', `${endpoint}/api/company`, request);
assert.equal(replay.replayed, true); assert.equal(first.decisionId, replay.decisionId);
await assert.rejects(data('POST', `${endpoint}/api/company`, {
  ...request, provider: { ...provider, maxAgeSeconds: 86400 },
}), /Idempotency key reused/);
assert.equal((await read()).evidenceProviders.length, before.evidenceProviders.length);
await record('Native evidence-provider upsert exact audit and replay protection', { companyId, decisionId: first.decisionId });

const jobs = await data('GET', `${endpoint}/jobs`);
const job = jobs.find(item => item.jobKey === 'channel-delivery');
const started = await data('POST', `${endpoint}/jobs/${job.id}/trigger`, {});
await waitFor(async () => {
  const run = (await data('GET', `${endpoint}/jobs/${job.id}/runs`)).find(item => item.id === started.runId);
  if (run?.status === 'failed') throw new Error(run.error ?? 'Channel job failed');
  return run?.status === 'succeeded';
}, 'terminal run progress delivery');
const after = await read();
const completed = after.runs.filter(item => item.status === 'completed');
assert.ok(completed.length >= 3);
for (const run of completed) {
  const notice = after.control.outbox.find(item => item.eventKind === 'run.completed' && item.ref.runId === run.id);
  assert.ok(notice); assert.equal(notice.ref.packVersion, run.packVersion);
  assert.ok(after.channels.deliveries.some(item => item.notificationId === notice.id && item.status === 'delivered'));
}
await record('Scheduled terminal Graph progress uses pinned runs and durable receipts', {
  companyId, jobRunId: started.runId, completedRunIds: completed.map(item => item.id),
});
const report = await runRuntimePreflight({ base: state.base,
  auth: resolve(root, '.e2e/enhancement-auth.json'), candidate: root });
assert.equal(report.ok, true); assert.equal(report.artifactBytesVerified, true);
await writeFile(resolve(root, '.e2e/runtime-preflight.json'), JSON.stringify(report, null, 2));
await record('Verified candidate artifact and instance-wide compatible upgrade preflight', {
  companies: report.companyIds.length, digest: report.runtimeMetadataDigest, applied: false,
});
state.status = 'passed'; delete state.failure;
await writeFile(checkpoint, JSON.stringify(state, null, 2));
await writeFile(resolve(root, '.e2e/enhancement-result.json'), JSON.stringify(state, null, 2));
