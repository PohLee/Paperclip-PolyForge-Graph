import { createHash } from 'node:crypto';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { GraphEngine, CompanyControlPlane, CORE_RUNTIME, preflightPackChange } from '../core/index.mjs';
import { selectPack, resourceKey } from './catalog.mjs';
import { createPackRegistry } from './pack-registry.mjs';
import { createCompanyApi } from './company-api.mjs';
import { createChannelBridge } from './channel-bridge.mjs';
import { createShadowRuntime } from './shadow-runtime.mjs';
import { shadowAgentEligible } from './shadow-native.mjs';
import { assertNotShadowCommand } from './shadow-authority.mjs';
import { syncGraphDecision } from './native-decisions.mjs';
import { recordIntervention, proposeInterventionImprovement, updateInterventionImprovement, interventionReport } from '../core/intervention-ledger.mjs';
import { reportingPlan, resumableReportingPlan } from './reporting.mjs';
import { createDispatch } from './dispatch.mjs';
import { createOwnerDispatchSingleflight } from './dispatch-control.mjs';
import { handoffSnapshot, isIndependentReview, projectReviewRun } from './review-context.mjs';
import {
  PaperclipStore, getGraphConfig, setGraphConfig, getDispatchForRunIssue,
  appendDispatchRequest, listDispatchRequests, getEvidenceProviders, setEvidenceProviders,
  listGraphCompanies,
} from './store.mjs';

let host;
let dispatch;
let companyApi;
let channelBridge;
let shadowRuntime;
let packRegistry;
const ownerDispatches = createOwnerDispatchSingleflight();

const string = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const errorMessage = (error) => error instanceof Error ? error.message : String(error);
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const roleIn = (pack, role) => Boolean(pack.roles?.[role]);
const packRole = (pack, role) => resourceKey(pack.id, role);
const boundRole = (pack, role, bindings) => bindings[packRole(pack, role)] ?? (pack.id === 'adlc' ? bindings[role] : undefined);
function actorForPack(actor, pack) {
  return { ...actor, roles: [...new Set([...actor.roles,
    ...Object.keys(pack.roles ?? {}).filter((role) => actor.roles.includes(packRole(pack, role)) ||
      (pack.id === 'adlc' && actor.roles.includes(role)))])] };
}
async function requestedPack(payload) {
  return selectPack(await packRegistry.installed(), string(payload.packId) ?? 'adlc', string(payload.packVersion));
}

const availableCapabilities = {
  'dashboard-read-model': '1.0.0',
};

async function companyCapabilities(companyId) {
  const providers = await getEvidenceProviders(host.db, companyId);
  const capabilities = { ...availableCapabilities };
  if (providers.some((item) => item.enabled !== false && item.kinds?.includes('release'))) capabilities['verified-release-event'] = '1.0.0';
  if (providers.some((item) => item.enabled !== false && item.kinds?.includes('metric'))) capabilities['sourced-metrics'] = '1.0.0';
  const sessions = host.agents?.sessions;
  if (['create', 'sendMessage', 'close', 'list'].every((method) => typeof sessions?.[method] === 'function')) {
    const config = await getGraphConfig(host.db, companyId);
    const state = await new PaperclipStore(host.db, companyId).read();
    const ceoId = state?.control?.organization?.ceo?.id;
    const policy = state?.control?.shadowPolicy;
    if (policy?.enabled && ceoId && config.roleBindings?.ceo === ceoId) {
      const boundIds = [...new Set(Object.values(config.roleBindings ?? {}))]
        .filter((id) => typeof id === 'string' && id !== ceoId);
      for (const id of boundIds) {
        try {
          const agent = await host.agents.get(id, companyId);
          if (agent?.companyId === companyId && shadowAgentEligible(agent, policy)) {
            capabilities['shadow-review-execution'] = '1.0.0';
            break;
          }
        } catch { /* An unavailable native scope cannot advertise execution. */ }
      }
    }
  }
  return { capabilities, providers };
}

async function managedReporting(companyId, pack) {
  const managed = {};
  const setup = await (await engineFor(companyId)).control.getSetup();
  for (const roleId of Object.keys(pack.roles)) {
    const key = resourceKey(pack.id, roleId);
    const resolution = await host.agents.managed.get(key, companyId);
    if (resolution.pluginKey !== host.manifest.id || resolution.resourceKind !== 'agent' ||
        resolution.resourceKey !== key || !resolution.agentId) throw new Error(`Managed agent ${key} is not owned by this plugin`);
    const agent = await host.agents.get(resolution.agentId, companyId);
    managed[roleId] = { ...resolution, agent };
  }
  return { managed, plan: reportingPlan(pack.roles, managed, companyId,
    setup.organization?.ceo?.id ? { ceo: setup.organization.ceo.id } : {}) };
}

