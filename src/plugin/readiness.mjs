import { compatibilityIssues } from '../core/compatibility.mjs';
import { resourceKey } from './catalog.mjs';

const list = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const order = { ready: 0, unknown: 1, blocked: 2 };
const statusOf = checks => checks.reduce((status, check) => order[check.status] > order[status] ? check.status : status, 'ready');
const check = (id, status, reason, action) => ({ id, status, reason, action });
const ready = (id, reason) => check(id, 'ready', reason, null);
const blocked = (id, reason, action) => check(id, 'blocked', reason, action);
const unknown = (id, reason, action) => check(id, 'unknown', reason, action);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function agentModel(agent) {
  const adapter = object(agent.adapterConfig), runtime = object(agent.runtimeConfig);
  const connection = object(runtime.aiConnection);
  return [adapter.model, object(adapter.profile).model, object(connection.profile).model]
    .find(nonempty) ?? null;
}

function roleReadiness(packId, roleId, agentId, agents) {
  const id = resourceKey(packId, roleId), agent = agents.find(item => item.id === agentId);
  const checks = [];
  if (!agentId) checks.push(blocked('binding', 'No native agent is bound to this role.', 'Bind a Paperclip agent.'));
  else if (!agent) checks.push(blocked('agent', 'The bound agent is absent from the company agent list.', 'Repair the role binding.'));
  else {
    checks.push(['idle', 'active', 'running'].includes(agent.status)
      ? ready('status', 'The native agent can receive work.')
      : blocked('status', 'The native agent is paused, pending, errored, or terminated.', 'Activate the agent in Paperclip.'));
    checks.push(Number.isFinite(agent.budgetMonthlyCents) && Number.isFinite(agent.spentMonthlyCents) &&
      agent.budgetMonthlyCents > agent.spentMonthlyCents
      ? ready('budget', 'Monthly agent budget has remaining capacity.')
      : blocked('budget', 'Monthly agent budget is missing or exhausted.', 'Set a positive agent budget with remaining capacity.'));
    if (agent.adapterType === 'process') {
      checks.push(nonempty(object(agent.adapterConfig).command)
        ? ready('adapter', 'Synthetic process adapter command is configured.')
        : blocked('adapter', 'Synthetic process adapter has no command.', 'Configure the process command.'));
    } else if (!nonempty(agent.adapterType)) {
      checks.push(blocked('adapter', 'No model adapter is selected.', 'Choose a Paperclip model adapter.'));
    } else {
      checks.push(agentModel(agent)
        ? ready('model', 'A model is selected for this adapter.')
        : blocked('model', 'No model is selected for this adapter.', 'Select an adapter model.'));
      checks.push(unknown('provider', 'Credential and provider availability is not established by the native agent record.',
        'Verify the adapter connection in Paperclip.'));
    }
  }
  return { id, roleId, agentId: agentId ?? null, adapterType: agent?.adapterType ?? null,
    model: agent ? agentModel(agent) : null, synthetic: agent?.adapterType === 'process',
    status: statusOf(checks), checks };
}

function projectReadiness(project) {
  const workspace = object(project.primaryWorkspace);
  const codebase = object(project.codebase);
  const checks = [];
  checks.push(project.archivedAt || ['archived', 'paused'].includes(project.status)
    ? blocked('status', 'Project is archived or paused.', 'Activate the project.')
    : ready('status', 'Project is available.'));
  const repo = workspace.repoUrl ?? codebase.repoUrl;
  checks.push(nonempty(repo)
    ? ready('repository', 'A repository is configured for the project.')
    : blocked('repository', 'No repository is configured for the project.', 'Connect a project repository.'));
  const location = workspace.cwd ?? workspace.remoteWorkspaceRef;
  checks.push(project.workspaceReadError
    ? unknown('workspace', 'Primary workspace details could not be read from Paperclip.', 'Grant project workspace read access and retry.')
    : nonempty(location)
      ? ready('workspace', 'A project workspace location is configured.')
      : blocked('workspace', 'No project workspace location is configured.', 'Configure the project workspace.'));
  return { projectId: project.id, name: project.name ?? project.id, status: statusOf(checks), checks };
}

