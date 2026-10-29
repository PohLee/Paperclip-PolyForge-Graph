import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeReviewPrompt, parseNativeShadowReview, readNativeShadowRun,
  shadowAgentEligible, shadowTaskKey } from '../../src/plugin/shadow-native.mjs';

const ref = { id: 'candidate', version: 'v1', digest: `sha256:${'a'.repeat(64)}` };
const packet = { sourceRunId: 'graph-run', snapshotId: 'snapshot', candidates: [ref] };
const policy = { enabled: true, allowSameAgent: true, maxDurationSeconds: 300,
  allowedAdapterTypes: ['codex_local', 'process'] };
const agent = { adapterType: 'codex_local', status: 'running',
  adapterConfig: { timeoutSec: 180 }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
  budgetMonthlyCents: 1000, spentMonthlyCents: 100 };

test('native eligibility requires bounded configured timeout, budget and two execution slots', () => {
  assert.equal(shadowAgentEligible(agent, policy), true);
  assert.equal(shadowAgentEligible({ ...agent, adapterConfig: { timeoutSec: 0 } }, policy), false);
  assert.equal(shadowAgentEligible({ ...agent, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }, policy), false);
  assert.equal(shadowAgentEligible({ ...agent, spentMonthlyCents: 1000 }, policy), false);
  assert.equal(shadowAgentEligible({ ...agent, adapterType: 'process' }, policy), true);
});

test('native review accepts only a strict pinned structured terminal reply', () => {
  const review = { schema: 'polyforge.shadow.review.v1', status: 'reviewed', schemaVersion: 1,
    snapshotId: packet.snapshotId, sourceRunId: packet.sourceRunId, verdict: 'accept',
    candidateRefs: [ref], findings: [] };
  const row = { status: 'succeeded', result_json: { summary: JSON.stringify(review) } };
  assert.equal(parseNativeShadowReview(row, packet, 'codex_local').verdict, 'accept');
  assert.equal(parseNativeShadowReview({ ...row, status: 'queued' }, packet, 'codex_local'), null);
  assert.equal(parseNativeShadowReview({ ...row, result_json: { summary: JSON.stringify({ ...review,
    snapshotId: 'wrong' }) } }, packet, 'codex_local'), null);
  assert.equal(parseNativeShadowReview({ ...row, result_json: { summary: JSON.stringify({ ...review,
    findings: [{ severity: 'P0', summary: 'Critical', sourceRef: ref }] }) } }, packet, 'codex_local'), null);
  assert.equal(parseNativeShadowReview({ ...row, result_json: { summary: 'Looks good' } }, packet, 'codex_local'), null);
  const fixture = { ...review, fixture: 'local-process-shadow-review' };
  delete fixture.schema;
  assert.equal(parseNativeShadowReview({ status: 'succeeded', result_json: {
    stdout: JSON.stringify(fixture) } }, packet, 'process').provenance.synthetic, true);
});

test('session prompt is one pinned v2 JSON packet; run query is scoped', async () => {
  const text = nativeReviewPrompt(packet, []);
  assert.match(text, /^Perform one independent review of this authenticated candidate snapshot\.\n\{/);
  assert.equal(JSON.parse(text.slice(text.indexOf('\n') + 1)).kind, 'polyforge-shadow-review-v2');
  assert.match(shadowTaskKey('plugin', 'request'), /^plugin:plugin:session:shadow:[a-f0-9]{64}$/);
  let observed;
  await readNativeShadowRun({ query: async (sql, params) => {
    observed = { sql, params }; return []; } },
  { companyId: 'company', agentId: 'agent', executionId: 'run', taskKey: 'key' });
  assert.match(observed.sql, /company_id=\$1 AND agent_id=\$2 AND id=\$3/);
  assert.deepEqual(observed.params, ['company', 'agent', 'run', 'key']);
});