async function prepareCompany(companyId, previous) {
  let company = previous;
  const { capabilities, providers } = await companyCapabilities(companyId);
  if (!company) {
    const store = new PaperclipStore(host.db, companyId);
    company = { store, capabilities,
      engine: new GraphEngine({ store, availableCapabilities: capabilities }),
      control: new CompanyControlPlane({ store, companyId, availableCapabilities: capabilities,
        trustedProviders: providers.filter((item) => item.enabled !== false).map((item) => item.id) }) };
  } else {
    Object.assign(company.capabilities, capabilities);
    for (const key of ['verified-release-event', 'sourced-metrics', 'shadow-review-execution']) {
      if (!Object.hasOwn(capabilities, key)) delete company.capabilities[key];
    }
    company.control.trustedProviders = new Set(providers.filter((item) => item.enabled !== false).map((item) => item.id));
  }
  return company;
}

async function engineFor(companyId) { return packRegistry.forCompany(companyId); }

async function dispatchOwnerOnce(companyId, engine, runId, config) {
  return ownerDispatches.run(companyId, runId, () => dispatch.dispatchReady(companyId, engine, runId, config));
}

async function humanMembership(companyId, userId) {
  const members = await host.access.members.list({ companyId });
  return members.find((item) => item.principalType === 'user' && item.principalId === userId && item.status === 'active') ?? null;
}

async function trustedActor(companyId, hostActor, config) {
  if (hostActor?.actorType === 'user' && hostActor.userId) {
    const membership = await humanMembership(companyId, hostActor.userId);
    if (!membership) throw new Error('Authenticated user has no active company membership');
    const roles = new Set(list(config.userRoles[hostActor.userId]));
    if (['owner', 'admin'].includes(membership.membershipRole)) roles.add('human-owner');
    return {
      actor: { id: hostActor.userId, kind: 'human', roles: [...roles], executionId: null },
      isAdministrator: ['owner', 'admin'].includes(membership.membershipRole),
    };
  }
  if (hostActor?.actorType === 'agent' && hostActor.agentId && hostActor.runId) {
    await assertNotShadowCommand(host.db, companyId, hostActor, host.manifest.id);
    const roles = Object.entries(config.roleBindings)
      .filter(([, agentId]) => agentId === hostActor.agentId)
      .map(([role]) => role);
    return { actor: { id: hostActor.agentId, kind: 'agent', roles, executionId: hostActor.runId }, isAdministrator: false };
  }
  throw new Error('An authenticated Paperclip user or active agent run is required');
}

async function assertIssue(companyId, issueId) {
  const issue = await host.issues.get(issueId, companyId);
  if (!issue) throw new Error('Paperclip issue not found in company');
  return issue;
}


async function assertRunIssue(engine, companyId, issueId, runId, actor, nodeId, operation, idempotencyKey) {
  const run = await engine.getRun(runId);
  if (!run) throw new Error('Graph run not found');
  if (actor.kind === 'agent') {
    await dispatch.assertAgentCallback({ companyId, issueId, run, actor, nodeId, operation, idempotencyKey });
  } else if (run.input.paperclipIssueId !== issueId) {
    throw new Error('Human Graph action must use its root Paperclip issue');
  }
  return run;
}


