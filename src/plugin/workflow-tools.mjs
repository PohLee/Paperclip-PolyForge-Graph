import { createWorkflowRuntime } from '../core/workflow-runtime.mjs';

const exact = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${name} must be an exact, nonempty identity`);
  }
  return value;
};

const record = (value, name) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
};

const reference = (value) => {
  const workflow = record(value, 'workflow');
  return Object.fromEntries(['packId', 'packVersion', 'graphId', 'graphVersion']
    .map((key) => [key, exact(workflow[key], key)]));
};
const sameReference = (left, right) => ['packId', 'packVersion', 'graphId', 'graphVersion']
  .every((key) => left?.[key] === right?.[key]);

// The callback is the host's authorized command entry point. It must bind the
// invocation identity itself; nothing from params is forwarded as an actor.
export function createWorkflowRunTool({ authorizedCommand, workflow = null }) {
  if (typeof authorizedCommand !== 'function') throw new Error('Authorized workflow command callback is required');
  const fixed = workflow === null ? null : reference(workflow);
  return async (params, invocation) => {
    const value = record(params, 'workflow tool parameters');
    if (value.operation === 'start') {
      for (const key of Object.keys(value)) {
        if (!['operation', 'issueId', 'workflow', 'workflowInput', 'mode', 'idempotencyKey'].includes(key)) {
          throw new Error(`Unsupported workflow start parameter: ${key}`);
        }
      }
      const selected = fixed ?? reference(value.workflow);
      if (fixed && value.workflow !== undefined && !sameReference(reference(value.workflow), fixed)) {
        throw new Error('Workflow reference differs from the fixed tool identity');
      }
      const issueId = exact(value.issueId, 'issueId');
      if (!Object.hasOwn(value, 'workflowInput') || value.workflowInput === undefined) {
        throw new Error('workflowInput must be a JSON value');
      }
      const workflowInput = value.workflowInput;
      const result = await authorizedCommand({ operation: 'workflow-start', issueId,
        ...selected, workflowInput, ...(value.mode === undefined ? {} : { mode: value.mode }),
        ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: value.idempotencyKey }) }, invocation);
      return { handle: result.handle };
    }
    if (value.operation === 'inspect') {
      for (const key of Object.keys(value)) {
        if (!['operation', 'runId'].includes(key)) throw new Error(`Unsupported workflow inspect parameter: ${key}`);
      }
      const runId = exact(value.runId, 'runId');
      const result = await authorizedCommand({ operation: 'workflow-inspect', runId }, invocation);
      if (fixed && !sameReference(result.handle?.workflow, fixed)) {
        throw new Error('Run does not match the fixed workflow identity');
      }
      return { handle: result.handle };
    }
    throw new Error('Workflow tool operation must be start or inspect');
  };
}

export function createFixedWorkflowTool({ workflow, authorizedCommand }) {
  return createWorkflowRunTool({ workflow, authorizedCommand });
}

export function createPaperclipWorkflowToolCommand({ command, findRun }) {
  if (typeof command !== 'function' || typeof findRun !== 'function') {
    throw new Error('Authorized command and company-scoped run lookup are required');
  }
  return async (body, runCtx) => {
    const companyId = exact(runCtx?.companyId, 'authenticated companyId');
    const agentId = exact(runCtx?.agentId, 'authenticated agentId');
    const runId = exact(runCtx?.runId, 'authenticated agent runId');
    let issueId = body.issueId;
    if (body.operation === 'workflow-inspect') {
      const run = await findRun(companyId, body.runId);
      if (!run || run.input?.paperclipCompanyId !== companyId ||
          typeof run.input?.paperclipIssueId !== 'string' || !run.input.paperclipIssueId) {
        throw new Error('Workflow run is unavailable in this company');
      }
      issueId = run.input.paperclipIssueId;
    }
    return command({ companyId, issueId, body,
      hostActor: { actorType: 'agent', agentId, runId } });
  };
}

// Keep child orchestration inside the company and the trusted Pack boundary.
// Core remains authoritative for lineage, attempts, CAS and child creation.
export function createCompanyWorkflowEngine({ engine, companyId, catalog, packHostAdapters, getSetup }) {
  async function supportedRun(run) {
    if (!run || run.input?.paperclipCompanyId !== companyId) return false;
    return (await packHostAdapters.runStatus(engine, companyId, run)).available;
  }
  async function parentRun(runId) {
    const run = await engine.getRun(runId);
    if (!run || run.input?.paperclipCompanyId !== companyId) {
      throw new Error('Workflow parent run is unavailable in this company');
    }
    if (!await supportedRun(run)) throw new Error('Workflow parent trusted Pack adapter is unavailable');
    return run;
  }
  return new Proxy(engine, { get(target, property) {
    if (property === 'isHostRunSupported') return supportedRun;
    // Company plan starts retain the legacy run shape through the runtime.
    if (property === 'startRun') return async args =>
      (await createWorkflowRuntime({ engine: target }).start(args)).run;
    if (property === 'startChildWorkflow') return async args => {
      const parent = await parentRun(args.runId);
      const ref = parent.graph?.nodes?.find((item) => item.id === args.nodeId)?.workflow;
      const pack = ref && catalog.find((item) => item.id === ref.packId && item.version === ref.packVersion);
      if (!pack || !pack.graphs.some((item) => item.id === ref.graphId && item.version === ref.graphVersion)) {
        throw new Error('Exact child Pack and Graph must be installed in this company');
      }
      const setup = await getSetup();
      if (!setup.enabledPacks?.some((item) => item.packId === ref.packId && item.version === ref.packVersion)) {
        throw new Error('Child Pack version is not enabled for this company');
      }
      packHostAdapters.assertPackStart(pack, ref.graphId);
      if (packHostAdapters.resolve(pack) || packHostAdapters.requiresAdapter(pack, ref.graphId)) {
        if (!packHostAdapters.assertChildStart) throw new Error('Child workflows in adapter-governed Packs require child-start adapter binding');
        packHostAdapters.assertChildStart(pack, ref.graphId);
      }
      return target.startChildWorkflow(args);
    };
    if (property === 'reconcileChildWorkflow') return async args => {
      const parent = await parentRun(args.runId);
      const childRunId = parent.nodeStates?.[args.nodeId]?.childRunId;
      if (childRunId) {
        const child = await target.getRun(childRunId);
        const ref = parent.graph?.nodes?.find((item) => item.id === args.nodeId)?.workflow;
        if (!child || child.input?.paperclipCompanyId !== companyId ||
            child.input?.paperclipIssueId !== parent.input?.paperclipIssueId ||
            child.parentWorkflow?.runId !== parent.id || child.parentWorkflow?.nodeId !== args.nodeId ||
            child.packId !== ref?.packId || child.packVersion !== ref?.packVersion ||
            child.graph?.id !== ref?.graphId || child.graph?.version !== ref?.graphVersion) {
          throw new Error('Linked workflow child differs from the parent company, issue or exact workflow reference');
        }
        if (!await supportedRun(child)) throw new Error('Workflow child trusted Pack adapter is unavailable');
      }
      return target.reconcileChildWorkflow(args);
    };
    return Reflect.get(target, property);
  } });
}
