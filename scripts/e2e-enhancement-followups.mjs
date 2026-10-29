import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { client, root, pluginId } from './enhancement-client.mjs';
import { runChannelCases } from './enhancement-channel-cases.mjs';
import { runShadowSessionCase } from './e2e-shadow-session.mjs';

const checkpoint = resolve(root, '.e2e/enhancement-checkpoint.json');
const state = JSON.parse(await readFile(checkpoint, 'utf8'));
const { auth, call, data } = await client();
const endpoint = `/api/plugins/${pluginId}/api/company`;
const read = companyId => data('GET', `${endpoint}?companyId=${companyId}`);
const save = () => writeFile(checkpoint, JSON.stringify(state, null, 2));
const command = (companyId, operation, fields = {}, key) => data('POST', endpoint, {
  companyId, operation, reason: `Local deterministic enhancement acceptance: ${operation}`,
  idempotencyKey: key ?? `followup:${Date.now()}:${operation}`, ...fields,
});
const record = async (name, proof) => {
  state.cases = state.cases.filter(item => item.name !== name);
  state.cases.push({ name, status: 'passed', at: new Date().toISOString(), proof });
  await save(); console.log(`PASS ${name}`);
};
const selected = new Set(process.argv.slice(2));
try {
  if (!selected.size || selected.has('channels')) await runChannelCases({ state, save, record, command, read, data, call, auth });
  if (!selected.size || selected.has('shadow')) await runShadowSessionCase({ state, save, record, command, read, data, call, auth });
  state.status = 'passed'; delete state.failure;
} catch (error) {
  state.status = 'failed'; state.failure = { message: error.message, at: new Date().toISOString() }; throw error;
} finally {
  await save();
  await writeFile(resolve(root, '.e2e/enhancement-result.json'), JSON.stringify(state, null, 2));
}