async function command({ companyId, issueId, body, hostActor }) {
  await assertIssue(companyId, issueId);
  const payload = object(body);
  const operation = string(payload.operation);
  if (!operation) throw new Error('operation is required');
  const config = await getGraphConfig(host.db, companyId);
  const { actor, isAdministrator } = await trustedActor(companyId, hostActor, config);
  if (operation === 'configure') {
    if (!isAdministrator) throw new Error('Only a company owner or admin may configure Graph actor bindings');
    const roleBindings = payload.roleBindings === undefined ? config.roleBindings : object(payload.roleBindings);
    const userRoles = payload.userRoles === undefined ? config.userRoles : object(payload.userRoles);
    const defaultMode = string(payload.defaultMode) ?? config.defaultMode;
    if (!['manual', 'assisted', 'autonomous'].includes(defaultMode)) throw new Error('Invalid company default decision mode');
    const catalog = await packRegistry.installed();
    for (const [role, agentId] of Object.entries(roleBindings)) {
      const known = role === 'ceo' || catalog.some((pack) => role.startsWith(`${pack.id}:`) ? roleIn(pack, role.slice(pack.id.length + 1)) : pack.id === 'adlc' && roleIn(pack, role));
      if (!known || typeof agentId !== 'string' || !await host.agents.get(agentId, companyId)) {
        throw new Error(`Invalid agent binding for role ${role}`);
      }
    }
    const members = await host.access.members.list({ companyId });
    for (const [userId, roles] of Object.entries(userRoles)) {
      if (!members.some((m) => m.principalType === 'user' && m.principalId === userId && m.status === 'active')) throw new Error(`Inactive or unknown human user: ${userId}`);
      if (!Array.isArray(roles) || roles.some((role) => role !== 'human-owner' &&
        !catalog.some((pack) => role.startsWith(`${pack.id}:`) ? roleIn(pack, role.slice(pack.id.length + 1)) : pack.id === 'adlc' && roleIn(pack, role)))) throw new Error(`Invalid human role binding for ${userId}`);
    }
    const { engine } = await engineFor(companyId);
    const bindingChange = { kind: 'actor_binding_change', companyId, issueId,
      before: { roleBindings: config.roleBindings, userRoles: config.userRoles, defaultMode: config.defaultMode },
      after: { roleBindings, userRoles, defaultMode } };
    await engine.recordDecision({ type: 'actor_binding_configuration', status: 'approved', outcome: 'requested',
      reason: string(payload.reason) ?? 'Company owner configured Graph actor bindings', actor,
      evidence: [bindingChange],
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:intent` });
    await setGraphConfig(host.db, companyId, { roleBindings, userRoles, defaultMode });
    await engine.recordDecision({ type: 'actor_binding_configuration', status: 'applied', outcome: 'updated',
      reason: string(payload.reason) ?? 'Company owner configured Graph actor bindings', actor,
      evidence: [bindingChange],
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:result` });
    return { configured: true, roleBindings, userRoles, defaultMode };
  }
  if (operation === 'org-reporting-plan') {
    if (!isAdministrator || actor.kind !== 'human') throw new Error('Only a company owner or admin may align ADLC reporting');
    const reason = string(payload.reason);
    if (!reason) throw new Error('A reason is required to change agent reporting');
    const pack = await requestedPack(payload);
    const { engine } = await engineFor(companyId);
    const { managed, plan } = await managedReporting(companyId, pack);
    const assignments = plan.assignments.map((item) => ({ ...item,
      profileSha256Before: digest(managed[item.roleId].agent) }));
    const open = !plan.conflicts.length && resumableReportingPlan(await engine.listDecisions(), {
      actor, issueId, companyId, pack, assignments,
    });
    if (open) return { planDecisionId: open.id, pack: { id: pack.id, version: pack.version },
      assignments, changes: plan.changes, conflicts: [], resumed: true };
    const record = await engine.recordDecision({ type: 'adlc_reporting',
      status: plan.conflicts.length ? 'blocked' : 'approved',
      outcome: plan.conflicts.length ? 'custom_manager_conflict' : 'requested',
      reason, actor, issueId,
      evidence: [{ kind: 'organization_plan', companyId, packId: pack.id, packVersion: pack.version,
        assignments, conflicts: plan.conflicts }],
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:intent` });
    return { planDecisionId: record.id, pack: { id: pack.id, version: pack.version },
      assignments, changes: plan.changes, conflicts: plan.conflicts };
  }
  if (operation === 'org-reporting-confirm') {
    if (!isAdministrator || actor.kind !== 'human') throw new Error('Only a company owner or admin may confirm ADLC reporting');
    const planDecisionId = string(payload.planDecisionId);
    if (!planDecisionId) throw new Error('planDecisionId is required');
    const pack = await requestedPack(payload);
    const { engine } = await engineFor(companyId);
    const intent = (await engine.listDecisions()).find((item) => item.id === planDecisionId);
    const recordedPlan = intent?.evidence?.find((item) => item.kind === 'organization_plan');
    if (intent?.type !== 'adlc_reporting' || intent.status !== 'approved' ||
        intent.actor?.id !== actor.id || intent.actor?.kind !== actor.kind ||
        intent.issueId !== issueId || recordedPlan?.companyId !== companyId ||
        recordedPlan?.packId !== pack.id || recordedPlan?.packVersion !== pack.version) {
      throw new Error('Reporting plan is missing, stale, or belongs to another actor');
    }
    const { managed, plan } = await managedReporting(companyId, pack);
    if (plan.conflicts.length || plan.changes.length ||
        canonical(plan.assignments.map(({ roleId, agentId, toReportsTo }) => ({ roleId, agentId, toReportsTo }))) !==
        canonical(recordedPlan.assignments.map(({ roleId, agentId, toReportsTo }) => ({ roleId, agentId, toReportsTo })))) {
      throw new Error('Reporting changes are incomplete or managed identities changed; retry the plan');
    }
    const after = plan.assignments.map((item) => ({ ...item,
      profileSha256After: digest(managed[item.roleId].agent) }));
    const result = await engine.recordDecision({ type: 'adlc_reporting', status: 'applied', outcome: 'aligned',
      reason: intent.reason, actor, issueId, supersedes: planDecisionId,
      evidence: [{ kind: 'organization_result', companyId, packId: pack.id, packVersion: pack.version,
        assignments: after }],
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:result` });
    return { aligned: true, planDecisionId, decisionId: result.id, assignments: after };
  }
  if (operation === 'provision') {
    if (!isAdministrator) throw new Error('Only a company owner or admin may provision ADLC agents and skills');
    const pack = await requestedPack(payload);
    if (Object.keys(pack.roles).some((role) => !host.manifest.agents?.some((item) => item.agentKey === packRole(pack, role))) ||
        Object.keys(pack.skills ?? {}).some((skill) => !host.manifest.skills?.some((item) => item.skillKey === resourceKey(pack.id, skill)))) {
      throw new Error('Installed manifest lacks this Pack’s managed resources; reinstall the plugin with the Pack mounted');
    }
    const { engine } = await engineFor(companyId);
    await engine.recordDecision({ type: 'adlc_provisioning', status: 'approved', outcome: 'requested',
      reason: string(payload.reason) ?? 'Company owner requested ADLC Pack provisioning', actor,
      evidence: [{ kind: 'pack', id: pack.id, version: pack.version,
        roles: Object.keys(pack.roles), skills: Object.keys(pack.skills ?? {}),
        priorRoleBindings: config.roleBindings }], issueId,
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:intent` });
    const skills = [];
    for (const skillId of Object.keys(pack.skills ?? {})) skills.push(await host.skills.managed.reconcile(resourceKey(pack.id, skillId), companyId));
    const agents = [];
    const roleBindings = { ...config.roleBindings };
    for (const roleId of Object.keys(pack.roles ?? {})) {
      const resolution = await host.agents.managed.reconcile(packRole(pack, roleId), companyId);
      agents.push(resolution);
      if (resolution.agentId && !roleBindings[packRole(pack, roleId)]) roleBindings[packRole(pack, roleId)] = resolution.agentId;
    }
    await setGraphConfig(host.db, companyId, { ...config, roleBindings });
    await engine.recordDecision({ type: 'adlc_provisioning', status: 'applied', outcome: 'reconciled',
      reason: string(payload.reason) ?? 'Company owner provisioned the ADLC Pack resources', actor,
      evidence: [{ kind: 'managed_agents', ids: agents.map((item) => item.agentId) },
        { kind: 'managed_skills', ids: skills.map((item) => item.skillId) },
        { kind: 'pack', id: pack.id, version: pack.version, roleBindings }],
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:result` });
    return { agents, skills, roleBindings };
  }
  if (operation === 'reload-pack') {
    if (!isAdministrator) throw new Error('Only a company owner or admin may reload the Pack');
    const { engine } = await engineFor(companyId);
    await engine.recordDecision({ type: 'pack_reload', status: 'approved', outcome: 'requested',
      reason: string(payload.reason) ?? 'Company owner requested a Pack reload', actor, issueId,
      evidence: [{ kind: 'catalog', releases: packRegistry.catalog().map((pack) => `${pack.id}@${pack.version}`) }],
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:intent` });
    const pack = await packRegistry.reload(companyId, {
      packId: string(payload.packId) ?? 'adlc', version: string(payload.packVersion),
    });
    await engine.recordDecision({ type: 'pack_reload', status: 'applied', outcome: `${pack.id}@${pack.version}`,
      reason: string(payload.reason) ?? 'Company owner loaded a new Pack version', actor,
      evidence: [{ kind: 'pack', id: pack.id, version: pack.version,
        roleIds: Object.keys(pack.roles), skillIds: Object.keys(pack.skills ?? {}),
        documentDigests: Object.fromEntries(Object.entries(pack.roles).map(([id, role]) => [id, role.documentDigests ?? {}])) }],
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:result` });
    return { pack: { id: pack.id, version: pack.version }, ready: Boolean(engine) };
  }
  const { engine, control } = await engineFor(companyId);
  if (operation === 'product-decision' && !string(payload.runId)) {
    if (!isAdministrator || actor.kind !== 'human') throw new Error('A company owner or admin must record a standalone product decision');
    const feature = string(payload.feature);
    if (!feature) throw new Error('feature is required for a product decision');
    const result = await engine.recordProductDecision({
      feature, actor, status: payload.status, outcome: payload.outcome, reason: payload.reason,
      evidence: list(payload.evidence), supersedes: payload.supersedes,
      proposalId: payload.proposalId, changeScope: list(payload.changeScope), idempotencyKey: string(payload.idempotencyKey),
    });
    return { result, productMemory: await engine.getProductMemory(feature) };
  }
  if (operation === 'start') {
    const pack = await requestedPack(payload);
    const graphId = string(payload.graphId);
    const mode = string(payload.mode) ?? config.defaultMode;
    if (!['manual', 'assisted', 'autonomous'].includes(mode)) throw new Error('Unknown decision mode');
    const setup = await control.getSetup();
    if (!setup.enabledPacks.some((item) => item.packId === pack.id && item.version === pack.version)) throw new Error('Pack is not enabled for this company');
    const packActor = actorForPack(actor, pack);
    if (!list(pack.graphStartRoles?.[graphId]).some((role) => packActor.roles.includes(role))) throw new Error('Actor role cannot start this Graph');
    if (actor.kind === 'agent') await host.issues.assertCheckoutOwner({
      issueId, companyId, actorAgentId: actor.id, actorRunId: actor.executionId,
    });
    const { goalContext: _untrustedGoalContext, ...input } = object(payload.input);
    const run = await engine.startRun({
      packId: pack.id, packVersion: pack.version, graphId, mode,
      input: { ...input, paperclipIssueId: issueId, paperclipCompanyId: companyId,
        projectId: (await assertIssue(companyId, issueId)).projectId ?? undefined },
      actor: packActor, idempotencyKey: string(payload.idempotencyKey),
    });
    return { run, dispatch: await dispatch.dispatchReady(companyId, engine, run.id, config) };
  }
  const runId = string(payload.runId);
  if (!runId) throw new Error('runId is required');
  const nodeId = string(payload.nodeId);
  let dispatchRun;
  if (operation !== 'dispatch') await assertRunIssue(engine, companyId, issueId, runId, actor, nodeId,
    operation, string(payload.idempotencyKey));
  else {
    dispatchRun = await engine.getRun(runId);
    if (!dispatchRun || dispatchRun.input.paperclipIssueId !== issueId || actor.kind !== 'human' ||
      !actor.roles.includes('human-owner')) throw new Error('Dispatch must use the root issue and a human owner');
  }
  const common = { runId, nodeId, actor, idempotencyKey: string(payload.idempotencyKey) };
  let result;
  if (operation === 'submit') result = await engine.submitNode({
    ...common, output: object(payload.output), artifacts: list(payload.artifacts), evidence: list(payload.evidence),
    decisionIds: list(payload.decisionIds),
    productDecisionRefs: payload.productDecisionRefs === undefined ? undefined : list(payload.productDecisionRefs),
    approvedChangeDecisionId: payload.approvedChangeDecisionId,
    changeScope: payload.changeScope,
  });
  else if (operation === 'record-work-decision') result = await engine.recordWorkDecision({
    ...common, category: payload.category, question: payload.question,
    options: list(payload.options), outcome: payload.outcome, reason: payload.reason,
    evidence: list(payload.evidence), ruleRef: payload.ruleRef,
    productDecisionRefs: payload.productDecisionRefs === undefined ? undefined : list(payload.productDecisionRefs),
    behaviorImpact: payload.behaviorImpact, changeScope: payload.changeScope,
  });
  else if (operation === 'self-review') result = await engine.recordSelfReview({
    ...common, artifactVersion: payload.artifactVersion, findings: list(payload.findings),
    fixes: list(payload.fixes), evidence: list(payload.evidence), revisedArtifact: payload.revisedArtifact ?? null,
  });
  else if (operation === 'review') result = await engine.reviewWork({
    ...common, outcome: payload.outcome, reason: payload.reason,
    evidence: list(payload.evidence), knownRisks: list(payload.knownRisks),
  });
  else if (operation === 'decide') result = await engine.decideNode({
    ...common, outcome: payload.outcome, reason: payload.reason,
    evidence: list(payload.evidence), artifacts: list(payload.artifacts), options: list(payload.options),
  });
  else if (operation === 'escalate') result = await engine.escalateNode({
    ...common, reason: payload.reason, evidence: list(payload.evidence), options: list(payload.options),
  });
  else if (operation === 'resolve-human-gate') result = await engine.resolveHumanGate({
    ...common, outcome: payload.outcome, reason: payload.reason, evidence: list(payload.evidence),
    artifacts: list(payload.artifacts), options: list(payload.options),
  });
  else if (operation === 'pause') result = await engine.pauseRun({ runId, actor, reason: payload.reason, idempotencyKey: common.idempotencyKey });
  else if (operation === 'resume') result = await engine.resumeRun({ runId, actor, reason: payload.reason, idempotencyKey: common.idempotencyKey });
  else if (operation === 'open-conflict') result = await engine.openConflict({
    ...common, positions: payload.positions, options: list(payload.options),
    positionDecisionIds: payload.positionDecisionIds, negotiation: list(payload.negotiation),
    unresolved: list(payload.unresolved), reason: payload.reason,
  });
  else if (operation === 'record-conflict-position') result = await engine.recordConflictPosition({
    ...common, side: payload.side, stance: payload.stance, reason: payload.reason,
    dimensions: payload.dimensions, nonNegotiables: list(payload.nonNegotiables), evidence: list(payload.evidence),
  });
  else if (operation === 'resolve-conflict') result = await engine.resolveConflict({
    runId, conflictId: payload.conflictId, actor, outcome: payload.outcome,
    reason: payload.reason, evidence: list(payload.evidence), idempotencyKey: common.idempotencyKey,
  });
  else if (operation === 'resolve-rework-limit') result = await engine.resolveReworkLimit({
    runId, actor, outcome: payload.outcome, reason: payload.reason, idempotencyKey: common.idempotencyKey,
  });
  else if (operation === 'retry-node') {
    if (actor.kind !== 'human' || !actor.roles.includes('human-owner')) throw new Error('A company owner or authorized human owner must retry a node');
    result = await engine.retryNode({ ...common, reason: payload.reason });
  }
  else if (operation === 'invalidate-evidence') result = await engine.invalidateEvidence({
    ...common, reason: payload.reason, affectedNodeIds: payload.affectedNodeIds,
  });
  else if (operation === 'record-intervention') result = await recordIntervention(engine, {
    ...common, kind: payload.kind, reason: payload.reason, evidence: list(payload.evidence),
    outcomeSignal: payload.outcomeSignal,
  });
  else if (operation === 'propose-improvement') result = await proposeInterventionImprovement(engine, {
    ...common, interventionIds: list(payload.interventionIds), mechanism: payload.mechanism,
    expectedOutcome: payload.expectedOutcome, evidence: list(payload.evidence),
  });
  else if (operation === 'update-improvement') result = await updateInterventionImprovement(engine, {
    ...common, previousDecisionId: payload.previousDecisionId, status: payload.status,
    reason: payload.reason, evidence: list(payload.evidence), outcomeSignal: payload.outcomeSignal,
  });
  else if (operation === 'product-decision') result = await engine.recordProductDecision({
    feature: payload.feature, actor, status: payload.status,
    outcome: payload.outcome, reason: payload.reason, evidence: list(payload.evidence),
    supersedes: payload.supersedes, runId, changeScope: list(payload.changeScope),
    proposalId: payload.proposalId,
    idempotencyKey: common.idempotencyKey,
  });
  else if (operation === 'dispatch') {
    const reason = string(payload.reason);
    if (!reason) throw new Error('Dispatch recovery reason is required');
    const decision = await appendDispatchRequest(host.db, { companyId, runId, issueId, actor, reason,
      feature: string(dispatchRun.input.feature), packId: dispatchRun.packId, packVersion: dispatchRun.packVersion,
      graphId: dispatchRun.graph.id, graphVersion: dispatchRun.graph.version,
      idempotencyKey: common.idempotencyKey });
    result = { requested: true, decisionId: decision.id };
  }
  else throw new Error(`Unknown Graph operation: ${operation}`);
  const actions = operation === 'dispatch' ? await dispatchOwnerOnce(companyId, engine, runId, config)
    : await dispatch.dispatchReady(companyId, engine, runId, config);
  const updatedRun = await engine.getRun(runId);
  const agentDispatch = actor.kind === 'agent' ? await getDispatchForRunIssue(host.db, companyId, issueId, runId) : null;
  const scopedRun = agentDispatch && isIndependentReview(updatedRun, nodeId, agentDispatch.phase)
    ? projectReviewRun(updatedRun, nodeId, agentDispatch.phase) : updatedRun;
  return { result, run: scopedRun, dispatch: actions };
}

