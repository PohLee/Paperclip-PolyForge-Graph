import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { GraphEngine } from '../core/index.mjs';
import { reportingPlan, resumableReportingPlan } from './reporting.mjs';
import { createDispatch } from './dispatch.mjs';
import {
  PaperclipStore, getGraphConfig, setGraphConfig, getDispatchForRunIssue,
} from './store.mjs';

let host;
let dispatch;
let loadedPack;
let packError;
const registered = new Set();

const string = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const errorMessage = (error) => error instanceof Error ? error.message : String(error);
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');

async function managedReporting(companyId, pack) {
  const managed = {};
  for (const roleId of Object.keys(pack.roles)) {
    const resolution = await host.agents.managed.get(roleId, companyId);
    if (resolution.pluginKey !== host.manifest.id || resolution.resourceKind !== 'agent' ||
        resolution.resourceKey !== roleId || !resolution.agentId) throw new Error(`ADLC agent ${roleId} is not owned by this plugin`);
    const agent = await host.agents.get(resolution.agentId, companyId);
    managed[roleId] = { ...resolution, agent };
  }
  return { managed, plan: reportingPlan(pack.roles, managed, companyId) };
}

async function loadPack(force = false) {
  if (loadedPack && !force) return loadedPack;
  const distDir = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [string(process.env.POLYFORGE_ADLC_PACK_ENTRY),
    resolve(distDir, '../../adlc-pack/index.mjs'),
    resolve(distDir, '../../Paperclip-PolyForge-Graph-ADLC/index.mjs')].filter(Boolean);
  let entry;
  for (const candidate of candidates) {
    try { await access(candidate); entry = candidate; break; }
    catch { /* continue to the next configured Pack mount */ }
  }
  if (!entry) throw new Error('ADLC Pack index.mjs missing: configure POLYFORGE_ADLC_PACK_ENTRY or mount a sibling Pack');
  const moduleUrl = pathToFileURL(resolve(entry)).href + (force ? `?reload=${Date.now()}` : '');
  const pack = (await import(moduleUrl)).pack;
  if (!pack?.id || !pack?.version || !Array.isArray(pack.graphs)) throw new Error('Invalid ADLC Pack entry');
  loadedPack = pack;
  packError = null;
  return pack;
}

