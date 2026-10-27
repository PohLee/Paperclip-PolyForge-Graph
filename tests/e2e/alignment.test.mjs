import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignOrganization } from '../../src/plugin/alignment.mjs';
import { reportingPlan, resumableReportingPlan } from '../../src/plugin/reporting.mjs';

test('alignment resumes one approved plan after a partial host PATCH failure', async () => {
  const companyId = 'company', issueId = 'issue', actor = { id: 'owner', kind: 'human' };
  const pack = { id: 'adlc', version: '1' };
  const roles = { cpo: { reportsToRole: null }, designer: { reportsToRole: 'cpo' }, analyst: { reportsToRole: 'cpo' } };
  const agents = Object.fromEntries(Object.keys(roles).map((roleId) =>
    [roleId, { id: roleId, companyId, reportsTo: null }]));
  const decisions = [];
  let failAnalystOnce = true;
  let patches = 0;
  const command = async ({ operation, planDecisionId }) => {
    if (operation === 'org-reporting-plan') {
      const managed = Object.fromEntries(Object.entries(agents).map(([roleId, agent]) =>
        [roleId, { agentId: agent.id, agent }]));
      const plan = reportingPlan(roles, managed, companyId);
      const open = resumableReportingPlan(decisions, { actor, issueId, companyId, pack, assignments: plan.assignments });
      if (!open) decisions.push({ id: `plan-${decisions.length + 1}`, type: 'adlc_reporting', status: 'approved',
        actor, issueId, evidence: [{ kind: 'organization_plan', companyId, packId: pack.id,
          packVersion: pack.version, assignments: plan.assignments }] });
      return { planDecisionId: open?.id ?? decisions.at(-1).id, ...plan };
    }
    if (operation === 'org-reporting-confirm') {
      assert.equal(agents.designer.reportsTo, 'cpo');
      assert.equal(agents.analyst.reportsTo, 'cpo');
      decisions.push({ id: 'applied', type: 'adlc_reporting', status: 'applied', supersedes: planDecisionId });
      return { aligned: true };
    }
    throw new Error(`Unexpected operation ${operation}`);
  };
  const adapters = { companyId, issueId, command, newKey: () => 'key',
    readAgent: async (id) => structuredClone(agents[id]),
    patchAgent: async (id, reportsTo) => {
      patches++;
      if (id === 'analyst' && failAnalystOnce) { failAnalystOnce = false; throw new Error('Host PATCH failed'); }
      agents[id].reportsTo = reportsTo;
      return structuredClone(agents[id]);
    } };
  await assert.rejects(alignOrganization(adapters), /resume plan plan-1/);
  assert.equal(agents.designer.reportsTo, 'cpo');
  assert.equal(agents.analyst.reportsTo, null);
  const { plan, confirmation } = await alignOrganization(adapters);
  assert.equal(plan.planDecisionId, 'plan-1');
  assert.equal(plan.changes.length, 1);
  assert.equal(confirmation.aligned, true);
  assert.equal(patches, 3);
  assert.equal(decisions.filter((item) => item.status === 'approved').length, 1);
  assert.equal(resumableReportingPlan(decisions, { actor, issueId, companyId, pack, assignments: plan.assignments }), null);
});
