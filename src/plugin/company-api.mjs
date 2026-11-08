import { preflightPackChange, CORE_RUNTIME } from '../core/index.mjs';
import { selectPack, resourceKey } from './catalog.mjs';
import { reportingPlan } from './reporting.mjs';
import { verifyEvidenceReceipt, canonicalEvidence } from '../host/evidence-provider.mjs';
import { syncGraphDecision } from './native-decisions.mjs';
import { syncProductDecisionCards } from './product-decisions.mjs';
import { createDecisionHandoff } from './decision-handoff.mjs';
import { assessCompanyReadiness } from './readiness.mjs';
import { getChannelConfig, listNotificationDeliveries } from './store.mjs';
import { createShadowRuntime } from './shadow-runtime.mjs';
import { createShadowLaunchStore } from './shadow-launch-store.mjs';
import { temporaryAgentFingerprint } from './temporary-agent-launch-store.mjs';
import { nativeIntakeAssignee, wakeCeoIssue } from './ceo-dispatch.mjs';
import { configureEvidenceProviders, providerConfiguration } from './evidence-config.mjs';
import { applyGraphConfigChange } from './graph-config-change.mjs';
import { settingsRoles, mappingSuggestions, validateSettings } from './settings.mjs';
import { DELIVERY_LIMITS, DELIVERY_LIMIT_HARD_MAX } from '../core/delivery-limits.mjs';
import semver from 'semver';

const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const goalMarker = (id) => `PolyForge goal: ${id}`;
const uuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? '');
function versionMatches(version, range = {}) {
  return Boolean(semver.valid(version) &&
    (!range.minVersion || (semver.valid(range.minVersion) && semver.gte(version, range.minVersion))) &&
    (!range.maxExclusiveVersion || (semver.valid(range.maxExclusiveVersion) && semver.lt(version, range.maxExclusiveVersion))));
}

