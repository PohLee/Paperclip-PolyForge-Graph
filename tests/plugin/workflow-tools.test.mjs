import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../../src/plugin/manifest.mjs';
import { createWorkflowRunTool, createFixedWorkflowTool,
  createPaperclipWorkflowToolCommand, createCompanyWorkflowEngine } from '../../src/plugin/workflow-tools.mjs';

const workflow = { packId: 'planning', packVersion: '2.0.0', graphId: 'triage', graphVersion: '3' };
const invocation = { companyId: 'company-a', agentId: 'agent-a', runId: 'native-run-a' };

test('workflow-run is a static official SDK tool declaration', () => {
  const declared = manifest.tools.find((tool) => tool.name === 'workflow-run');
  assert.ok(declared);
  assert.equal(manifest.capabilities.includes('agent.tools.register'), true);
  assert.equal(declared.parametersSchema.properties.operation.enum.includes('inspect'), true);
  assert.deepEqual(declared.parametersSchema.properties.workflow.required,
    ['packId', 'packVersion', 'graphId', 'graphVersion']);
  assert.equal(declared.parametersSchema.properties.workflowInput.type, undefined);
});

test('workflow tool forwards scalar, array and null JSON inputs without object coercion', async () => {
  const received = [];
  const tool = createFixedWorkflowTool({ workflow, authorizedCommand: async body => {
    received.push(body.workflowInput);
    return { handle: { runId: 'run-a', workflow, status: 'running' } };
  } });
  for (const workflowInput of [null, 'request', 12, false, ['a', 2]]) {
    await tool({ operation: 'start', issueId: 'issue-a', workflowInput }, invocation);
  }
  assert.deepEqual(received, [null, 'request', 12, false, ['a', 2]]);
  await assert.rejects(tool({ operation: 'start', issueId: 'issue-a' }, invocation), /JSON value/);
});

test('tool start forwards exact identity and business input only to the authorized command', async () => {
  const calls = [];
  const tool = createWorkflowRunTool({ authorizedCommand: async (body, context) => {
    calls.push({ body, context });
    return { handle: { runId: 'run-a', status: 'waiting_for_human', workflow } };
  } });
  assert.deepEqual(await tool({ operation: 'start', issueId: 'issue-a', workflow,
    workflowInput: { request: 'Review' }, mode: 'assisted', idempotencyKey: 'once' }, invocation),
  { handle: { runId: 'run-a', status: 'waiting_for_human', workflow } });
  assert.deepEqual(calls, [{ body: { operation: 'workflow-start', issueId: 'issue-a', ...workflow,
    workflowInput: { request: 'Review' }, mode: 'assisted', idempotencyKey: 'once' }, context: invocation }]);
  await assert.rejects(tool({ operation: 'start', issueId: 'issue-a', workflow: { ...workflow, graphVersion: '' },
    workflowInput: {} }, invocation), /exact/);
  await assert.rejects(tool({ operation: 'start', issueId: 'issue-a', workflow,
    workflowInput: {}, actor: { id: 'forged' } }, invocation), /Unsupported/);
  assert.equal(calls.length, 1);
});

test('inspect uses authorized command and fixed wrapper rejects mismatched identities', async () => {
  const calls = [];
  const reordered = { graphVersion: '3', graphId: 'triage', packVersion: '2.0.0', packId: 'planning' };
  const fixed = createFixedWorkflowTool({ workflow, authorizedCommand: async (body, context) => {
    calls.push({ body, context });
    return { handle: { runId: 'run-a', status: 'completed', workflow: reordered, output: { accepted: true } } };
  } });
  assert.deepEqual(await fixed({ operation: 'inspect', runId: 'run-a' }, invocation),
    { handle: { runId: 'run-a', status: 'completed', workflow: reordered, output: { accepted: true } } });
  assert.deepEqual(calls, [{ body: { operation: 'workflow-inspect', runId: 'run-a' }, context: invocation }]);
  await assert.rejects(fixed({ operation: 'start', issueId: 'issue-a',
    workflow: { ...workflow, graphId: 'other' }, workflowInput: {} }, invocation), /differs/);
  await assert.rejects(fixed({ operation: 'inspect', runId: 'run-a', companyId: 'other' }, invocation), /Unsupported/);
});