async function dashboard(companyId, issueId = null, runId = null, hostActor = null) {
  if (issueId && hostActor?.actorType === 'agent') {
    if (!hostActor.agentId || !hostActor.runId) throw new Error('Active Paperclip agent run required for Graph read');
    await host.issues.assertCheckoutOwner({ issueId, companyId,
      actorAgentId: hostActor.agentId, actorRunId: hostActor.runId });
  }
  if (issueId && hostActor?.actorType === 'user' && !await humanMembership(companyId, hostActor.userId)) {
    throw new Error('User has no company membership');
  }
  const { engine, store, pack, control } = await engineFor(companyId);
  const state = await store.read();
  const config = await getGraphConfig(host.db, companyId);
  const viewer = hostActor ? (await trustedActor(companyId, hostActor, config)).actor : null;
  let issueDispatch = null;
  if (issueId && runId) issueDispatch = await getDispatchForRunIssue(host.db, companyId, issueId, runId);
  const runs = Object.values(state?.runs ?? {})
    .filter((run) => !issueId || run.input.paperclipIssueId === issueId || (issueDispatch && run.id === runId))
    .map((run) => ({ id: run.id, graphId: run.graph.id, graphVersion: run.graph.version,
      packVersion: run.packVersion, status: run.status, mode: run.mode,
      issueId: run.input.paperclipIssueId, startedAt: run.startedAt, updatedAt: run.updatedAt }));
  let run = runId ? await engine.getRun(runId) : null;
  const selectedPack = run ? run.pack : pack;
  let nativeDecisions = [], nativeDecisionError = null;
  if (run && hostActor?.actorType === 'user') {
    try {
      nativeDecisions = await syncGraphDecision({ host, companyId, run, engine, control, config,
        trustedActor, dispatchReady: (...args) => dispatch.dispatchReady(...args) });
    } catch (error) {
      nativeDecisionError = errorMessage(error);
      host.logger.warn('Native Graph Decision unavailable', { companyId, runId, error: nativeDecisionError });
    }
  }
  if (nativeDecisions.length) run = await engine.getRun(runId);
  if (run && issueId && run.input.paperclipIssueId !== issueId) {
    if (!issueDispatch) throw new Error('Run is not attached to this issue');
    if (hostActor?.actorType === 'agent' && issueDispatch.agent_id !== hostActor.agentId) {
      throw new Error('Agent is not bound to this Graph child issue');
    }
    if (!['agent', 'user'].includes(hostActor?.actorType)) throw new Error('Authenticated actor required for child Graph read');
  }
  const dispatches = run ? await dispatch.currentDispatches(companyId, run) : [];
  const dispatchRequests = await listDispatchRequests(host.db, companyId, runId);
  const reviewScope = hostActor?.actorType === 'agent' && issueDispatch && run &&
    isIndependentReview(run, issueDispatch.node_id, issueDispatch.phase);
  const workItems = run && !reviewScope ? await engine.getWorkItems(runId) : [];
  const runDecisions = run && !reviewScope ? await engine.listDecisions({ runId }) : [];
  const mergeDecisions = (primary, additional) => [...new Map([...primary, ...additional].map((item) => [item.id, item])).values()]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return {
    pack: { id: selectedPack.id, version: selectedPack.version, graphs: selectedPack.graphs.map((g) => ({ id: g.id, version: g.version,
      title: g.title ?? g.name ?? g.id, nodes: g.nodes, edges: g.edges })) },
    catalog: packRegistry.catalog().map((item) => ({ id: item.id, version: item.version,
      dashboard: item.dashboard ?? null, graphs: item.graphs.map((g) => ({ id: g.id, version: g.version,
        title: g.title ?? g.name ?? g.id, nodes: g.nodes, edges: g.edges })) })),
    enabledPacks: (await control.getSetup()).enabledPacks,
    viewer,
    nativeDecisions,
    nativeDecisionError,
    runs: reviewScope ? runs.filter(item => item.id === runId) : runs,
    run: reviewScope ? projectReviewRun(run, issueDispatch.node_id, issueDispatch.phase) : run,
    handoff: run && !reviewScope ? handoffSnapshot(run, { decisions: runDecisions, workItems }) : undefined,
    dispatches: reviewScope ? dispatches.filter(item => item.nodeId === issueDispatch.node_id && item.phase === issueDispatch.phase) : dispatches,
    humanResolutions: run ? run.conflicts.filter((item) => item.status === 'resolved' && item.resolutionDecisionId)
      .map((item) => ({ conflictId: item.id, decisionId: item.resolutionDecisionId, nodeId: item.nodeId,
        outcome: item.outcome, disposition: item.disposition ?? null, effect: item.effect ?? null })) : [],
    ready: run && !reviewScope ? await engine.getReadyNodes(runId) : [],
    work: workItems,
    blocked: run && !reviewScope ? await engine.getBlockedNodes(runId) : [],
    decisions: run && !reviewScope ? mergeDecisions(runDecisions, dispatchRequests) : [],
    interventions: run && !reviewScope ? await interventionReport(engine, runId) : undefined,
    // The host's plugin data bridge checks company membership before invoking this
    // handler. Route reads carry actorType and withhold company history from agents.
    companyDecisions: hostActor?.actorType === 'agent' ? undefined :
      mergeDecisions((await engine.listDecisions()).filter((item) => item.runId == null),
        runId ? await listDispatchRequests(host.db, companyId) : dispatchRequests),
    audit: run && !reviewScope ? await engine.getAudit({ runId }) : [],
    productMemory: run?.input?.feature ? await engine.getProductMemory(run.input.feature) : null,
    config: hostActor?.actorType === 'agent' ? undefined : config,
  };
}


