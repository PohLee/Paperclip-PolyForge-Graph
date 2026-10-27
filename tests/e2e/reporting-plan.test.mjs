import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportingPlan } from '../../src/plugin/reporting.mjs';

const roles = { cpo: { reportsToRole: null }, cto: { reportsToRole: null }, designer: { reportsToRole: 'cpo' }, engineer: { reportsToRole: 'cto' } };
const managed = Object.fromEntries(Object.keys(roles).map((roleId) => [roleId, { agentId: roleId, agent: { id: roleId, companyId: 'company', reportsTo: null, adapterConfig: { custom: true } } }]));

test('plans only missing managed reporting edges and preserves custom profiles', () => {
  const plan = reportingPlan(roles, managed, 'company');
  assert.deepEqual(plan.changes.map((item) => [item.roleId, item.toReportsTo]), [['designer', 'cpo'], ['engineer', 'cto']]);
  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(managed.engineer.agent.adapterConfig, { custom: true });
});

test('does not overwrite a nonempty custom manager', () => {
  managed.designer.agent.reportsTo = 'custom-agent';
  const plan = reportingPlan(roles, managed, 'company');
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].roleId, 'designer');
  managed.designer.agent.reportsTo = null;
});

test('rejects reporting cycles and cross-company managed agents', () => {
  assert.throws(() => reportingPlan({ ...roles, cpo: { reportsToRole: 'designer' } }, managed, 'company'), /cycle/);
  assert.throws(() => reportingPlan(roles, { ...managed, engineer: { agentId: 'engineer', agent: { companyId: 'other' } } }, 'company'), /missing from this company/);
});
