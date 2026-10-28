import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PLUGIN_ID = 'pohlee.polyforge-graph';

const packEntry = process.env.POLYFORGE_ADLC_PACK_ENTRY;
const pack = packEntry ? (await import(pathToFileURL(resolve(packEntry)).href)).pack : null;
const fixtureScript = process.env.POLYFORGE_FIXTURE_AGENT_SCRIPT;
const canonicalSkillKey = (id) => `plugin/${PLUGIN_ID.replace(/[^a-z0-9]+/g, '-')}/${id}`;
const managedSkills = Object.values(pack?.skills ?? {}).map((skill) => ({
  skillKey: skill.id, displayName: skill.id.replaceAll('-', ' '), slug: `adlc-${skill.id}`,
  description: `ADLC Pack ${pack.version} method: ${skill.id}`,
  markdown: skill.content,
}));
const managedAgents = Object.values(pack?.roles ?? {}).map((role) => ({
  agentKey: role.id,
  displayName: role.name,
  role: role.id,
  title: role.name,
  capabilities: role.capabilityRequirements.join(', '),
  adapterType: fixtureScript ? 'process' : 'codex_local',
  adapterPreference: fixtureScript ? ['process'] : ['codex_local', 'claude_local', 'opencode_local'],
  adapterConfig: fixtureScript ? { command: 'node', args: [fixtureScript], timeoutSec: 120 } : {
    paperclipSkillSync: { desiredSkills: role.skills.map(canonicalSkillKey) },
  },
  permissions: { pluginTools: [PLUGIN_ID] },
  status: fixtureScript ? 'idle' : 'paused',
  budgetMonthlyCents: fixtureScript ? 10000 : 0,
  instructions: {
    entryFile: 'AGENTS.md',
    content: `# ${role.name}\n\n${role.documents.instruction}`,
    files: Object.fromEntries(Object.entries(role.documents).map(([key, value]) => [`${key}.md`, value])),
  },
}));

