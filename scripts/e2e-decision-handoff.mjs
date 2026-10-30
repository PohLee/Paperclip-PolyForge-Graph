// Real Paperclip interaction transport with synthetic product decisions.
// No model execution or real product change is part of this fixture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { client as defaultClient, waitFor as defaultWaitFor, pluginId } from './enhancement-client.mjs';

const companyId = process.env.POLYFORGE_TEMPORARY_COMPANY_ID ?? '102d94df-b5e6-432f-af03-57440e026124';
const projectId = process.env.POLYFORGE_TEMPORARY_PROJECT_ID ?? '4c3410ed-3a05-47b5-b13e-7b1f20e2071d';
const clientPath = process.env.POLYFORGE_E2E_CLIENT;
if (clientPath && !isAbsolute(clientPath)) throw new Error('POLYFORGE_E2E_CLIENT must be absolute');
const custom = clientPath ? await import(pathToFileURL(clientPath).href) : null;
const { data } = await (custom?.client ?? defaultClient)();
const waitFor = custom?.waitFor ?? defaultWaitFor;
const nonce = randomUUID();
const feature = `decision-handoff-fixture-${nonce}`;
let issue;
let completed = false;
try {
  issue = await data('POST', `/api/companies/${companyId}/issues`, {
    projectId, title: `Synthetic Decision Handoff acceptance ${nonce}`,
    description: 'Deterministic native card deferral/rejection/replay acceptance. No agent assignment or real product change.',
    status: 'todo', priority: 'low',
  });
  const graphPath = `/api/plugins/${pluginId}/api/issues/${issue.id}/graph`;
  const interactionsPath = `/api/issues/${issue.id}/interactions`;
  const companyPath = `/api/plugins/${pluginId}/api/company?companyId=${companyId}`;
  const record = (status, fields = {}) => data('POST', graphPath, {
    operation: 'product-decision', feature, status,
    outcome: status === 'approved' ? 'Synthetic baseline remains unchanged' : 'Synthetic proposal to replace the baseline',
    reason: 'Automated development acceptance fixture, not an actual product decision',
    evidence: [{ kind: 'synthetic_fixture', id: issue.id }],
    changeScope: ['synthetic-only'], ...fields, idempotencyKey: `${nonce}:${status}`,
  });
  const baseline = (await record('approved')).result;
  const proposal = (await record('proposed', { supersedes: baseline.id })).result;
  const cards = () => data('GET', interactionsPath);
  const answer = (card, choice) => data('POST', `${interactionsPath}/${card.id}/respond`, {
    answers: [{ questionId: 'choice', optionIds: [choice] },
      { questionId: 'reason', optionIds: [], otherText: `Synthetic ${choice} for Decision Handoff regression` }],
  });
  const first = await waitFor(async () => {
    await data('GET', graphPath);
    return (await cards()).find(card => card.idempotencyKey === `polyforge-product-decision:${proposal.id}`);
  }, 'initial native product Decision card', 30_000);
  assert.equal(first.status, 'pending');
  assert.equal(first.resolverPolicy, 'human_only');
  await data('GET', companyPath);
  await data('GET', graphPath);
  assert.equal((await cards()).length, 1, 'Repeated reads duplicated the pending card');

  await answer(first, 'defer');
  const successor = await waitFor(async () => {
    await data('GET', graphPath);
    return (await cards()).find(card => card.idempotencyKey === `polyforge-product-decision:${proposal.id}:1`);
  }, 'one deferred successor card', 30_000);
  assert.equal(successor.status, 'pending');
  assert.notEqual(successor.id, first.id);
  await answer(successor, 'reject');
  const rejection = await waitFor(async () => {
    await data('GET', graphPath);
    const state = await data('GET', companyPath);
    return state.decisions.find(item => item.proposalId === proposal.id && item.status === 'rejected');
  }, 'native rejection persisted as Decision Record', 30_000);
  for (let i = 0; i < 2; i++) await data('GET', graphPath);
  const state = await data('GET', companyPath);
  const answers = state.decisions.filter(item => item.proposalId === proposal.id);
  assert.equal(answers.filter(item => item.status === 'deferred').length, 1);
  assert.equal(answers.filter(item => item.status === 'rejected').length, 1);
  assert.equal(answers.filter(item => item.status === 'approved').length, 0);
  assert.equal((await cards()).length, 2, 'Replay created an extra native card');
  assert.equal(state.decisions.find(item => item.id === baseline.id)?.status, 'approved');
  assert.equal(rejection.evidence.find(item => item.kind === 'paperclip_decision')?.interactionId, successor.id);
  await data('PATCH', `/api/issues/${issue.id}`, { status: 'done' });
  completed = true;
  console.log(JSON.stringify({ companyId, issueId: issue.id, feature, baselineId: baseline.id,
    proposalId: proposal.id, firstCardId: first.id, successorCardId: successor.id,
    rejectionId: rejection.id, cardCount: 2, deferredCount: 1, rejectedCount: 1,
    baselinePreserved: true, replayIdempotent: true, modelExecution: false }));
} finally {
  if (issue && !completed) await data('PATCH', `/api/issues/${issue.id}`, { status: 'cancelled' });
}