async function engineFor(companyId) {
  const store = new PaperclipStore(host.db, companyId);
  const engine = new GraphEngine({ store });
  const pack = await loadPack();
  const registrationKey = `${companyId}:${pack.id}@${pack.version}`;
  if (!registered.has(registrationKey)) {
    const state = await store.read();
    const published = state?.packs?.[`${pack.id}@${pack.version}`];
    if (published && canonical(published) !== canonical(pack)) {
      throw new Error(`Published ADLC Pack ${pack.id}@${pack.version} changed without a version bump`);
    }
    if (!published) await engine.registerPack(pack);
    registered.add(registrationKey);
  }
  return { engine, store, pack };
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
    const pack = await loadPack();
    for (const [role, agentId] of Object.entries(roleBindings)) {
      if (!pack.roles?.[role] || typeof agentId !== 'string' || !await host.agents.get(agentId, companyId)) {
        throw new Error(`Invalid agent binding for role ${role}`);
      }
    }
    const members = await host.access.members.list({ companyId });
    for (const [userId, roles] of Object.entries(userRoles)) {
      if (!members.some((m) => m.principalType === 'user' && m.principalId === userId && m.status === 'active')) throw new Error(`Inactive or unknown human user: ${userId}`);
      if (!Array.isArray(roles) || roles.some((role) => role !== 'human-owner' && !pack.roles?.[role])) throw new Error(`Invalid human role binding for ${userId}`);
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
    const pack = await loadPack();
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
    const pack = await loadPack();
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
    const pack = await loadPack();
    if (host.manifest.agents?.length !== Object.keys(pack.roles).length ||
        host.manifest.skills?.length !== Object.keys(pack.skills ?? {}).length) {
      throw new Error('Installed manifest lacks ADLC managed resources; reinstall the plugin with its Pack mounted');
    }
    const { engine } = await engineFor(companyId);
    await engine.recordDecision({ type: 'adlc_provisioning', status: 'approved', outcome: 'requested',
      reason: string(payload.reason) ?? 'Company owner requested ADLC Pack provisioning', actor,
      evidence: [{ kind: 'pack', id: pack.id, version: pack.version,
        roles: Object.keys(pack.roles), skills: Object.keys(pack.skills ?? {}),
        priorRoleBindings: config.roleBindings }], issueId,
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:intent` });
    const skills = [];
    for (const skillId of Object.keys(pack.skills ?? {})) skills.push(await host.skills.managed.reconcile(skillId, companyId));
    const agents = [];
    const roleBindings = { ...config.roleBindings };
    for (const roleId of Object.keys(pack.roles ?? {})) {
      const resolution = await host.agents.managed.reconcile(roleId, companyId);
      agents.push(resolution);
      if (resolution.agentId && !roleBindings[roleId]) roleBindings[roleId] = resolution.agentId;
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
      evidence: [{ kind: 'pack', id: loadedPack?.id, version: loadedPack?.version,
        roleIds: Object.keys(loadedPack?.roles ?? {}), skillIds: Object.keys(loadedPack?.skills ?? {}) }],
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:intent` });
    const previous = loadedPack;
    const pack = await loadPack(true);
    registered.delete(`${companyId}:${pack.id}@${pack.version}`);
    try { await engine.registerPack(pack); }
    catch (error) { loadedPack = previous; throw error; }
    await engine.recordDecision({ type: 'pack_reload', status: 'applied', outcome: `${pack.id}@${pack.version}`,
      reason: string(payload.reason) ?? 'Company owner loaded a new Pack version', actor,
      evidence: [{ kind: 'pack', id: pack.id, version: pack.version,
        roleIds: Object.keys(pack.roles), skillIds: Object.keys(pack.skills ?? {}),
        documentDigests: Object.fromEntries(Object.entries(pack.roles).map(([id, role]) => [id, role.documentDigests ?? {}])) }],
      idempotencyKey: string(payload.idempotencyKey) && `${payload.idempotencyKey}:result` });
    return { pack: { id: pack.id, version: pack.version }, ready: Boolean(engine) };
  }
  const { engine, pack } = await engineFor(companyId);
  if (operation === 'product-decision' && !string(payload.runId)) {
    if (!isAdministrator || actor.kind !== 'human') throw new Error('A company owner or admin must record a standalone product decision');
    const feature = string(payload.feature);
    if (!feature) throw new Error('feature is required for a product decision');
    const result = await engine.recordProductDecision({
      feature, actor, status: payload.status, outcome: payload.outcome, reason: payload.reason,
      evidence: list(payload.evidence), supersedes: payload.supersedes,
      changeScope: list(payload.changeScope), idempotencyKey: string(payload.idempotencyKey),
    });
    return { result, productMemory: await engine.getProductMemory(feature) };
  }
  if (operation === 'start') {
    const graphId = string(payload.graphId);
    const mode = string(payload.mode) ?? config.defaultMode;
    if (!['manual', 'assisted', 'autonomous'].includes(mode)) throw new Error('Unknown decision mode');
    if (!list(pack.graphStartRoles?.[graphId]).some((role) => actor.roles.includes(role))) throw new Error('Actor role cannot start this Graph');
    if (actor.kind === 'agent') await host.issues.assertCheckoutOwner({
      issueId, companyId, actorAgentId: actor.id, actorRunId: actor.executionId,
    });
    const run = await engine.startRun({
      packId: pack.id, packVersion: pack.version, graphId, mode,
      input: { ...object(payload.input), paperclipIssueId: issueId, paperclipCompanyId: companyId },
      actor, idempotencyKey: string(payload.idempotencyKey),
    });
    return { run, dispatch: await dispatch.dispatchReady(companyId, engine, run.id, config) };
  }
  const runId = string(payload.runId);
  if (!runId) throw new Error('runId is required');
  const nodeId = string(payload.nodeId);
  if (operation !== 'dispatch') await assertRunIssue(engine, companyId, issueId, runId, actor, nodeId,
    operation, string(payload.idempotencyKey));
  else {
    const run = await engine.getRun(runId);
    if (!run || run.input.paperclipIssueId !== issueId || actor.kind !== 'human') throw new Error('Dispatch must use the root issue and a human actor');
  }
  const common = { runId, nodeId, actor, idempotencyKey: string(payload.idempotencyKey) };
  let result;
  if (operation === 'submit') result = await engine.submitNode({
    ...common, output: object(payload.output), artifacts: list(payload.artifacts), evidence: list(payload.evidence),
    productDecisionRefs: payload.productDecisionRefs === undefined ? undefined : list(payload.productDecisionRefs),
    approvedChangeDecisionId: payload.approvedChangeDecisionId,
    changeScope: payload.changeScope,
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
    unresolved: list(payload.unresolved), reason: payload.reason,
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
  else if (operation === 'product-decision') result = await engine.recordProductDecision({
    feature: payload.feature, actor, status: payload.status,
    outcome: payload.outcome, reason: payload.reason, evidence: list(payload.evidence),
    supersedes: payload.supersedes, runId, changeScope: list(payload.changeScope),
    idempotencyKey: common.idempotencyKey,
  });
  else if (operation === 'dispatch') result = { retried: true };
  else throw new Error(`Unknown Graph operation: ${operation}`);
  return { result, run: await engine.getRun(runId), dispatch: await dispatch.dispatchReady(companyId, engine, runId, config) };
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
  const { engine, store, pack } = await engineFor(companyId);
  const state = await store.read();
  let issueDispatch = null;
  if (issueId && runId) issueDispatch = await getDispatchForRunIssue(host.db, companyId, issueId, runId);
  const runs = Object.values(state?.runs ?? {})
    .filter((run) => !issueId || run.input.paperclipIssueId === issueId || (issueDispatch && run.id === runId))
    .map((run) => ({ id: run.id, graphId: run.graph.id, graphVersion: run.graph.version,
      packVersion: run.packVersion, status: run.status, mode: run.mode,
      issueId: run.input.paperclipIssueId, startedAt: run.startedAt, updatedAt: run.updatedAt }));
  const run = runId ? await engine.getRun(runId) : null;
  if (run && issueId && run.input.paperclipIssueId !== issueId) {
    if (!issueDispatch) throw new Error('Run is not attached to this issue');
    if (hostActor?.actorType === 'agent' && issueDispatch.agent_id !== hostActor.agentId) {
      throw new Error('Agent is not bound to this Graph child issue');
    }
    if (!['agent', 'user'].includes(hostActor?.actorType)) throw new Error('Authenticated actor required for child Graph read');
  }
  const dispatches = run ? await dispatch.currentDispatches(companyId, run) : [];
  return {
    pack: { id: pack.id, version: pack.version, graphs: pack.graphs.map((g) => ({ id: g.id, version: g.version })) },
    runs, run, dispatches,
    ready: run ? await engine.getReadyNodes(runId) : [],
    work: run ? await engine.getWorkItems(runId) : [],
    blocked: run ? await engine.getBlockedNodes(runId) : [],
    decisions: run ? await engine.listDecisions({ runId }) : [],
    audit: run ? await engine.getAudit({ runId }) : [],
    config: hostActor?.actorType === 'agent' ? undefined : await getGraphConfig(host.db, companyId),
  };
}


const plugin = definePlugin({
  async setup(ctx) {
    host = ctx;
    dispatch = createDispatch(ctx, engineFor, getGraphConfig);
    try { await loadPack(); } catch (error) { packError = errorMessage(error); ctx.logger.warn('ADLC Pack unavailable', { error: packError }); }
    ctx.data.register('graph-dashboard', async (params) => {
      const companyId = string(params.companyId);
      if (!companyId) throw new Error('companyId is required');
      return dashboard(companyId, string(params.issueId), string(params.runId));
    });
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
    ctx.tools.register('graph-command', ctx.manifest.tools.find((tool) => tool.name === 'graph-command'), async (params, runCtx) => {
      try {
        const value = object(params);
        const result = await command({ companyId: runCtx.companyId, issueId: string(value.issueId), body: value,
          hostActor: { actorType: 'agent', agentId: runCtx.agentId, runId: runCtx.runId } });
        return { content: JSON.stringify(result), data: result };
      } catch (error) { return { error: errorMessage(error) }; }
    });
    const recover = () => { void dispatch.recoverDispatches().catch((error) =>
      ctx.logger.warn('Graph dispatch recovery sweep failed', { error: errorMessage(error) })); };
    setTimeout(recover, 5000).unref();
    setInterval(recover, 60000).unref();
  },
  async onApiRequest(input) {
    try {
      if (input.routeKey === 'graph-read') return { body: await dashboard(input.companyId, input.params.issueId,
        string(input.query.runId), input.actor) };
      if (input.routeKey === 'graph-command') return { body: await command({
        companyId: input.companyId, issueId: input.params.issueId, body: input.body,
        hostActor: input.actor,
      }) };
      return { status: 404, body: { error: 'Unknown Graph route' } };
    } catch (error) {
      const message = errorMessage(error);
      host?.logger?.warn('Graph route rejected', { routeKey: input.routeKey, message });
      return { status: /actor|admin|member|bound|checkout|role|human|identity/i.test(message) ? 403 : 400, body: { error: message } };
    }
  },
  async onHealth() {
    return packError ? { status: 'degraded', message: packError } :
      { status: 'ok', message: 'PolyForge Graph worker ready', details: { pack: `${loadedPack.id}@${loadedPack.version}` } };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