const manifest = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: '0.3.0',
  displayName: 'PolyForge Graph',
  description: 'Versioned, auditable Graph orchestration for Paperclip agents and domain packs.',
  author: 'PohLee',
  categories: ['automation', 'ui'],
  minimumHostVersion: '2026.1023.0',
  capabilities: [
    'api.routes.register',
    'database.namespace.migrate',
    'database.namespace.read',
    'database.namespace.write',
    'issues.read',
    'issues.create',
    'issues.update',
    'issues.checkout',
    'issues.wakeup',
    'agents.read',
    'agents.invoke',
    'agents.managed',
    'skills.managed',
    'access.members.read',
    'agent.tools.register',
    'ui.page.register',
    'ui.sidebar.register',
    'ui.detailTab.register',
    'ui.action.register',
    'instance.settings.register',
  ],
  entrypoints: { worker: './dist/worker.js', ui: './dist/ui' },
  database: {
    namespaceSlug: 'polyforge_graph',
    migrationsDir: 'migrations',
    coreReadTables: ['companies', 'issues', 'agents'],
  },
  agents: managedAgents,
  skills: managedSkills,
  apiRoutes: [
    {
      routeKey: 'graph-read', method: 'GET', path: '/issues/:issueId/graph',
      auth: 'board-or-agent', capability: 'api.routes.register',
      companyResolution: { from: 'issue', param: 'issueId' },
    },
    {
      routeKey: 'graph-command', method: 'POST', path: '/issues/:issueId/graph',
      auth: 'board-or-agent', capability: 'api.routes.register',
      checkoutPolicy: 'required-for-agent-in-progress',
      companyResolution: { from: 'issue', param: 'issueId' },
    },
  ],
  tools: [{
    name: 'graph-command',
    displayName: 'PolyForge Graph command',
    description: 'Operate the assigned Graph issue using trusted Paperclip agent/run identity. Supply versioned artifacts and evidence for node work; the worker checks role, checkout, attempt, and Pack rules for each operation.',
    parametersSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string' },
        operation: { type: 'string', enum: ['start', 'record-work-decision', 'submit', 'self-review', 'review', 'decide', 'escalate', 'pause', 'resume', 'open-conflict', 'record-conflict-position', 'product-decision'] },
        graphId: { type: 'string' },
        mode: { type: 'string', enum: ['manual', 'assisted', 'autonomous'] },
        input: { type: 'object' },
        runId: { type: 'string' },
        nodeId: { type: 'string' },
        output: { type: 'object' },
        artifacts: { type: 'array', items: { type: 'object', properties: {
          kind: { type: 'string' }, id: { type: 'string' }, version: { type: 'string' },
        }, required: ['kind', 'id', 'version'] } },
        evidence: { type: 'array', items: { type: 'object', properties: {
          kind: { type: 'string' }, summary: { type: 'string' },
          sourceRef: { type: 'object', properties: {
            kind: { type: 'string', enum: ['run_input', 'product_decision', 'artifact', 'decision', 'external'] },
            key: { type: 'string' }, id: { type: 'string' }, version: { type: 'string' }, url: { type: 'string' },
          } },
        } } },
        category: { type: 'string', enum: ['product', 'engineering', 'process'] },
        question: { type: 'string' },
        ruleRef: { type: 'string' },
        behaviorImpact: { type: 'string', enum: ['none', 'changes', 'unknown'] },
        decisionIds: { type: 'array', items: { type: 'string' } },
        side: { type: 'string', enum: ['cpo', 'cto-caio'] },
        stance: { type: 'string', enum: ['go', 'modify', 'block'] },
        dimensions: { type: 'object', properties: {
          scope: { type: 'string' }, timeline: { type: 'string' }, resources: { type: 'string' },
          risk: { type: 'string' }, successCriteria: { type: 'string' },
        } },
        nonNegotiables: { type: 'array', items: { type: 'string' } },
        outcome: { type: 'string' },
        reason: { type: 'string' },
        findings: { type: 'array' },
        fixes: { type: 'array' },
        artifactVersion: { type: 'string' },
        revisedArtifact: {},
        options: { type: 'array', description: 'Work choices use {id,label}; strict conflict choices also require disposition and a targetNodeId when reworking.',
          items: { type: 'object', properties: {
            id: { type: 'string' }, label: { type: 'string' },
            disposition: { type: 'string', enum: ['continue', 'rework', 'stop'] },
            targetNodeId: { type: 'string' },
          } } },
        positions: { type: 'object', properties: { cpo: {}, cto: {} }, required: ['cpo', 'cto'] },
        positionDecisionIds: { type: 'object', properties: {
          cpo: { type: 'string' }, cto: { type: 'string' },
        }, required: ['cpo', 'cto'] },
        negotiation: { type: 'array', items: { type: 'object' } },
        unresolved: { type: 'array' },
        knownRisks: { type: 'array' },
        feature: { type: 'string' },
        status: { type: 'string' },
        supersedes: { type: 'string' },
        proposalId: { type: 'string' },
        productDecisionRefs: { type: 'array', items: { type: 'string' } },
        approvedChangeDecisionId: { type: 'string' },
        changeScope: {},
        idempotencyKey: { type: 'string' },
      },
      required: ['issueId', 'operation'],
    },
  }],
  ui: { slots: [
    { type: 'page', id: 'graph-runs', displayName: 'Graph runs', exportName: 'GraphRunsPage', routePath: 'graph-runs' },
    { type: 'sidebar', id: 'graph-navigation', displayName: 'Graph runs', exportName: 'GraphSidebarLink' },
    { type: 'detailTab', id: 'issue-graph', displayName: 'Graph', exportName: 'IssueGraphTab', entityTypes: ['issue'] },
    { type: 'taskDetailView', id: 'issue-graph-panel', displayName: 'Graph', exportName: 'IssueGraphPanel', entityTypes: ['issue'] },
    { type: 'settingsPage', id: 'graph-settings', displayName: 'Graph settings', exportName: 'GraphSettingsPage' },
  ] },
};

export default manifest;
