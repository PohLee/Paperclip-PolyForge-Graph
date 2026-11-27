import { createHash } from 'node:crypto';
import { canonical } from '../core/canonical.mjs';
import { requireReportingIntent } from '../core/organization-reporting.mjs';

function hashProfiles({ plan, managed }, field) {
  if (!managed) return plan;
  return { ...plan, assignments: plan.assignments.map((item) => ({ ...item,
    [field]: createHash('sha256').update(canonical(managed[item.roleId].agent)).digest('hex'),
  })) };
}

export function createReportingLifecycle({ engine, actor, companyId, issueId = null, pack, readSetup, readPlan }) {
  const scope = { actor, companyId, issueId, pack };
  return {
    async request({ reason, idempotencyKey }) {
      const setup = structuredClone(await readSetup());
      const plan = hashProfiles(await readPlan(setup), 'profileSha256Before');
      const { record, resumed } = await engine.recordReportingDecision({ ...scope, setup, plan, reason, idempotencyKey });
      return { planDecisionId: record.id, ...plan, ...(resumed ? { resumed } : {}) };
    },
    async confirm({ planDecisionId, reason, idempotencyKey }) {
      const setup = structuredClone(await readSetup());
      const request = { ...scope, setup, planDecisionId, reason, idempotencyKey };
      requireReportingIntent(await engine.listDecisions(), request);
      const plan = hashProfiles(await readPlan(setup), 'profileSha256After');
      const { record } = await engine.recordReportingDecision({ ...request, plan });
      const result = record.evidence.find((item) => item.kind === 'organization_result');
      return { aligned: true, decisionId: record.id, assignments: result.assignments };
    },
  };
}
