import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { client, root, pluginId, waitFor } from './enhancement-client.mjs';

const checkpoint = resolve(root, '.e2e/enhancement-checkpoint.json');
const state = JSON.parse(await readFile(checkpoint, 'utf8'));
const { data } = await client();
const a = state.development;
const endpoint = `/api/plugins/${pluginId}/api/company?companyId=${a.companyId}`;
const company = await data('GET', endpoint), ceoId = company.setup.organization.ceo.id;
const head = company.setup.organization.domainHeads.find(item => item.domain === 'product');
await waitFor(async () => (await data('GET', `/api/agents/${ceoId}`)).status === 'idle', 'local CEO idle before native chat intake', 90_000);
const comment = await data('POST', `/api/issues/${a.issueId}/comments`, {
  body: `Synthetic CEO intake fixture: delegate product work ${Date.now()}.`,
});
const routed = await waitFor(async () => {
  const current = await data('GET', endpoint);
  return current.control.intake.find(item => item.source?.messageId === comment.id &&
    item.status === 'offered' && item.assigneeId === head.agentId);
}, 'native chat automatically wakes CEO and routes to product head', 120_000);
const issues = await data('GET', `/api/companies/${a.companyId}/issues`);
const issue = issues.find(item => item.originKind === `plugin:${pluginId}:intake` && item.originId === routed.id);
assert.ok(issue); assert.equal(issue.assigneeAgentId, head.agentId);
const after = await data('GET', endpoint);
const decision = after.control.audit.find(item => item.kind === 'intake.routed' && item.newRef?.id === routed.id);
assert.equal(decision?.actor.id, ceoId); assert.ok(decision.actor.executionId);
const name = 'Native chat automatically wakes delegated CEO and routes to domain Agent';
state.cases = state.cases.filter(item => item.name !== name);
state.cases.push({ name, status: 'passed', at: new Date().toISOString(), proof: {
  companyId: a.companyId, commentId: comment.id, intakeId: routed.id, issueId: issue.id,
  executionId: decision.actor.executionId, assigneeId: head.agentId,
} });
await writeFile(checkpoint, JSON.stringify(state, null, 2));
await writeFile(resolve(root, '.e2e/enhancement-result.json'), JSON.stringify(state, null, 2));
console.log(`PASS ${name}`);