/** Pure, sanitized readiness projection; it never tests credentials or mutates Paperclip. */
export function assessCompanyReadiness({ setup, packs = [], config = {}, agents = [], projects = [], capabilities = {} } = {}) {
  const organization = object(setup?.organization), bindings = object(config?.roleBindings);
  const enabled = list(setup?.enabledPacks), nativeAgents = list(agents), nativeProjects = list(projects);
  const versions = object(capabilities);
  const checks = [
    organization.board?.id && organization.ceo?.id && list(organization.domainHeads).length
      ? ready('organization', 'Board, CEO, and domain heads are configured.')
      : blocked('organization', 'Board, CEO, or domain heads are missing.', 'Complete the company organization.'),
    enabled.length ? ready('packs', 'At least one Pack is enabled.')
      : blocked('packs', 'No Pack is enabled.', 'Enable a compatible Pack.'),
    ['manual', 'assisted', 'autonomous'].includes(config?.defaultMode)
      ? ready('decision-mode', `Decision mode ${config.defaultMode} is configured.`)
      : blocked('decision-mode', 'Decision mode is missing or invalid.', 'Select a company decision mode.'),
  ];
  const ceo = roleReadiness('company', 'ceo', bindings.ceo ?? organization.ceo?.id, nativeAgents);
  if (organization.ceo?.id && bindings.ceo !== organization.ceo.id) {
    ceo.checks.push(blocked('organization-binding', 'CEO role binding differs from the organization CEO.', 'Align the CEO binding.'));
    ceo.status = statusOf(ceo.checks);
  }
  const roles = [ceo];
  const projectResults = nativeProjects.map(projectReadiness);
  if (!projectResults.length) checks.push(blocked('projects', 'No project is available for Graph work.', 'Create a project with a repository and workspace.'));
  else if (!projectResults.some(item => item.status === 'ready')) checks.push(projectResults.some(item => item.status === 'unknown')
    ? unknown('projects', 'Project workspace readiness could not be established.', 'Grant project workspace read access and retry.')
    : blocked('projects', 'No project has a configured repository and workspace.', 'Configure at least one project.'));
  else checks.push(ready('projects', 'At least one project has repository and workspace configuration.'));
  const packResults = enabled.map(selection => {
    const pack = list(packs).find(item => item.id === selection.packId && item.version === selection.version);
    if (!pack) return { packId: selection.packId, version: selection.version, status: 'blocked',
      checks: [blocked('catalog', 'Enabled Pack release is absent from the instance catalog.', 'Install the exact Pack release.')], roles: [], graphs: [] };
    const packChecks = compatibilityIssues(pack, null, { availableCapabilities: versions })
      .map(issue => blocked('compatibility', issue, 'Resolve the Pack requirement.'));
    if (!packChecks.length) packChecks.push(ready('compatibility', 'Pack Core and capability requirements are met.'));
    const packRoles = Object.keys(object(pack.roles)).map(roleId => {
      const key = resourceKey(pack.id, roleId);
      const role = roleReadiness(pack.id, roleId, bindings[key] ?? (pack.id === 'adlc' ? bindings[roleId] : null), nativeAgents);
      roles.push(role);
      return role;
    });
    const graphs = list(pack.graphs).map(graph => {
      const graphChecks = compatibilityIssues(pack, graph, { availableCapabilities: versions })
        .map(issue => blocked('compatibility', issue, 'Resolve the Graph requirement.'));
      const requiredRoles = [...new Set(list(graph.nodes).flatMap(node =>
        [node.role, node.review?.supervisorRole].filter(role => role && role !== 'human-owner')))];
      for (const roleId of requiredRoles) {
        const role = packRoles.find(item => item.roleId === roleId) ??
          roleReadiness(pack.id, roleId, bindings[resourceKey(pack.id, roleId)], nativeAgents);
        if (role.status !== 'ready') graphChecks.push(check(`role:${roleId}`, role.status,
          `Role ${roleId} is ${role.status}.`, 'Complete the native agent role setup.'));
      }
      const rules = list(pack.decisionRules);
      for (const node of list(graph.nodes)) {
        const decisionType = node.type === 'decision' ? node.decisionType ?? node.id :
          node.review ? node.review.decisionType ?? 'review' : null;
        if (decisionType && !rules.some(rule => rule.type === decisionType && rule.mode === config?.defaultMode)) {
          graphChecks.push(blocked('decision-rule', `No ${config?.defaultMode ?? 'selected'} decision rule covers ${decisionType}.`,
            'Select a supported decision mode or install a matching Pack release.'));
        }
      }
      const projectsForGraph = projectResults.map(project => ({ projectId: project.projectId, status: project.status }));
      if (!projectResults.some(project => project.status === 'ready')) graphChecks.push(projectResults.some(project => project.status === 'unknown')
        ? unknown('project', 'Project workspace readiness could not be established for this Graph.', 'Grant project workspace read access and retry.')
        : blocked('project', 'No configured project can host this Graph.', 'Configure a project repository and workspace.'));
      if (ceo.status !== 'ready') graphChecks.push(check('ceo', ceo.status, 'Company CEO is not ready.', 'Complete the CEO agent setup.'));
      if (!graphChecks.length) graphChecks.push(ready('graph', 'Graph requirements are configured.'));
      return { graphId: graph.id, version: graph.version, status: statusOf(graphChecks), checks: graphChecks,
        requiredRoles, projects: projectsForGraph };
    });
    const status = statusOf([...packChecks, ...packRoles.map(item => ({ status: item.status })),
      ...graphs.map(item => ({ status: item.status }))]);
    return { packId: pack.id, version: pack.version, status, checks: packChecks, roles: packRoles.map(item => item.id), graphs };
  });
  const status = statusOf([...checks, ...packResults.map(item => ({ status: item.status })), ...projectResults.map(item => ({ status: item.status })), { status: ceo.status }]);
  return { ready: status === 'ready', status, checks, roles, packs: packResults, projects: projectResults };
}
