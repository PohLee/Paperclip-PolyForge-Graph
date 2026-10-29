import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { client, root, pluginId } from './enhancement-client.mjs';

// Uses the existing isolated development host. Reloads installed Pack content;
// does not change Pack files, invoke models or send external notifications.
const state = JSON.parse(await readFile(resolve(root, '.e2e/enhancement-checkpoint.json'), 'utf8'));
const { data } = await client();
const endpoint = `/api/plugins/${pluginId}`;
const companyId = state.development.companyId;
const company = id => data('GET', `${endpoint}/api/company?companyId=${id}`);
const [before, isolatedBefore] = await Promise.all([company(companyId), company(state.marketing.companyId)]);
const proof = state.cases.find(item => item.name.startsWith('Cross-Pack plan dependency'))?.proof;
assert.ok(proof?.planId, 'Existing completed plan fixture is required');
const planBefore = before.control.plans.find(item => item.id === proof.planId);
assert.ok(planBefore?.items.some(item => item.runId === proof.linkedRunId && item.status === 'completed'));
const again = await company(companyId);
assert.deepEqual(again.control.plans.find(item => item.id === proof.planId), planBefore);
const planDecisions = view => view.control.audit.filter(item => item.planId === proof.planId &&
  item.kind === 'work-item.reconciled').map(item => item.id);
assert.deepEqual(planDecisions(again), planDecisions(before));

const historical = before.runs.find(item => item.id === state.crossPackReleaseRunId);
assert.equal(historical?.status, 'completed');
assert.ok(historical.issueId);
const graphPath = `${endpoint}/api/issues/${historical.issueId}/graph?runId=${historical.id}`;
const oldRunBefore = (await data('GET', graphPath)).run;
assert.equal(oldRunBefore.packVersion, '0.2.0');
const pinned = run => ({ pack: run.pack, graph: run.graph, goalContext: run.goalContext,
  nodeStates: run.nodeStates, packVersion: run.packVersion });

const commandPath = `${endpoint}/api/issues/${state.development.issueId}/graph`;
const key = `architecture-reload:${Date.now()}`;
await assert.rejects(data('POST', commandPath, { operation: 'reload-pack', packId: 'adlc',
  packVersion: '99.0.0', reason: 'Verify failed selection retains the current catalog',
  idempotencyKey: `${key}:invalid` }), /not installed/);
assert.deepEqual((await company(companyId)).catalog, before.catalog);
const reloaded = await data('POST', commandPath, { operation: 'reload-pack', packId: 'adlc',
  packVersion: '0.2.1', reason: 'Verify Pack reload and historical run visibility',
  idempotencyKey: `${key}:valid` });
assert.equal(reloaded.pack.version, '0.2.1');
const [after, isolatedAfter] = await Promise.all([company(companyId), company(state.marketing.companyId)]);
assert.deepEqual(after.enabledPacks, before.enabledPacks);
assert.deepEqual(isolatedAfter.enabledPacks, isolatedBefore.enabledPacks);
assert.deepEqual(pinned((await data('GET', graphPath)).run), pinned(oldRunBefore));
assert.equal((await data('GET', endpoint)).status, 'ready');

const result = { at: new Date().toISOString(), passed: true, companyId,
  cases: [
    { name: 'Company reads reconcile real plans without duplicate changes', planId: proof.planId },
    { name: 'Failed Pack selection retains catalog and valid reload recovers' },
    { name: 'Pack reload preserves per-company activation', otherCompanyId: state.marketing.companyId },
    { name: 'Historical run remains readable and pinned', runId: historical.id, packVersion: oldRunBefore.packVersion },
  ] };
await writeFile(resolve(root, '.e2e/architecture-deepening-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
