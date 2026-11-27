import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignCompanyOrganization, alignOrganization } from '../../src/plugin/alignment.mjs';
import { reportingPlan } from '../../src/plugin/reporting.mjs';
import { createReportingLifecycle } from '../../src/plugin/reporting-lifecycle.mjs';
import { GraphEngine } from '../../src/core/index.mjs';

test('company provisioning applies native reporting before confirming success', async () => {
  const agent = { id: 'cpo', companyId: 'company', reportsTo: null };
  const operations = [];
  await alignCompanyOrganization({ companyId: agent.companyId, pack: { id: 'adlc', version: '1' },
    command: async (operation, fields) => {
      operations.push(operation);
      if (operation === 'provision-pack') assert.equal(fields.packId, 'adlc');
      if (operation === 'organization-reporting-plan') return { planDecisionId: 'plan', conflicts: [],
        changes: [{ agentId: agent.id, fromReportsTo: null, toReportsTo: 'ceo' }] };
      if (operation === 'organization-reporting-confirm') {
        assert.equal(fields.planDecisionId, 'plan');
        assert.equal(agent.reportsTo, 'ceo');
        return { aligned: true };
      }
    },
    readAgent: async () => agent, patchAgent: async (_, reportsTo) => Object.assign(agent, { reportsTo }),
  });
  assert.deepEqual(operations, ['provision-pack', 'configure-organization', 'organization-reporting-plan', 'organization-reporting-confirm']);
});

for (const scope of ['issue', 'company', 'company with pack']) {
  const withPack = scope === 'company with pack';
  const align = scope === 'issue' ? alignOrganization : alignCompanyOrganization;
  const planOperation = scope === 'issue' ? 'org-reporting-plan' : 'organization-reporting-plan';
  const confirmOperation = scope === 'issue' ? 'org-reporting-confirm' : 'organization-reporting-confirm';
  const fields = { companyId: 'company', issueId: 'issue',
    ...(withPack ? { pack: { id: 'adlc', version: '1' } } : {}) };

  test(`${scope} alignment reports manager conflicts before any agent read or patch`, async () => {
    const operations = [];
    let reads = 0, patches = 0;
    await assert.rejects(align({ ...fields,
      command: async input => {
        const operation = typeof input === 'string' ? input : input.operation;
        operations.push(operation);
        if (operation === planOperation) return { planDecisionId: 'blocked-plan',
          conflicts: [{ roleId: 'adlc:cpo' }, { roleId: 'creative:head' }],
          changes: [{ roleId: 'adlc:designer', agentId: 'designer', fromReportsTo: null, toReportsTo: 'cpo' }] };
      },
      readAgent: async () => { reads++; throw new Error('Unexpected agent read'); },
      patchAgent: async () => { patches++; throw new Error('Unexpected agent patch'); },
    }), error => {
      assert.match(error.message, /No manager was changed/);
      assert.match(error.message, /Review the existing manager for adlc:cpo, creative:head/);
      assert.match(error.message, /alignment is blocked by existing managers that need review/i);
      assert.doesNotMatch(error.message, /resume|retry|pending|Run alignment again/i);
      if (withPack) assert.match(error.message, /^Roles provisioned for adlc\./);
      return true;
    });
    assert.equal(reads, 0);
    assert.equal(patches, 0);
    assert.deepEqual(operations, scope === 'issue' ? [planOperation]
      : [...(withPack ? ['provision-pack'] : []), 'configure-organization', planOperation]);
  });

  test(`${scope} alignment confirms a plan with no changes field`, async () => {
    const operations = [];
    await align({ ...fields,
      command: async (input, args) => {
        const operation = typeof input === 'string' ? input : input.operation;
        operations.push(operation);
        if (operation === planOperation) return { planDecisionId: 'empty-plan', conflicts: [] };
        if (operation === confirmOperation) {
          assert.equal((args ?? input).planDecisionId, 'empty-plan');
          return { aligned: true };
        }
      },
      readAgent: () => assert.fail('An empty plan must not read agents'),
      patchAgent: () => assert.fail('An empty plan must not patch agents'),
    });
    assert.equal(operations.at(-1), confirmOperation);
  });
}

test('alignment resumes one approved plan after a partial host PATCH failure', async () => {
  const companyId = 'company', issueId = 'issue', actor = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const pack = { id: 'adlc', version: '1' };
  const roles = { cpo: { reportsToRole: null }, designer: { reportsToRole: 'cpo' }, analyst: { reportsToRole: 'cpo' } };
  const agents = Object.fromEntries(Object.keys(roles).map((roleId) =>
    [roleId, { id: roleId, companyId, reportsTo: null }]));
  const engine = new GraphEngine();
  const lifecycle = createReportingLifecycle({ engine, companyId, actor, issueId, pack,
    readSetup: async () => ({}),
    readPlan: async () => {
      const managed = Object.fromEntries(Object.entries(agents).map(([roleId, agent]) =>
        [roleId, { agentId: agent.id, agent }]));
      return { managed, plan: reportingPlan(roles, managed, companyId) };
    },
  });
  let failAnalystOnce = true;
  let patches = 0;
  const command = async ({ operation, ...fields }) => {
    if (operation === 'org-reporting-plan') return lifecycle.request(fields);
    if (operation === 'org-reporting-confirm') return lifecycle.confirm(fields);
    throw new Error(`Unexpected operation ${operation}`);
  };
  const adapters = { companyId, issueId, command,
    readAgent: async (id) => structuredClone(agents[id]),
    patchAgent: async (id, reportsTo) => {
      patches++;
      if (id === 'analyst' && failAnalystOnce) { failAnalystOnce = false; throw new Error('Host PATCH failed'); }
      agents[id].reportsTo = reportsTo;
      return structuredClone(agents[id]);
    } };
  await assert.rejects(alignOrganization(adapters), /Host PATCH failed\. Run alignment again to verify or resume plan /);
  const [original] = await engine.listDecisions();
  assert.equal(agents.designer.reportsTo, 'cpo');
  assert.equal(agents.analyst.reportsTo, null);
  const { plan, confirmation } = await alignOrganization(adapters);
  assert.equal(plan.planDecisionId, original.id);
  assert.equal(plan.changes.length, 1);
  assert.equal(confirmation.aligned, true);
  assert.equal(patches, 3);
  const decisions = await engine.listDecisions();
  assert.deepEqual(decisions.map(item => item.status), ['approved', 'applied']);
  assert.equal(decisions[1].supersedes, original.id);
  assert.equal(agents.analyst.reportsTo, 'cpo');
});