const plugin = definePlugin({
  multiCompanyConfig: true,
  async onConfigChanged(_config, context) {
    if (!context?.companyId) throw new Error('Company-scoped plugin config context required');
    // Runtime handlers read host config and plugin state by company on each call.
  },
  async setup(ctx) {
    host = ctx;
    packRegistry = createPackRegistry({ prepareCompany }); ownerDispatches.clear();
    shadowRuntime = createShadowRuntime({ host: ctx, engineFor, getConfig: getGraphConfig });
    dispatch = createDispatch(ctx, engineFor, getGraphConfig, undefined, shadowRuntime);
    companyApi = createCompanyApi({ host: ctx, catalog: () => packRegistry.catalog(), engineFor,
      getConfig: getGraphConfig, setConfig: setGraphConfig, trustedActor,
      dispatchReady: (...args) => dispatch.dispatchReady(...args),
      capabilitiesFor: async (companyId) => (await companyCapabilities(companyId)).capabilities,
      getEvidenceProviders, setEvidenceProviders, shadowRuntime });
    channelBridge = createChannelBridge({ host: ctx, engineFor, trustedActor,
      externalDeliveryEnabled: false });
    try { await packRegistry.installed(); } catch (error) {
      ctx.logger.warn('Pack catalog unavailable', { error: errorMessage(error) });
    }
    ctx.actions.register('graph-command', async (params, invocation) => {
      const companyId = invocation.companyId;
      if (!companyId) throw new Error('Authenticated company context required');
      const issueId = string(params.issueId);
      if (!issueId) throw new Error('Paperclip issueId is required');
      return command({ companyId, issueId, body: params, hostActor: {
        actorType: invocation.actor.type, userId: invocation.actor.userId,
        agentId: invocation.actor.agentId, runId: invocation.actor.runId,
      } });
    });
    ctx.actions.register('graph-company-command', async (params, invocation) => {
      if (!invocation.companyId || params.companyId !== invocation.companyId) throw new Error('Authenticated company context required');
      return companyApi.command({ companyId: invocation.companyId, body: params, hostActor: {
        actorType: invocation.actor.type, userId: invocation.actor.userId,
        agentId: invocation.actor.agentId, runId: invocation.actor.runId,
      } });
    });
    ctx.tools.register('graph-command', ctx.manifest.tools.find((tool) => tool.name === 'graph-command'), async (params, runCtx) => {
      try {
        const value = object(params);
        const result = await command({ companyId: runCtx.companyId, issueId: string(value.issueId), body: value,
          hostActor: { actorType: 'agent', agentId: runCtx.agentId, runId: runCtx.runId } });
        return { content: JSON.stringify(result), data: result };
      } catch (error) { return { error: errorMessage(error) }; }
    });
    ctx.tools.register('company-command', ctx.manifest.tools.find((tool) => tool.name === 'company-command'), async (params, runCtx) => {
      try {
        const result = await companyApi.command({ companyId: runCtx.companyId, body: params,
          hostActor: { actorType: 'agent', agentId: runCtx.agentId, runId: runCtx.runId } });
        return { content: JSON.stringify(result), data: result };
      } catch (error) { return { error: errorMessage(error) }; }
    });
    ctx.events.on('issue.comment.created', async (event) => {
      await channelBridge.handleEvent(event);
    });
    ctx.jobs.register('channel-delivery', async () => { await channelBridge.deliverPending(); });
    ctx.jobs.register('outcome-reminders', async () => { await channelBridge.outcomeReminders(); });
    ctx.jobs.register('strategy-review', async () => { await channelBridge.strategyReview(); });
    ctx.jobs.register('shadow-reconcile', async () => {
      for (const companyId of await listGraphCompanies(ctx.db)) {
        try {
          await shadowRuntime.reconcile({ companyId });
          const { engine, store } = await engineFor(companyId);
          const state = await store.read();
          const config = await getGraphConfig(ctx.db, companyId);
          for (const run of Object.values(state?.runs ?? {})) {
            if (run.status === 'running' && run.graph?.nodes?.some(node => node.shadow)) {
              await dispatch.dispatchReady(companyId, engine, run.id, config);
            }
          }
        } catch (error) {
          ctx.logger.warn('Company Shadow recovery requires attention', { companyId, error: errorMessage(error) });
        }
      }
    });
    // Recovery is explicit through an authorized Graph command. Setup timers
    // inherit an expired invocation scope and can strand a wake claim.
  },
  async onWebhook(input) {
    await channelBridge.handleWebhook(input);
  },
  async onApiRequest(input) {
    try {
      if (input.routeKey === 'company-graph-read') {
        if (input.actor?.actorType !== 'user' || !await humanMembership(input.companyId, input.actor.userId)) {
          throw new Error('Company Graph read requires a company member');
        }
        return { body: await dashboard(input.companyId, string(input.query?.issueId),
          string(input.query?.runId), input.actor) };
      }
      if (input.routeKey === 'graph-read') return { body: await dashboard(input.companyId, input.params.issueId,
        string(input.query.runId), input.actor) };
      if (input.routeKey === 'graph-command') return { body: await command({
        companyId: input.companyId, issueId: input.params.issueId, body: input.body,
        hostActor: input.actor,
      }) };
      if (input.routeKey === 'company-read') return { body: await companyApi.read({
        companyId: input.companyId, hostActor: input.actor,
      }) };
      if (input.routeKey === 'company-command') {
        if (input.body?.companyId !== input.companyId) throw new Error('Authenticated company context mismatch');
        return { body: await companyApi.command({
        companyId: input.companyId, body: input.body, hostActor: input.actor,
        }) };
      }
      if (input.routeKey === 'channel-read') return { body: await channelBridge.readConfig({
        companyId: input.companyId, hostActor: input.actor,
      }) };
      if (input.routeKey === 'channel-deliveries') return { body: await channelBridge.readDeliveries({
        companyId: input.companyId, hostActor: input.actor,
      }) };
      if (input.routeKey === 'channel-configure') {
        if (input.body?.companyId !== input.companyId) throw new Error('Authenticated company context mismatch');
        return { body: await channelBridge.configure({ companyId: input.companyId,
          hostActor: input.actor, settings: input.body.settings,
          reason: input.body.reason, idempotencyKey: input.body.idempotencyKey }) };
      }
      return { status: 404, body: { error: 'Unknown Graph route' } };
    } catch (error) {
      const message = errorMessage(error);
      host?.logger?.warn('Graph route rejected', { routeKey: input.routeKey, message });
      return { status: /actor|admin|member|bound|checkout|role|human|identity/i.test(message) ? 403 : 400, body: { error: message } };
    }
  },
  async onHealth() {
    return packRegistry?.health() ?? { status: 'degraded', message: 'Pack registry has not started' };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