test('Paperclip adapter derives actor from invocation and refuses foreign or unavailable runs', async () => {
  const calls = [];
  let found = { id: 'run-a', input: { paperclipCompanyId: 'company-a', paperclipIssueId: 'issue-root' } };
  const authorizedCommand = createPaperclipWorkflowToolCommand({
    command: async (args) => { calls.push(args); return { handle: { runId: 'run-a', workflow } }; },
    findRun: async () => found,
  });
  const tool = createWorkflowRunTool({ authorizedCommand });
  await tool({ operation: 'inspect', runId: 'run-a' }, invocation);
  assert.deepEqual(calls[0], { companyId: 'company-a', issueId: 'issue-root',
    body: { operation: 'workflow-inspect', runId: 'run-a' },
    hostActor: { actorType: 'agent', agentId: 'agent-a', runId: 'native-run-a' } });
  found = { ...found, input: { ...found.input, paperclipCompanyId: 'company-b' } };
  await assert.rejects(tool({ operation: 'inspect', runId: 'run-a' }, invocation), /unavailable/);
  found = null;
  await assert.rejects(tool({ operation: 'inspect', runId: 'missing' }, invocation), /unavailable/);
  await assert.rejects(tool({ operation: 'inspect', runId: 'run-a' },
    { ...invocation, agentId: null }), /authenticated agentId/);
  assert.equal(calls.length, 1);
});

test('company engine fences child start and reconcile before Core mutation', async () => {
  const calls = [];
  const parent = { id: 'parent', input: { paperclipCompanyId: 'company-a', paperclipIssueId: 'issue-a' },
    graph: { nodes: [{ id: 'call', workflow }] }, nodeStates: { call: { childRunId: 'child' } } };
  const child = { id: 'child', input: { paperclipCompanyId: 'company-a', paperclipIssueId: 'issue-a' },
    packId: 'planning', packVersion: '2.0.0', graph: { id: 'triage', version: '3' },
    parentWorkflow: { runId: 'parent', nodeId: 'call', attempt: 1 } };
  const raw = { startRun: async () => parent, getRun: async id => id === 'parent' ? parent : child,
    startChildWorkflow: async args => { calls.push(['start', args]); return child; },
    reconcileChildWorkflow: async args => { calls.push(['reconcile', args]); return parent; } };
  let adapterAvailable = true, governed = false, enabled = true;
  const adapters = { runStatus: async () => ({ available: adapterAvailable }),
    assertPackStart() {}, resolve: () => governed ? {} : null, requiresAdapter: () => governed };
  const engine = createCompanyWorkflowEngine({ engine: raw, companyId: 'company-a',
    catalog: [{ id: 'planning', version: '2.0.0', graphs: [{ id: 'triage', version: '3' }] }],
    packHostAdapters: adapters,
    getSetup: async () => ({ enabledPacks: enabled ? [{ packId: 'planning', version: '2.0.0' }] : [] }) });
  await engine.startChildWorkflow({ runId: 'parent', nodeId: 'call' });
  await engine.reconcileChildWorkflow({ runId: 'parent', nodeId: 'call' });
  assert.deepEqual(calls.map(([operation]) => operation), ['start', 'reconcile']);
  parent.input.paperclipCompanyId = 'company-b';
  await assert.rejects(engine.startChildWorkflow({ runId: 'parent', nodeId: 'call' }), /unavailable in this company/);
  await assert.rejects(engine.reconcileChildWorkflow({ runId: 'parent', nodeId: 'call' }), /unavailable in this company/);
  parent.input.paperclipCompanyId = 'company-a';
  enabled = false;
  await assert.rejects(engine.startChildWorkflow({ runId: 'parent', nodeId: 'call' }), /not enabled/);
  enabled = true; governed = true;
  await assert.rejects(engine.startChildWorkflow({ runId: 'parent', nodeId: 'call' }), /adapter-governed/);
  governed = false; adapterAvailable = false;
  await assert.rejects(engine.startChildWorkflow({ runId: 'parent', nodeId: 'call' }), /parent trusted Pack adapter/);
  adapterAvailable = true; child.input.paperclipCompanyId = 'company-b';
  await assert.rejects(engine.reconcileChildWorkflow({ runId: 'parent', nodeId: 'call' }), /differs from the parent/);
  child.input.paperclipCompanyId = 'company-a'; child.graph.id = 'other';
  await assert.rejects(engine.reconcileChildWorkflow({ runId: 'parent', nodeId: 'call' }), /exact workflow reference/);
  assert.equal(calls.length, 2);
});