export function createCompanyApi({ host, catalog, engineFor, packHostAdapters, getConfig, setConfig, compareAndSetConfig,
  patchRoleBindings, trustedActor, dispatchReady,
  capabilitiesFor, getEvidenceProviders, setEvidenceProviders, shadowRuntime: suppliedShadowRuntime, temporaryAgentRuntime,
  packRegistry, githubPacks }) {
  const shadowRuntime = suppliedShadowRuntime ?? createShadowRuntime({ host, engineFor, getConfig });
  async function identity(companyId, hostActor) {
    const config = await getConfig(host.db, companyId);
    const resolved = await trustedActor(companyId, hostActor, config);
    return { ...resolved, config };
  }
  async function settings({ companyId, hostActor }) {
    const { actor, isAdministrator, config } = await identity(companyId, hostActor);
    if (actor.kind !== 'human') throw new Error('Company settings require a human member');
    await engineFor(companyId);
    const roles = settingsRoles(catalog(), config);
    const agents = (await host.agents.list({ companyId, limit: 500 })).map(({ id, name, status, role }) => ({ id, name, status, role }));
    const memberships = (await host.access.members.list({ companyId })).filter(m => m.principalType === 'user');
    const members = memberships.filter(m => m.status === 'active' || Object.hasOwn(config.userRoles, m.principalId))
      .map(m => ({ id: m.principalId, name: m.user?.name ?? m.name ?? m.user?.email ?? m.principalId,
        membershipRole: m.membershipRole, status: m.status }));
    for (const id of Object.keys(config.userRoles)) {
      if (!members.some(member => member.id === id)) members.push({ id, name: id, status: 'removed' });
    }
    return { companyId, config, roles, agents, members: members.filter(member => member.status === 'active'),
      unavailableMembers: members.filter(member => member.status !== 'active'), canEdit: isAdministrator, viewerId: actor.id,
      suggestions: isAdministrator ? await mappingSuggestions({ host, companyId, roles, agents, bindings: config.roleBindings }) : {},
      deliveryDefaults: DELIVERY_LIMITS, deliveryLimitHardMax: DELIVERY_LIMIT_HARD_MAX, runtime: CORE_RUNTIME,
      catalog: catalog().map(({ id, version, name, description }) => ({ id, version, name, description })),
      sources: githubPacks ? await githubPacks.sources(companyId) : [] };
  }
  async function project(companyId, projectId) {
    const result = await host.projects.get(required(projectId, 'projectId'), companyId);
    if (!result) throw new Error('Paperclip project not found in company');
    return result;
  }
  async function agent(companyId, agentId) {
    const result = await host.agents.get(required(agentId, 'agentId'), companyId);
    if (!result) throw new Error('Paperclip agent not found in company');
    return result;
  }
  const planReconciler = () => ({ id: host.manifest.id, kind: 'system', roles: ['work-plan-reconciler'] });
  async function syncNativeGoals(companyId, revision) {
    const goals = list(revision.goals);
    const native = await host.goals.list({ companyId, limit: 500 });
    const linked = new Map();
    for (const item of native) {
      const match = /^PolyForge goal: ([^\n]+)/m.exec(item.description ?? '');
      if (match) {
        if (linked.has(match[1])) throw new Error(`Duplicate native goals for ${match[1]}; operator repair required`);
        linked.set(match[1], item);
      }
    }
    const remaining = new Map(goals.map((goal) => [goal.id, goal]));
    for (let pass = 0; pass < goals.length && remaining.size; pass++) {
      for (const [id, goal] of [...remaining]) {
        if (goal.parentGoalId && remaining.has(goal.parentGoalId)) continue;
        const parentId = goal.parentGoalId ? linked.get(goal.parentGoalId)?.id ??
          (uuid(goal.parentGoalId) ? (await host.goals.get(goal.parentGoalId, companyId))?.id : undefined) : undefined;
        if (goal.parentGoalId && !parentId) throw new Error(`Native parent goal ${goal.parentGoalId} not found`);
        const description = [goalMarker(id), `PolyForge revision: ${revision.id}`,
          ...goal.keyResults.map((kr) => `- ${kr.id}: target ${kr.target} ${kr.unit}; baseline ${kr.baseline ?? 'unknown'}; source ${kr.source}; window ${kr.window}`)].join('\n');
        const existing = linked.get(id) ?? (uuid(id) ? await host.goals.get(id, companyId) : null);
        const desired = { title: goal.title, description, level: revision.scope,
          status: 'active', parentId: parentId ?? null,
          ownerAgentId: revision.scope === 'agent' ? revision.subjectId : null };
        const record = existing ?
          (Object.entries(desired).every(([key, value]) => (existing[key] ?? null) === value)
            ? existing : await host.goals.update(existing.id, desired, companyId))
          : await host.goals.create({ companyId, ...desired });
        linked.set(id, record); remaining.delete(id);
      }
    }
    if (revision.supersedes) {
      const state = await (await engineFor(companyId)).store.read();
      const previous = list(state?.control?.goalHistory).find((item) => item.id === revision.supersedes);
      const currentIds = new Set(goals.map((goal) => goal.id));
      for (const retired of list(previous?.goals).filter((goal) => !currentIds.has(goal.id))) {
        const record = linked.get(retired.id);
        if (record && record.status !== 'cancelled') await host.goals.update(record.id, {
          status: 'cancelled', description: `${record.description ?? goalMarker(retired.id)}\nPolyForge superseded by revision: ${revision.id}`,
        }, companyId);
      }
    }
    return goals.map((goal) => ({ coreGoalId: goal.id, paperclipGoalId: linked.get(goal.id)?.id }));
  }
  async function reporting(companyId, setup) {
    const ceoId = required(setup.organization?.ceo?.id, 'organization.ceo.id');
    const ceo = await agent(companyId, ceoId);
    const assignments = [{ roleId: 'ceo', agentId: ceo.id,
      fromReportsTo: ceo.reportsTo ?? null, toReportsTo: null }];
    const changes = [], conflicts = [];
    if (ceo.reportsTo) conflicts.push(assignments[0]);
    const activePacks = setup.enabledPacks.map((enabled) => selectPack(catalog(), enabled.packId, enabled.version));
    const managedPacks = [];
    for (const pack of activePacks) {
      const managed = {};
      const roles = structuredClone(pack.roles);
      for (const roleId of Object.keys(roles)) {
        const key = resourceKey(pack.id, roleId);
        const resolution = await host.agents.managed.get(key, companyId);
        if (!resolution?.agentId || resolution.pluginKey !== host.manifest.id ||
            resolution.resourceKey !== key) throw new Error(`Managed agent ${key} is missing or changed`);
        managed[roleId] = { ...resolution, agent: await agent(companyId, resolution.agentId) };
        if (setup.organization.domainHeads.some((head) => head.agentId === resolution.agentId)) roles[roleId].reportsToRole = 'ceo';
      }
      managedPacks.push({ pack, roles, managed });
    }
    for (const { pack, roles, managed } of managedPacks) {
      const externalManagers = { ceo: ceo.id };
      for (const line of pack.organization?.conditionalReportingLines ?? []) {
        if (!activePacks.some((active) => active.id === line.when?.packId && versionMatches(active.version, line.when))) continue;
        const [managerPackId, managerRoleId, extra] = String(line.reportsToRole).split(':');
        if (!Object.hasOwn(roles, line.roleId) || !managerPackId || !managerRoleId || extra !== undefined) {
          throw new Error(`Invalid cross-pack manager for ${line.roleId}`);
        }
        const managerKey = resourceKey(managerPackId, managerRoleId);
        const manager = managedPacks.find(item => item.pack.id === managerPackId)?.managed[managerRoleId];
        if (!manager) throw new Error(`Managed agent ${managerKey} is not in the enabled organization`);
        roles[line.roleId].reportsToRole = line.reportsToRole;
        externalManagers[line.reportsToRole] = manager.agentId;
      }
      const plan = reportingPlan(roles, managed, companyId, externalManagers);
      assignments.push(...plan.assignments.map((item) => ({ ...item, roleId: resourceKey(pack.id, item.roleId) })));
      changes.push(...plan.changes.map((item) => ({ ...item, roleId: resourceKey(pack.id, item.roleId) })));
      conflicts.push(...plan.conflicts.map((item) => ({ ...item, roleId: resourceKey(pack.id, item.roleId) })));
    }
    const parents = new Map();
    for (const assignment of assignments) {
      if (parents.has(assignment.agentId)) throw new Error('Company organization has a duplicate managed agent');
      parents.set(assignment.agentId, assignment.toReportsTo);
    }
    for (const id of parents.keys()) {
      const visited = new Set();
      for (let current = id; current !== null; current = parents.get(current)) {
        if (!parents.has(current)) throw new Error('Company organization has an unknown manager');
        if (visited.has(current)) throw new Error('Company organization has a reporting cycle');
        visited.add(current);
      }
    }
    return { assignments, changes, conflicts };
  }
  async function nativeDecisions(companyId, controlState, config) {
    const handoff = createDecisionHandoff({ host, companyId, config, trustedActor });
    const result = [];
    for (const escalation of list(controlState.escalations).filter((item) => item.eligibleRole === 'human-owner')) {
      const originKind = `plugin:${host.manifest.id}:decision`;
      const issueId = await handoff.issue({ originKind,
        originId: escalation.id, title: `Decision · ${escalation.subjectType}`,
        description: escalation.question,
        duplicateError: `Duplicate Paperclip Decision issue for ${escalation.id}` });
      const card = await handoff.card(issueId, {
        idempotencyKey: `polyforge-decision:${escalation.id}`,
        title: 'Board Decision', summary: escalation.question,
        addresseeUserId: controlState.organization?.board?.id ?? null,
        payload: { version: 1, title: escalation.question, submitLabel: 'Record decision',
          questionSet: { schema: 'paperclip.question_set.v1',
            questions: [
              { id: 'choice', prompt: escalation.question, required: true, answerMode: 'single_select',
                options: escalation.options.map((option) => ({ id: option.id, label: option.label ?? option.id })) },
              { id: 'reason', prompt: 'Why did you choose this?', required: true, answerMode: 'text' },
            ] },
        },
      });
      if (escalation.status === 'pending' && card.resolvedByUserId && card.result?.answers?.length) {
        const resolved = await handoff.answer(issueId, card,
          'Paperclip Decision resolver is not a human owner');
        if (resolved.choice) {
          await (await engineFor(companyId)).control.adjudicate({ escalationId: escalation.id,
            outcome: resolved.choice, actor: resolved.actor, reason: resolved.boardReason,
            evidence: [...list(escalation.evidence), { ...resolved.receipt,
              rationale: resolved.boardReason }],
            idempotencyKey: `native-decision:${card.id}` });
        }
      }
      result.push({ escalationId: escalation.id, issueId, interactionId: card.id,
        status: card.status, subjectType: escalation.subjectType, question: escalation.question,
        url: `/issues/${issueId}` });
    }
    return result;
  }
  async function read({ companyId, hostActor }) {
    const { actor, isAdministrator } = await identity(companyId, hostActor);
    // The pinned host gives native session calls a company scope on requests
    // and events, but not global scheduled jobs. Finish durable recovery here.
    if (temporaryAgentRuntime) await temporaryAgentRuntime.reconcile({ companyId,
      parent: actor.kind === 'agent' ? { agentId: actor.id, executionId: actor.executionId } : undefined });
    const { store, engine, control } = await engineFor(companyId);
    const state = await control.readReconciledWorkPlans({ actor: planReconciler(),
      reason: 'Observed linked Graph run status' });
    const setup = await control.getSetup();
    const capabilities = await capabilitiesFor(companyId);
    const evidenceProviders = await getEvidenceProviders(host.db, companyId);
    const companyRuns = Object.values(state?.runs ?? {});
    const visibleRuns = actor.kind === 'agent' ? companyRuns.filter((run) => run.actor?.id === actor.id) : companyRuns;
    const controlState = state?.control ?? {};
    let decisions = [], nativeDecisionError = null;
    if (actor.kind === 'human') {
      try {
        const config = await getConfig(host.db, companyId);
        decisions = await nativeDecisions(companyId, controlState, config);
        for (const run of companyRuns.filter((item) => item.status === 'paused')) {
          decisions.push(...await syncGraphDecision({ host, companyId, run, engine, control, config,
            trustedActor, dispatchReady }));
        }
        decisions.push(...await syncProductDecisionCards({ host, companyId, engine, control, config,
          trustedActor }));
      }
      catch (error) { nativeDecisionError = error instanceof Error ? error.message : String(error);
        host.logger?.warn('Native company Decision unavailable', { companyId, error: nativeDecisionError }); }
    }
    const nativeAgents = await host.agents.list({ companyId, limit: 500 });
    const nativeProjects = await host.projects.list({ companyId, limit: 500 });
    const projectsWithWorkspaces = await Promise.all(nativeProjects.map(async (project) => {
      try {
        const primaryWorkspace = await host.projects.getPrimaryWorkspace(project.id, companyId);
        return { ...project, primaryWorkspace };
      } catch {
        return { ...project, workspaceReadError: true };
      }
    }));
    const nativeGoals = await host.goals.list({ companyId, limit: 100 });
    const config = await getConfig(host.db, companyId);
    const ceoStrategyView = actor.kind === 'agent' && actor.id === setup.organization?.ceo?.id &&
      actor.id === config.roleBindings.ceo &&
      list(setup.organization?.authorityPolicy?.ceoOperations).includes('strategy');
    const channelConfig = await getChannelConfig(host.db, companyId);
    const outboundMode = channelConfig.outboundMode ?? 'disabled';
    const channelStatus = (configured) => !configured ? 'unconfigured' :
      outboundMode === 'simulate' ? 'simulated' : 'disabled';
    const channels = {
      paperclipChat: 'available',
      telegram: channelStatus(Boolean(channelConfig.telegram?.webhookSecretRef &&
        channelConfig.telegram?.botTokenSecretRef && list(channelConfig.telegram?.bindings).length)),
      email: channelStatus(Boolean(channelConfig.email?.tokenSecretRef && channelConfig.email?.endpoint)),
      outboundMode,
      deliveries: actor.kind === 'human' && isAdministrator
        ? await listNotificationDeliveries(host.db, companyId) : undefined,
    };
    const readiness = assessCompanyReadiness({ setup, packs: catalog(), config,
      agents: nativeAgents, projects: projectsWithWorkspaces,
      capabilities: { ...CORE_RUNTIME.capabilities, ...capabilities } });
    const decisionHistory = actor.kind === 'human' ? [
      ...list(state?.decisions).map((entry) => ({ ...entry, source: 'graph',
        packId: entry.runId ? state?.runs?.[entry.runId]?.packId ?? null : null })),
      ...list(controlState.audit).map((entry) => {
        const runId = entry.runId ?? entry.sourceRunId ?? entry.newRef?.runId ??
          entry.oldRef?.runId ?? null;
        const plan = runId ? null : list(controlState.plans).find((item) => item.id === entry.planId);
        const planPacks = new Set(list(plan?.items).map((item) => item.packId));
        return { ...entry, source: 'company-control',
          packId: runId ? state?.runs?.[runId]?.packId ?? null :
            entry.packId ?? (planPacks.size === 1 ? [...planPacks][0] : null) };
      }),
    ].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))) : undefined;
    const metricValues = (packId) => {
      const runs = visibleRuns.filter((run) => run.packId === packId);
      const outcomes = list(controlState.reviews).filter((review) => review.packId === packId)
        .flatMap((review) => list(review.observations));
      return {
        'runs.active': runs.filter((run) => run.status === 'running').length,
        'runs.completed': runs.filter((run) => run.status === 'completed').length,
        'runs.unknown': runs.filter((run) => run.status === 'paused' || run.status === 'failed').length,
        'decisions.pending': runs.filter((run) => run.pendingHuman || run.conflicts?.some((item) => item.status === 'waiting_human')).length,
        'reviews.severeOpen': runs.flatMap((run) => Object.values(run.nodeStates ?? {})).flatMap((node) =>
          list(node.attempts?.at(-1)?.selfReviews?.at(-1)?.findings))
          .filter((finding) => ['P0', 'P1'].includes(finding.severity) && finding.status !== 'resolved').length,
        'outcomes.observed': outcomes.filter((item) => item.status === 'observed').length,
        'outcomes.unknown': outcomes.filter((item) => item.status === 'unknown').length,
      };
    };
    return {
      catalog: catalog().map((pack) => ({ id: pack.id, version: pack.version,
        hostSupport: packHostAdapters?.statusPack(pack) ?? { available: true },
        graphs: pack.graphs.map((graph) => ({ id: graph.id, version: graph.version,
          title: graph.title ?? graph.name ?? graph.id, nodes: graph.nodes, edges: graph.edges })),
        dashboard: pack.dashboard ? { ...pack.dashboard,
          metrics: list(pack.dashboard.metrics).map((metric) => ({ ...metric,
            value: metricValues(pack.id)[metric.source] ?? null,
            availability: Object.hasOwn(metricValues(pack.id), metric.source) ? 'available' : 'unavailable' })) } : null,
        compatibility: pack.compatibility ?? null,
        organization: pack.organization ?? null,
        canProvision: Object.keys(pack.roles ?? {}).every(id => host.manifest.agents?.some(agent => agent.agentKey === resourceKey(pack.id, id))) &&
          Object.keys(pack.skills ?? {}).every(id => host.manifest.skills?.some(skill => skill.skillKey === resourceKey(pack.id, id))) })),
      enabledPacks: setup.enabledPacks,
      setup: { ...setup, organizationReady: setup.ready, ready: readiness.ready }, readiness,
      temporaryAgentCapabilities: temporaryAgentRuntime ? await temporaryAgentRuntime.capabilities({ companyId }) : null,
      temporaryAgents: temporaryAgentRuntime ? await temporaryAgentRuntime.list({ companyId,
        parent: actor.kind === 'agent' ? { agentId: actor.id, executionId: actor.executionId } : undefined }) : [],
      shadowLaunches: actor.kind === 'human' ? (await createShadowLaunchStore(host.db).list(companyId)).map(
        ({ data: _data, leaseToken: _token, fingerprint: _fingerprint, ...launch }) => launch) : undefined,
      control: actor.kind === 'human' ? { ...controlState, shadowPolicy: await control.getShadowPolicy(),
        temporaryAgentPolicy: await control.getTemporaryAgentPolicy() } : {
        organization: controlState.organization, enabledPacks: controlState.enabledPacks,
        plans: list(controlState.plans).filter((plan) => plan.assigneeId === actor.id),
        goals: controlState.goalHistory,
        temporaryAgentPolicy: await control.getTemporaryAgentPolicy(),
        shadows: list(controlState.shadows).filter((shadow) => actor.executionId &&
          shadow.requestedBy?.kind === 'agent' && shadow.requestedBy.id === actor.id &&
          shadow.requestedBy.executionId === actor.executionId),
        ...(ceoStrategyView ? { reviews: list(controlState.reviews),
          escalations: list(controlState.escalations), goalHistory: list(controlState.goalHistory) } : {}),
      },
      runs: visibleRuns.map((run) => ({ id: run.id, packId: run.packId, packVersion: run.packVersion,
        graphId: run.graph?.id, status: run.status, projectId: run.input?.projectId ?? null,
        issueId: run.input?.paperclipIssueId ?? null, startedAt: run.startedAt, updatedAt: run.updatedAt })),
      nativeProjects, nativeGoals,
      decisions: decisionHistory,
      nativeDecisions: decisions,
      nativeDecisionError,
      viewer: actor,
      config: actor.kind === 'human' ? config : undefined,
      capabilities: { ...CORE_RUNTIME.capabilities, ...capabilities },
      evidenceProviders: actor.kind === 'human' ? evidenceProviders.map(({ secretRef: _secretRef, ...provider }) =>
        ({ ...provider, secretConfigured: Boolean(_secretRef) })) : undefined,
      channels,
    };
  }

  async function command({ companyId, hostActor, body }) {
    const payload = object(body);
    const operation = required(payload.operation, 'operation');
    const { actor, isAdministrator, config } = await identity(companyId, hostActor);
    const capabilities = await capabilitiesFor(companyId);
    const { store, engine, control } = await engineFor(companyId);
    const common = { actor, reason: required(payload.reason, 'reason'),
      idempotencyKey: required(payload.idempotencyKey, 'idempotencyKey') };
    const admin = () => { if (!isAdministrator || actor.kind !== 'human') throw new Error('A company owner or admin is required'); };
    const owner = () => { if (actor.kind !== 'human' || !actor.roles.includes('human-owner')) throw new Error('A human owner is required'); };
    const temporaryAction = async (action) => {
      const event = { actor, reason: common.reason, operation, requestKey: common.idempotencyKey,
        requestDigest: temporaryAgentFingerprint(payload) };
      await control.recordTemporaryAgentEvent({ ...event, outcome: 'requested' });
      try {
        const result = await action();
        await control.recordTemporaryAgentEvent({ ...event, outcome: 'accepted', temporaryAgentId: result.temporaryAgentId });
        return result;
      } catch (error) {
        await control.recordTemporaryAgentEvent({ ...event, outcome: 'request-failed', error: String(error.message ?? error).slice(0, 1000) });
        throw error;
      }
    };
    const ceoFor = async (scope) => {
      const organization = (await control.getSetup()).organization;
      if (actor.kind !== 'agent' || !actor.executionId ||
          actor.id !== organization?.ceo?.id || actor.id !== config.roleBindings.ceo) {
        throw new Error('Trusted, bound company CEO agent run required');
      }
      if (!list(organization.authorityPolicy?.ceoOperations).includes(scope)) {
        throw new Error(`Board policy has not delegated CEO ${scope} authority`);
      }
    };
    const ownerOrCeo = async (scope) => {
      if (actor.kind === 'human' && actor.roles.includes('human-owner')) return;
      await ceoFor(scope);
    };
    if (operation === 'configure-settings') {
      admin();
      const patch = await validateSettings({ payload, config, catalog: catalog(), host, companyId });
      const changed = await applyGraphConfigChange({ companyId, db: host.db, engine, actor,
        reason: common.reason, idempotencyKey: common.idempotencyKey,
        type: 'actor_binding_configuration', kind: 'actor_binding_change', patch,
        getConfig, compareAndSet: compareAndSetConfig, setConfig, expectedRevision: payload.expectedRevision });
      return { configured: true, config: changed.config, decisionId: changed.decisionId };
    }
    if (operation === 'reload-catalog') {
      admin();
      if (!packRegistry) throw new Error('Pack reload is unavailable');
      const pack = await packRegistry.reload(companyId, { packId: payload.packId ?? catalog()[0]?.id });
      await engine.recordDecision({ type: 'pack_reload', status: 'applied', outcome: `${pack.id}@${pack.version}`,
        ...common, evidence: [{ kind: 'catalog', releases: catalog().map(pack => `${pack.id}@${pack.version}`) }] });
      return { reloaded: true };
    }
    if (operation === 'preview-github-pack' || operation === 'import-github-pack') {
      admin();
      if (!githubPacks) throw new Error('GitHub Pack imports are unavailable');
      const candidate = await githubPacks.preview(payload.source);
      if (operation === 'preview-github-pack') return candidate.preview;
      if (payload.digest !== candidate.preview.digest) throw new Error('The source changed. Preview the Pack again before importing.');
      await engine.recordDecision({ type: 'pack_import', status: 'approved', outcome: 'requested',
        actor, reason: common.reason, evidence: [{ kind: 'github_pack', ...candidate.preview }],
        idempotencyKey: `${common.idempotencyKey}:intent` });
      const result = await githubPacks.install(companyId, candidate);
      await engine.recordDecision({ type: 'pack_import', status: 'applied', outcome: 'imported', actor, reason: common.reason,
        idempotencyKey: `${common.idempotencyKey}:result`,
        evidence: [{ kind: 'github_pack', ...candidate.preview }] });
      return result;
    }
    if (operation === 'enable-pack') {
      admin();
      const pack = selectPack(catalog(), required(payload.packId, 'packId'), payload.version ?? null);
      const setup = await control.getSetup();
      const state = await store.read();
      const preflight = preflightPackChange({ catalog: catalog(), enabled: setup.enabledPacks,
        candidate: { packId: pack.id, version: pack.version }, activeRuns: Object.values(state?.runs ?? {}),
        runtime: CORE_RUNTIME, availableCapabilities: capabilities });
      if (!preflight.ok) throw new Error(`Pack enablement blocked: ${preflight.issues.join('; ')}`);
      return control.enablePack({ packId: pack.id, version: pack.version, ...common });
    }
    if (operation === 'configure-execution') {
      admin();
      const defaultMode = required(payload.defaultMode, 'defaultMode');
      if (!['manual', 'assisted', 'autonomous'].includes(defaultMode)) throw new Error('Invalid company default decision mode');
      const changed = await applyGraphConfigChange({ companyId, db: host.db, engine, actor,
        reason: common.reason, idempotencyKey: common.idempotencyKey,
        type: 'execution_configuration', kind: 'execution_mode_change',
        patch: { defaultMode }, getConfig, compareAndSet: compareAndSetConfig, setConfig });
      return { configured: true, defaultMode: changed.config.defaultMode, requestedMode: defaultMode,
        decisionId: changed.decisionId, replayed: changed.replayed };
    }
    if (operation === 'preflight-runtime') {
      admin();
      const runtime = object(payload.runtime);
      if (!required(runtime.version, 'runtime.version') || !Number.isInteger(runtime.schemaVersion) ||
          runtime.schemaVersion < 1 || !Object.keys(object(runtime.contracts)).length ||
          !Object.keys(object(runtime.capabilities)).length) {
        throw new Error('Candidate Core runtime needs version, schema, contracts and intrinsic capabilities');
      }
      const state = await store.read();
      const setup = await control.getSetup();
      const releases = new Map([...Object.values(state?.packs ?? {}), ...catalog()]
        .map((pack) => [`${pack.id}@${pack.version}`, pack]));
      const result = preflightPackChange({ catalog: [...releases.values()], enabled: setup.enabledPacks,
        activeRuns: Object.values(state?.runs ?? {}), runtime, availableCapabilities: capabilities });
      const decision = await engine.recordDecision({ type: 'runtime_preflight',
        status: result.ok ? 'approved' : 'blocked', outcome: result.ok ? 'compatible' : 'issues',
        actor, reason: common.reason,
        evidence: [{ kind: 'operator_supplied_runtime', runtime },
          { kind: 'company_runtime_preflight', companyId, enabledPacks: setup.enabledPacks,
            activeRunIds: Object.values(state?.runs ?? {}).filter((run) =>
              !['completed', 'stopped', 'failed'].includes(run.status)).map((run) => run.id),
            issues: result.issues, unavailableGraphs: result.unavailableGraphs }],
        idempotencyKey: `${common.idempotencyKey}:runtime-preflight` });
      return { ...result, decisionId: decision.id, candidateVerified: false,
        scope: 'this company and its unfinished Graph runs' };
    }
    if (operation === 'configure-evidence-providers') {
      admin();
      const request = payload.provider ? { provider: providerConfiguration(payload.provider) }
        : { providers: list(payload.providers).map(providerConfiguration) };
      return configureEvidenceProviders({ companyId, actor, reason: common.reason, requestKey: common.idempotencyKey,
        request, engine, read: () => getEvidenceProviders(host.db, companyId),
        write: providers => setEvidenceProviders(host.db, companyId, providers),
        refresh: () => engineFor(companyId), validate: async providers => {
      const ids = new Set();
      for (const provider of providers) {
        if (!provider || typeof provider.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(provider.id) || ids.has(provider.id)) {
          throw new Error('Evidence providers require unique stable IDs');
        }
        ids.add(provider.id);
        if (provider.companyId !== companyId || !Array.isArray(provider.kinds) || !provider.kinds.length ||
            provider.kinds.some((kind) => !['release', 'metric'].includes(kind))) throw new Error('Evidence provider scope or kinds are invalid');
        if (!provider.secretRef || provider.secretRef.type !== 'secret_ref' || !uuid(provider.secretRef.secretId)) {
          throw new Error('Evidence provider requires a Paperclip secret reference');
        }
        const resolvedSecret = await host.secrets.resolve(provider.secretRef, { companyId,
          configPath: `evidence.providers.${provider.id}.secretRef` });
        if (typeof resolvedSecret !== 'string' || resolvedSecret.length < 16) throw new Error('Evidence provider secret is unavailable');
        if (provider.projectIds !== undefined && (!Array.isArray(provider.projectIds) ||
          provider.projectIds.some((id) => !uuid(id)))) throw new Error('Evidence provider project IDs are invalid');
        for (const projectId of provider.projectIds ?? []) await project(companyId, projectId);
        if (provider.maxAgeSeconds !== undefined && (!Number.isInteger(provider.maxAgeSeconds) ||
          provider.maxAgeSeconds < 1 || provider.maxAgeSeconds > 90 * 86400)) throw new Error('Invalid evidence receipt age limit');
      }
      } });
    }
    if (operation === 'import-evidence') {
      await project(companyId, payload.projectId);
      const providers = await getEvidenceProviders(host.db, companyId);
      const provider = providers.find((item) => item.id === payload.receipt?.providerId && item.enabled !== false);
      const verified = await verifyEvidenceReceipt({ receipt: payload.receipt, signature: payload.signature,
        provider, companyId, projectId: payload.projectId,
         resolveSecret: (ref) => host.secrets.resolve(ref, { companyId,
          configPath: `evidence.providers.${provider?.id}.secretRef` }) });
      const existing = list((await store.read())?.control?.evidenceReceipts)
        .find((item) => item.id === verified.id);
      let authenticated = verified;
      if (existing) {
        const { verification: _verification, ...signedReceipt } = existing.receipt;
        if (canonicalEvidence(signedReceipt) !== canonicalEvidence(payload.receipt)) {
          throw new Error('Evidence receipt ID reused with different payload');
        }
        authenticated = existing.receipt;
      }
      const systemActor = { id: host.manifest.id, kind: 'system',
        roles: [`evidence-provider:${verified.providerId}`], executionId: null };
      return control.recordEvidenceReceipt({ receipt: authenticated, actor: systemActor,
        reason: `Authenticated evidence imported by ${actor.kind}:${actor.id}: ${common.reason}`,
        idempotencyKey: common.idempotencyKey });
    }
    if (operation === 'provision-pack') {
      admin();
      const pack = selectPack(catalog(), required(payload.packId, 'packId'), payload.version ?? null);
      if (!(await control.getSetup()).enabledPacks.some((item) => item.packId === pack.id && item.version === pack.version)) {
        throw new Error('Enable this Pack before provisioning managed resources');
      }
      const agents = [], skills = [], assignments = {};
      let roleBindings = { ...config.roleBindings };
      const ceo = await host.agents.managed.reconcile('company:ceo', companyId);
      if (ceo.agentId && roleBindings.ceo && roleBindings.ceo !== ceo.agentId) {
        throw new Error('Existing CEO binding differs from the managed company CEO; resolve the organization conflict');
      }
      if (ceo.agentId) { roleBindings.ceo = ceo.agentId; assignments.ceo = ceo.agentId; }
      for (const id of Object.keys(pack.skills ?? {})) {
        const key = resourceKey(pack.id, id);
        if (!host.manifest.skills?.some((item) => item.skillKey === key)) throw new Error(`Pack skill ${key} is missing from installed manifest`);
        skills.push(await host.skills.managed.reconcile(key, companyId));
      }
      for (const id of Object.keys(pack.roles ?? {})) {
        const key = resourceKey(pack.id, id);
        if (!host.manifest.agents?.some((item) => item.agentKey === key)) throw new Error(`Pack agent ${key} is missing from installed manifest`);
        if (pack.id === 'adlc' && config.roleBindings[id]) {
          const existingManaged = await host.agents.managed.get(key, companyId);
          if (existingManaged?.agentId !== config.roleBindings[id]) {
            throw new Error(`Legacy ADLC ${id} binding has no matching namespaced managed identity; preserve it until the Board approves migration`);
          }
        }
        const resolution = await host.agents.managed.reconcile(key, companyId);
        agents.push(resolution);
        if (pack.id === 'adlc' && config.roleBindings[id] && resolution.agentId &&
            config.roleBindings[id] !== resolution.agentId) {
          throw new Error(`Legacy ADLC ${id} binding points to another agent; preserve it until the Board approves an identity migration`);
        }
        if (resolution.agentId && roleBindings[key] && roleBindings[key] !== resolution.agentId) {
          throw new Error(`Existing ${key} binding differs from its managed agent; resolve the organization conflict`);
        }
        if (resolution.agentId) { roleBindings[key] = resolution.agentId; assignments[key] = resolution.agentId; }
      }
      if (patchRoleBindings) roleBindings = (await patchRoleBindings(host.db, companyId, assignments)).roleBindings;
      else {
        const latest = await getConfig(host.db, companyId);
        roleBindings = { ...latest.roleBindings, ...assignments };
        await setConfig(host.db, companyId, { ...latest, roleBindings });
      }
      return { packId: pack.id, version: pack.version, ceo, agents, skills, roleBindings };
    }
    if (operation === 'configure-organization') {
      admin();
      const organization = object(payload.organization);
      const board = object(organization.board), ceo = object(organization.ceo);
      if (payload.derive === true) {
        board.id ??= actor.id;
        ceo.id ??= payload.ceoId ?? config.roleBindings.ceo ?? (await control.getSetup()).organization?.ceo?.id;
        organization.domainHeads ??= catalog().flatMap((pack) => Object.values(pack.roles ?? {})
          .filter((role) => role.reportsToRole === 'ceo')
          .map((role) => ({ domain: role.id === 'cpo' ? 'product' : role.id === 'cto-caio' ? 'engineering' : pack.id,
            agentId: config.roleBindings[resourceKey(pack.id, role.id)] }))
          .filter((head) => head.agentId));
      }
      if (ceo.id) await agent(companyId, ceo.id);
      for (const item of list(organization.domainHeads)) await agent(companyId, item.agentId);
      return control.configureSetup({ organization: { ...organization, board, ceo,
        domainHeads: list(organization.domainHeads) }, ...common });
    }
    if (operation === 'organization-reporting-plan') {
      admin();
      const setup = await control.getSetup();
      const plan = await reporting(companyId, setup);
      const decision = await engine.recordDecision({ type: 'company_reporting',
        status: plan.conflicts.length ? 'blocked' : 'approved',
        outcome: plan.conflicts.length ? 'custom_manager_conflict' : 'requested',
        reason: common.reason, actor, evidence: [{ kind: 'organization_plan',
          companyId, assignments: plan.assignments, conflicts: plan.conflicts }],
        idempotencyKey: `${common.idempotencyKey}:reporting-plan` });
      return { planDecisionId: decision.id, ...plan };
    }
    if (operation === 'organization-reporting-confirm') {
      admin();
      const planDecisionId = required(payload.planDecisionId, 'planDecisionId');
      const prior = (await engine.listDecisions()).find((item) => item.id === planDecisionId);
      const recorded = prior?.evidence?.find((item) => item.kind === 'organization_plan');
      if (prior?.type !== 'company_reporting' || prior.status !== 'approved' ||
          prior.actor?.id !== actor.id || recorded?.companyId !== companyId) throw new Error('Reporting plan belongs to another actor or company');
      const current = await reporting(companyId, await control.getSetup());
      if (current.conflicts.length || current.changes.length ||
          JSON.stringify(current.assignments.map(({ roleId, agentId, toReportsTo }) => ({ roleId, agentId, toReportsTo }))) !==
          JSON.stringify(recorded.assignments.map(({ roleId, agentId, toReportsTo }) => ({ roleId, agentId, toReportsTo })))) {
        throw new Error('Native Paperclip reporting links do not match the approved plan');
      }
      const decision = await engine.recordDecision({ type: 'company_reporting', status: 'applied',
        outcome: 'aligned', reason: common.reason, actor, supersedes: planDecisionId,
        evidence: [{ kind: 'organization_result', companyId, assignments: current.assignments }],
        idempotencyKey: `${common.idempotencyKey}:reporting-confirm` });
      return { aligned: true, decisionId: decision.id, assignments: current.assignments };
    }
    if (operation === 'create-intake') {
      if (actor.kind !== 'human') throw new Error('Authenticated human required for direct intake');
      await project(companyId, payload.projectId);
      const sourceIssue = await host.issues.get(required(payload.sourceIssueId, 'sourceIssueId'), companyId);
      if (!sourceIssue || sourceIssue.projectId !== payload.projectId) throw new Error('Paperclip chat issue must belong to the requested project');
      const sourceComment = (await host.issues.listComments(sourceIssue.id, companyId))
        .find((item) => item.id === payload.sourceCommentId && !item.deletedAt);
      if (!sourceComment || sourceComment.authorUserId !== actor.id) throw new Error('Intake requires a chat message from the authenticated user');
      const intake = await control.createIntake({ projectId: payload.projectId,
        title: required(payload.title, 'title'), description: sourceComment.body,
        requestedPackId: payload.requestedPackId, assigneeId: payload.assigneeId,
        source: { channel: 'paperclip-chat', senderId: actor.id, messageId: sourceComment.id,
          issueId: sourceIssue.id }, attachments: list(payload.attachments),
          contextRefs: list(payload.contextRefs), ...common });
      const setup = await control.getSetup();
      const assigneeAgentId = await nativeIntakeAssignee({ host, companyId, intake, setup, config });
      const originKind = `plugin:${host.manifest.id}:intake`;
      const existing = await host.issues.list({ companyId, originKind, originId: intake.id, limit: 2 });
      if (existing.length > 1) throw new Error('Duplicate native intake issues require operator repair');
      const issue = existing[0] ?? await host.issues.create({ companyId, projectId: intake.projectId,
        title: intake.title, description: intake.description, status: 'todo',
        assigneeAgentId: assigneeAgentId ?? undefined, originKind, originId: intake.id });
      if (existing[0] && (issue.assigneeAgentId ?? null) !== assigneeAgentId) {
        await host.issues.update(issue.id, { assigneeAgentId }, companyId);
      }
      const wakeup = intake.status === 'ceo-review' && assigneeAgentId
        ? await wakeCeoIssue({ host, companyId, issueId: issue.id, setup, config,
          scope: 'intake', sourceId: intake.id }) : null;
      return { intake, issueId: issue.id, wakeup };
    }
    if (operation === 'route-intake') {
      if (actor.kind === 'agent') {
        const intake = (await control.getIntake()).find((item) => item.id === payload.intakeId);
        if (!intake) throw new Error('Intake not found');
        if (intake.status === 'offered' && intake.assigneeId === actor.id &&
            ['accept', 'reject', 'forward-ceo'].includes(payload.outcome)) {
          if (!actor.executionId) throw new Error('Active assignee run required');
        } else await ceoFor('intake');
      } else owner();
      const result = await control.routeIntake({ intakeId: required(payload.intakeId, 'intakeId'),
        outcome: required(payload.outcome, 'outcome'), assigneeId: payload.assigneeId, ...common });
      const setup = await control.getSetup();
      const assigneeAgentId = await nativeIntakeAssignee({ host, companyId, intake: result, setup, config });
      const issues = await host.issues.list({ companyId, originKind: `plugin:${host.manifest.id}:intake`,
        originId: result.id, limit: 2 });
      if (issues.length === 1) await host.issues.update(issues[0].id, {
        status: result.status === 'rejected' ? 'cancelled' : 'todo',
        assigneeAgentId,
      }, companyId);
      const wakeup = result.status === 'ceo-review' && assigneeAgentId && issues.length === 1
        ? await wakeCeoIssue({ host, companyId, issueId: issues[0].id, setup, config,
          scope: 'intake', sourceId: `${result.id}:${result.history.at(-1)?.id ?? 'review'}` }) : null;
      return { intake: result, issueId: issues[0]?.id ?? null, wakeup };
    }
    if (operation === 'escalate-decision') {
      return control.escalateDecision({ subjectType: payload.subjectType,
        subjectId: payload.subjectId, question: payload.question,
        options: list(payload.options), evidence: list(payload.evidence), ...common });
    }
    if (operation === 'adjudicate') {
      if (actor.kind === 'agent') {
        const escalation = (await control.getEscalations()).find((item) => item.id === payload.escalationId);
        if (!escalation || escalation.status !== 'pending' || escalation.eligibleRole !== 'ceo') {
          throw new Error('Only a pending CEO escalation may be resolved by an agent');
        }
        await ceoFor('decision');
        const policy = (await control.getSetup()).organization.authorityPolicy;
        if (!list(policy?.ceoDecisions).includes(escalation.subjectType)) {
          throw new Error('Board policy has not delegated this CEO decision');
        }
      } else owner();
      return control.adjudicate({ escalationId: required(payload.escalationId, 'escalationId'),
        outcome: required(payload.outcome, 'outcome'), evidence: list(payload.evidence), ...common });
    }
    if (operation === 'create-plan') {
      await ownerOrCeo('work-plan'); await project(companyId, payload.projectId);
      return control.createWorkPlan({ projectId: payload.projectId, items: list(payload.items), ...common });
    }
    if (operation === 'update-plan-item') {
      await ownerOrCeo('work-plan'); return control.updateWorkItem({ planId: required(payload.planId, 'planId'),
        itemId: required(payload.itemId, 'itemId'), status: payload.status, priority: payload.priority, ...common });
    }
    if (operation === 'start-plan-item') {
      await ownerOrCeo('work-plan');
      const { plan, item, run: priorRun } = await control.getWorkPlanItemContext({
        planId: payload.planId, itemId: payload.itemId, actor: planReconciler(),
        reason: 'Observed linked Graph run status' });
      await project(companyId, plan.projectId);
      const pack = selectPack(catalog(), item.packId, item.packVersion);
      if (!pack.graphs.some((graph) => graph.id === item.graphId)) throw new Error('Work plan Graph is not installed');
      packHostAdapters?.assertPackStart(pack, item.graphId);
      const originKind = `plugin:${host.manifest.id}:plan-item`, originId = `${plan.id}:${item.id}`;
      const priorIssues = await host.issues.list({ companyId, originKind, originId, limit: 2 });
      if (priorIssues.length > 1) throw new Error('Duplicate plan item issues require operator repair');
      const issue = priorIssues[0] ?? await host.issues.create({ companyId, projectId: plan.projectId,
        title: item.title ?? `${pack.id} · ${item.graphId}`, description: item.description ??
          `Work plan ${plan.id}, item ${item.id}. Start ${pack.id}@${pack.version}/${item.graphId} using the PolyForge Graph command.`,
        status: 'todo', originKind, originId });
      const { goalContext: _goalContext, paperclipCompanyId: _company, paperclipIssueId: _issue,
        projectId: _project, planId: _plan, planItemId: _item, ...itemInput } = object(item.input);
      const run = priorRun ?? await engine.startRun({ packId: pack.id, packVersion: pack.version,
        graphId: item.graphId, mode: config.defaultMode, deliveryLimits: config.deliveryLimits,
        input: { ...itemInput, projectId: plan.projectId, planId: plan.id, planItemId: item.id,
          paperclipIssueId: issue.id, paperclipCompanyId: companyId },
        actor, idempotencyKey: `plan-item:${plan.id}:${item.id}` });
      return { planId: plan.id, itemId: item.id, issueId: issue.id, run,
        dispatch: await dispatchReady(companyId, engine, run.id, config) };
    }
    if (operation === 'set-goals') {
      if (payload.scope === 'company') admin();
      else if (payload.scope === 'agent') await ownerOrCeo('agent-goal');
      else throw new Error('Goal scope must be company or agent');
      const goals = list(payload.goals);
      if (payload.scope === 'agent') await agent(companyId, payload.subjectId);
      const revision = await control.setGoals({ scope: payload.scope, subjectId: payload.subjectId, goals, ...common });
      const current = list((await store.read())?.control?.goalHistory)
        .filter((item) => item.scope === revision.scope && item.subjectId === revision.subjectId).at(-1);
      if (!current) throw new Error('Current goal revision missing after update');
      return { revision, projectedRevisionId: current.id,
        nativeGoals: await syncNativeGoals(companyId, current) };
    }
    if (operation === 'record-knowledge') {
      owner(); await project(companyId, payload.projectId);
      return control.recordKnowledge({ projectId: payload.projectId, kind: payload.kind,
        title: payload.title, body: payload.body, sourceRefs: list(payload.sourceRefs), ...common });
    }
    if (operation === 'query-knowledge') {
      if (payload.projectId) await project(companyId, payload.projectId);
      const manual = await control.queryKnowledge({ projectId: payload.projectId, kind: payload.kind, q: payload.q });
      const state = await store.read();
      const q = typeof payload.q === 'string' ? payload.q.toLowerCase() : null;
      const decisions = list(state?.decisions).filter((item) => {
        const kind = item.type === 'product' ? 'product' : 'decision';
        const runProject = state?.runs?.[item.runId]?.input?.projectId;
        return (!payload.kind || payload.kind === kind) &&
          (!payload.projectId || item.projectId === payload.projectId || runProject === payload.projectId) &&
          (!q || `${item.feature ?? ''} ${item.reason ?? ''} ${item.outcome ?? ''}`.toLowerCase().includes(q));
      }).map((item) => ({ id: item.id, projectId: item.projectId ?? state?.runs?.[item.runId]?.input?.projectId ?? null,
        kind: item.type === 'product' ? 'product' : 'decision', title: item.feature ?? item.type,
        body: item.reason, status: item.status, outcome: item.outcome,
        sourceRefs: [{ kind: 'graph-decision', id: item.id, runId: item.runId ?? null }],
        at: item.at, source: 'graph-decision' }));
      return [...manual, ...decisions];
    }
    if (operation === 'append-feedback') {
      await project(companyId, payload.projectId);
      const subjectId = required(payload.subjectId, 'subjectId');
      const state = await store.read();
      const subjectRun = state?.runs?.[subjectId];
      if (subjectRun && subjectRun.input?.projectId !== payload.projectId) throw new Error('Feedback run belongs to another project');
      if (!subjectRun) {
        const subjectAgent = await host.agents.get(subjectId, companyId);
        const subjectIssue = subjectAgent ? null : await host.issues.get(subjectId, companyId);
        if (!subjectAgent && !subjectIssue) throw new Error('Feedback subject is not a company run, agent or issue');
        if (subjectIssue && subjectIssue.projectId !== payload.projectId) throw new Error('Feedback issue belongs to another project');
      }
      return control.appendFeedback({ projectId: payload.projectId, subjectId: payload.subjectId,
        body: payload.body, sourceRefs: list(payload.sourceRefs), ...common });
    }
    if (operation === 'take-over') {
      owner();
      const run = await engine.getRun(required(payload.runId, 'runId'));
      if (!run?.input?.paperclipIssueId || !await host.issues.get(run.input.paperclipIssueId, companyId)) {
        throw new Error('Company Graph issue required for human takeover');
      }
      return control.takeOver({ runId: run.id, nodeId: required(payload.nodeId, 'nodeId'), ...common });
    }
    if (operation === 'resolve-takeover') {
      owner();
      const result = await control.resolveTakeover({ runId: required(payload.runId, 'runId'),
        takeoverId: required(payload.takeoverId, 'takeoverId'), outcome: required(payload.outcome, 'outcome'), ...common });
      if (result.status === 'running') return { ...result,
        dispatch: await dispatchReady(companyId, engine, result.runId, config) };
      return result;
    }
    if (operation === 'record-handoff') {
      await ownerOrCeo('cross-pack'); await project(companyId, payload.projectId);
      const source = await engine.getRun(payload.sourceRunId);
      if (!source || source.input.projectId !== payload.projectId || source.status !== 'completed') throw new Error('Completed source run in the same project required');
      const enabled = (await control.getSetup()).enabledPacks.find((item) => item.packId === payload.targetPackId);
      if (!enabled) throw new Error('Target Pack is not enabled');
      const target = selectPack(catalog(), enabled.packId, enabled.version);
      return control.recordHandoff({ ...payload, ...common });
    }
    if (operation === 'open-shadow') {
      return shadowRuntime.open({ companyId, actor, payload, common,
        available: capabilities['shadow-review-execution'] === '1.0.0' });
    }
    if (operation === 'configure-temporary-agent-policy') {
      owner();
      return control.configureTemporaryAgentPolicy({ policy: object(payload.policy), ...common });
    }
    if (operation === 'open-temporary-agent') {
      if (!temporaryAgentRuntime) throw new Error('Temporary Agent runtime unavailable');
      return temporaryAction(() => temporaryAgentRuntime.open({ companyId, request: object(payload.request), ...common }));
    }
    if (operation === 'stop-temporary-agent') {
      if (!temporaryAgentRuntime) throw new Error('Temporary Agent runtime unavailable');
      if (actor.kind === 'human') owner();
      return temporaryAction(() => temporaryAgentRuntime.stop({ companyId,
        temporaryAgentId: required(payload.temporaryAgentId, 'temporaryAgentId'), ...common }));
    }
    if (operation === 'repair-temporary-agent') {
      owner();
      if (!temporaryAgentRuntime) throw new Error('Temporary Agent runtime unavailable');
      return temporaryAction(() => temporaryAgentRuntime.repair({ companyId,
        temporaryAgentId: required(payload.temporaryAgentId, 'temporaryAgentId'),
        repair: object(payload.repair), ...common }));
    }
    if (operation === 'configure-shadow-policy') {
      owner();
      return control.configureShadowPolicy({ policy: object(payload.policy), ...common });
    }
    if (operation === 'stop-shadow' || operation === 'close-shadow') {
      return shadowRuntime.closeByShadowId({ companyId,
        shadowId: required(payload.shadowId, 'shadowId'), ...common });
    }
    if (operation === 'review-outcome') {
      await ownerOrCeo('strategy'); await project(companyId, payload.projectId);
      let goalRevisionId = payload.goalRevisionId;
      if (payload.runId) {
        const run = await engine.getRun(required(payload.runId, 'runId'));
        if (!run || run.input?.projectId !== payload.projectId) throw new Error('Outcome run/project mismatch');
        const pinned = list(run.goalContext?.revisions).find((revision) =>
          list(revision.goals).some((goal) => goal.id === payload.goalId));
        if (!pinned) throw new Error('Outcome goal is absent from the run’s pinned goal context');
        if (goalRevisionId && goalRevisionId !== pinned.id) throw new Error('Outcome goal revision differs from the run’s pinned revision');
        goalRevisionId = pinned.id;
      }
      return control.reviewOutcome({ projectId: payload.projectId, goalId: payload.goalId,
        goalRevisionId, sourceRunId: payload.runId ?? undefined,
        observations: list(payload.observations), ...common });
    }
    if (operation === 'adjust-strategy') {
      await ownerOrCeo('strategy');
      const adjustment = await control.adjustStrategy({ reviewId: payload.reviewId, changes: list(payload.changes), ...common });
      const state = await store.read();
      const nativeGoals = [];
      for (const id of adjustment.goalRevisionIds) {
        const revision = list(state?.control?.goalHistory).find((item) => item.id === id);
        if (!revision) throw new Error('Adjusted goal revision missing from company state');
        const current = list(state?.control?.goalHistory)
          .filter((item) => item.scope === revision.scope && item.subjectId === revision.subjectId).at(-1);
        nativeGoals.push(...await syncNativeGoals(companyId, current));
      }
      return { adjustment, nativeGoals };
    }
    if (operation === 'set-notification-preferences') {
      if (payload.subjectId !== actor.id && !isAdministrator) throw new Error('Notification preferences belong to another identity');
      return control.setNotificationPreferences({ subjectId: payload.subjectId,
        channels: list(payload.channels), events: list(payload.events), ...common });
    }
    if (operation === 'mark-notification') {
      return control.markNotification({ notificationId: payload.notificationId, ...common });
    }
    throw new Error(`Unknown company operation: ${operation}`);
  }
  return { read, settings, command, reconcileShadows: shadowRuntime.reconcile };
}
