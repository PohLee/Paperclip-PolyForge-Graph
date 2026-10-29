import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCompanyReadiness } from '../../src/plugin/readiness.mjs';

const pack = { id: 'sample', version: '1.0.0', roles: { maker: { id: 'maker' } },
  compatibility: { coreRange: '>=0.8.0 <0.9.0', requiredCapabilities: { 'company-control': '>=1.0.0 <2.0.0' } },
  graphs: [{ id: 'build', version: '1', start: 'work', nodes: [{ id: 'work', type: 'task', role: 'maker' }], edges: [] }] };
const setup = { organization: { board: { id: 'board' }, ceo: { id: 'ceo' },
  domainHeads: [{ domain: 'delivery', agentId: 'maker' }] }, enabledPacks: [{ packId: 'sample', version: '1.0.0' }], ready: true };
const config = { roleBindings: { ceo: 'ceo', 'sample:maker': 'maker' }, defaultMode: 'manual' };
const processAgent = id => ({ id, status: 'idle', adapterType: 'process',
  adapterConfig: { command: 'node', env: { SECRET: 'must-not-expose' } },
  budgetMonthlyCents: 1000, spentMonthlyCents: 0 });
const project = { id: 'project', name: 'Project', status: 'active', archivedAt: null,
  primaryWorkspace: { sourceType: 'git_repo', repoUrl: 'https://example.test/private.git', cwd: '/private/path' },
  codebase: { repoUrl: 'https://example.test/private.git', effectiveLocalFolder: '/private/path' } };
const input = { setup, packs: [pack], config, agents: [processAgent('ceo'), processAgent('maker')],
  projects: [project], capabilities: {} };

test('synthetic process fixture reports ready with explicit synthetic label and no secrets', () => {
  const result = assessCompanyReadiness(input);
  assert.equal(result.ready, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.packs[0].graphs[0].status, 'ready');
  assert.equal(result.roles.find(role => role.id === 'sample:maker').synthetic, true);
  assert.doesNotMatch(JSON.stringify(result), /must-not-expose|private\.git|private\/path/);
});

test('structural setup flag cannot hide zero budget, absent model, or missing repository', () => {
  const result = assessCompanyReadiness({ ...input,
    agents: [{ ...processAgent('ceo'), budgetMonthlyCents: 0 },
      { id: 'maker', status: 'paused', adapterType: 'codex_local', adapterConfig: {},
        budgetMonthlyCents: 0, spentMonthlyCents: 0 }],
    projects: [{ ...project, primaryWorkspace: null, codebase: { effectiveLocalFolder: '/private/path' } }] });
  assert.equal(result.ready, false);
  assert.equal(result.packs[0].graphs[0].status, 'blocked');
  assert.ok(result.roles.find(role => role.id === 'sample:maker').checks.some(item => item.id === 'model' && item.status === 'blocked'));
  assert.ok(result.roles.find(role => role.id === 'sample:maker').checks.some(item => item.id === 'budget' && item.status === 'blocked'));
  assert.ok(result.projects[0].checks.some(item => item.id === 'repository' && item.status === 'blocked'));
});

test('configured real model stays unknown without verified credential availability', () => {
  const agents = [processAgent('ceo'), { ...processAgent('maker'), adapterType: 'codex_local',
    adapterConfig: { model: 'gpt-6-sol', env: { TOKEN: 'secret' } } }];
  const result = assessCompanyReadiness({ ...input, agents });
  assert.equal(result.status, 'unknown');
  assert.equal(result.ready, false);
  assert.equal(result.packs[0].graphs[0].status, 'unknown');
  assert.ok(result.roles.find(role => role.id === 'sample:maker').checks.some(item => item.id === 'provider' && item.status === 'unknown'));
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('Graph capability and decision mode failures are scoped to the affected Graph', () => {
  const gated = { ...pack, graphs: [...pack.graphs, { ...pack.graphs[0], id: 'measure',
    compatibility: { requiredCapabilities: { 'sourced-metrics': '>=1.0.0 <2.0.0' } } }] };
  const result = assessCompanyReadiness({ ...input, packs: [gated] });
  assert.equal(result.packs[0].graphs.find(graph => graph.graphId === 'build').status, 'ready');
  assert.equal(result.packs[0].graphs.find(graph => graph.graphId === 'measure').status, 'blocked');
  assert.match(result.packs[0].graphs.find(graph => graph.graphId === 'measure').checks[0].reason, /sourced-metrics/);
  const wrongMode = assessCompanyReadiness({ ...input, config: { ...config, defaultMode: '' } });
  assert.equal(wrongMode.ready, false);
  assert.ok(wrongMode.checks.some(item => item.id === 'decision-mode' && item.status === 'blocked'));
});

test('missing workspace read permission is unknown rather than an invented absent workspace', () => {
  const result = assessCompanyReadiness({ ...input, projects: [{ ...project,
    primaryWorkspace: null, codebase: { repoUrl: 'https://example.test/private.git' },
    workspaceReadError: 'permission denied: private details' }] });
  assert.equal(result.projects[0].status, 'unknown');
  assert.equal(result.status, 'unknown');
  assert.ok(result.projects[0].checks.some(item => item.id === 'workspace' && item.status === 'unknown'));
  assert.doesNotMatch(JSON.stringify(result), /permission denied|private details/);
});

test('a codebase path alone does not prove a primary workspace is configured', () => {
  const result = assessCompanyReadiness({ ...input, projects: [{ ...project, primaryWorkspace: null }] });
  assert.equal(result.projects[0].status, 'blocked');
  assert.ok(result.projects[0].checks.some(item => item.id === 'workspace' && item.status === 'blocked'));
});
