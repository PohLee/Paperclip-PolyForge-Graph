import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareReviewerCases, scoreReviewerCase } from '../eval/reviewer-blind.mjs';
import { waitFor } from './enhancement-client.mjs';

const saveJson = (name, value, flag = 'w') => writeFile(join(observationDirectory, name),
  `${JSON.stringify(value, null, 2)}\n`, { flag, mode: 0o600 });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readEvidence = async name => JSON.parse(await readFile(join(observationDirectory, name), 'utf8'));
const activeStatuses = new Set(['queued', 'running', 'scheduled_retry']);
const reviewerInstructions = 'Complete the assigned synthetic review independently. Use get_task_context to read the active issue description and work from its contract, diff, and test evidence. Use only the native task tools for this issue. Record the requested JSON in a task document keyed reviewer-result using the native write_document or write_task_document tool exposed in this session. Then finish the active issue via paperclip_finish. Keep the candidate unchanged.';

async function connect(clientFile) {
  assert.ok(clientFile, 'Specify the isolated Paperclip client');
  const connector = await import(pathToFileURL(resolve(clientFile)).href);
  const data = connector.api ?? (await connector.client()).data;
  assert.equal(typeof data, 'function');
  await connector.assertOwner?.();
  return { data, host: connector.base ?? null };
}

function writablePolicy(policy) {
  const { scopeType, scopeId, metric, windowKind, amount, warnPercent, hardStopEnabled, notifyEnabled, isActive,
    unpricedUsagePolicy } = policy;
  return { scopeType, scopeId, metric, windowKind, amount, warnPercent, hardStopEnabled, notifyEnabled, isActive,
    unpricedUsagePolicy };
}

async function reviewerBudget(data, { companyId, agentId }) {
  const { policies } = await data('GET', `/api/companies/${companyId}/budgets/overview`);
  assert.equal(policies.length, 1, 'The reviewer company must have only its own agent budget');
  const [policy] = policies;
  assert.equal(policy.scopeType, 'agent');
  assert.equal(policy.scopeId, agentId);
  return { policyId: policy.policyId, config: writablePolicy(policy) };
}

async function setReviewerPricing(data, receipt, value) {
  const baseline = receipt.baselineBudget;
  const current = await reviewerBudget(data, receipt);
  assert.equal(current.policyId, baseline.policyId);
  assert.deepEqual({ ...current.config, unpricedUsagePolicy: 'block' }, baseline.config,
    'Non-pricing reviewer budget settings changed');
  const desired = { ...baseline.config, unpricedUsagePolicy: value };
  if (current.config.unpricedUsagePolicy !== value) {
    await data('POST', `/api/companies/${receipt.companyId}/budgets/policies`, desired);
  }
  const applied = await reviewerBudget(data, receipt);
  assert.deepEqual(applied, { policyId: baseline.policyId, config: desired });
  return applied;
}

async function cleanupNative(data, state) {
  const receipts = state.cases.filter(item => item.agentId);
  const cleanup = await Promise.allSettled(receipts.map(async receipt => {
    const { agentId, companyId, issueId, baselineBudget } = receipt;
    const endpoint = `/api/agents/${agentId}`;
    const findRuns = async () => (await data('GET', `/api/companies/${companyId}/heartbeat-runs`))
      .filter(run => run.agentId === agentId && run.issueId === issueId && activeStatuses.has(run.status));
    const agent = await data('GET', endpoint);
    assert.equal(agent.companyId, companyId);
    const operations = await Promise.allSettled([
      baselineBudget && setReviewerPricing(data, receipt, 'block'),
      (async () => {
        if (!['paused', 'pausing'].includes(agent.lifecycleState)) await data('POST', `${endpoint}/pause`, {});
        for (const run of await findRuns()) await data('POST', `/api/heartbeat-runs/${run.id}/cancel`, {});
        await waitFor(async () => (await data('GET', endpoint)).lifecycleState === 'paused' &&
          (await findRuns()).length === 0, `paused reviewer ${agentId} with no active runs`, 30_000);
      })(),
    ]);
    return { agentId, companyId, restoredBudget: operations[0].value, paused: operations[1].status === 'fulfilled',
      errors: operations.flatMap(result => result.status === 'rejected' ? [result.reason.message] : []) };
  }));
  const records = cleanup.map((result, index) => result.status === 'fulfilled' ? result.value :
    { agentId: receipts[index].agentId, errors: [result.reason.message] });
  await saveJson('native-cleanup.json', { checkedAt: new Date().toISOString(), reviewers: records });
  assert.ok(records.every(record => record.errors.length === 0), 'Review cleanup failed; see native-cleanup.json');
}

async function stageNativeReview(clientFile, workspaceParent, model, reasoning) {
  assert.ok(posix.isAbsolute(workspaceParent ?? '') && model && reasoning,
    'Specify an empty workspace parent and the authorized model and reasoning level');
  const { data, host } = await connect(clientFile);
  const observer = await readFile(join(observationDirectory, 'observer.json'), 'utf8');
  const { cases } = JSON.parse(observer);
  const scorerSha256 = sha256(await readFile(new URL('../eval/reviewer-blind.mjs', import.meta.url)));
  const state = { stagedAt: new Date().toISOString(), host, model, reasoning,
    observerSha256: sha256(observer), scorerSha256, cases: [] };
  await saveJson('native-state.json', state, 'wx');

  try {
    await stageNativeCases(data, cases, state, workspaceParent);
  } catch (error) {
    await cleanupNative(data, state);
    throw error;
  }
  console.log(JSON.stringify(state, null, 2));
}

async function stageNativeCases(data, cases, state, workspaceParent) {
  const { model, reasoning } = state;
  for (const item of cases) {
    const prompt = await readFile(join(observationDirectory, item.id, 'review.md'), 'utf8');
    assert.equal(sha256(prompt), item.promptSha256);
    const cwd = posix.join(workspaceParent, item.id);
    const company = await data('POST', '/api/companies', { name: `Isolated invoice review ${randomUUID()}`,
      description: 'Synthetic invoice calculation review. This organization contains one evaluation task.' });
    const receipt = { caseId: item.id, companyId: company.id, cwd };
    state.cases.push(receipt);
    await saveJson('native-state.json', state);
    const companyPath = `/api/companies/${company.id}`;
    const project = await data('POST', `${companyPath}/projects`, { name: 'Invoice calculation review' });
    receipt.projectId = project.id;
    const workspace = await data('POST', `/api/projects/${project.id}/workspaces`, {
      name: 'Empty review workspace', cwd, sourceType: 'local_path', isPrimary: true });
    assert.equal(workspace.isPrimary, true);
    const adapterConfig = { provider: 'codex', model, modelReasoningEffort: reasoning, cwd,
      codexPermissionMode: 'never', lifecycleMode: 'per_turn', timeoutSec: 240 };
    const agent = await data('POST', `${companyPath}/agents`, { name: 'Independent reviewer', role: 'general',
      adapterType: 'paperclip_runner', adapterConfig, budgetMonthlyCents: 100,
      instructionsBundle: { entryFile: 'AGENTS.md', files: { 'AGENTS.md': reviewerInstructions } } });
    receipt.agentId = agent.id;
    await saveJson('native-state.json', state);
    assert.equal(agent.adapterType, 'paperclip_runner');
    assert.equal(agent.adapterConfig.model, model);
    assert.equal(agent.adapterConfig.codexPermissionMode, 'never');
    await data('POST', `${companyPath}/budgets/policies`, { scopeType: 'agent', scopeId: agent.id, amount: 100,
      windowKind: 'calendar_month_utc', hardStopEnabled: true, isActive: true, unpricedUsagePolicy: 'block' });
    const budget = await reviewerBudget(data, receipt);
    assert.ok(budget.config.isActive && budget.config.hardStopEnabled && budget.config.amount === 100 &&
      budget.config.unpricedUsagePolicy === 'block',
      'The isolated reviewer hard stop and ordinary unpriced-usage policy must be active before dispatch');
    receipt.baselineBudget = budget;
    await saveJson('native-state.json', state);
    const issue = await data('POST', `${companyPath}/issues`, { projectId: project.id, title: 'Review invoice amount change',
      description: prompt, status: 'backlog', priority: 'low' });
    receipt.issueId = issue.id;
    receipt.issue = issue.identifier;
    await saveJson('native-state.json', state);
    assert.equal(issue.description, prompt);
    assert.equal(issue.status, 'backlog');
    assert.equal(issue.assigneeAgentId, null);
    assert.equal((await data('GET', `${companyPath}/heartbeat-runs`)).length, 0);
  }
}

async function loadNativeTrial(clientFile) {
  const { data, host } = await connect(clientFile);
  const state = await readEvidence('native-state.json');
  assert.equal(state.host, host);
  const observer = await readFile(join(observationDirectory, 'observer.json'), 'utf8');
  assert.equal(sha256(observer), state.observerSha256);
  assert.equal(sha256(await readFile(new URL('../eval/reviewer-blind.mjs', import.meta.url))), state.scorerSha256);
  const { cases } = JSON.parse(observer);
  assert.deepEqual(state.cases.map(item => item.caseId), cases.map(item => item.id));
  return { data, state, cases };
}

async function nativeReview(clientFile) {
  const { data, state, cases } = await loadNativeTrial(clientFile);
  await saveJson('native-start.json', { startedAt: new Date().toISOString() }, 'wx');

  try {
    for (const receipt of state.cases) {
      const issue = await data('GET', `/api/issues/${receipt.issueId}`);
      assert.equal(issue.companyId, receipt.companyId);
      assert.equal(issue.status, 'backlog');
      assert.equal(issue.assigneeAgentId, null);
      assert.equal(sha256(issue.description), cases.find(item => item.id === receipt.caseId).promptSha256);
      assert.equal((await data('GET', `/api/companies/${receipt.companyId}/heartbeat-runs`)).length, 0);
      await saveJson(`${receipt.caseId}/native-budget-temporary.json`, await setReviewerPricing(data, receipt, 'allow'));
    }
    for (const { issueId, agentId } of state.cases) {
      await data('PATCH', `/api/issues/${issueId}`, { status: 'todo', assigneeAgentId: agentId });
    }
    await collectNativeCases(data, cases, state);
  } finally {
    await cleanupNative(data, state);
  }
}

async function collectNativeCases(data, cases, state, { file = 'native-scores.json', recordedRuns = {} } = {}) {
  const { model, reasoning } = state;
  const results = await Promise.allSettled(cases.map(item => collectNativeReview(data, item,
    state.cases.find(({ caseId }) => caseId === item.id), { model, reasoning, expectedHeartbeatId: recordedRuns[item.id] })));
  const scores = results.map((result, index) => result.status === 'fulfilled' ? result.value :
    { id: cases[index].id, valid: false, reason: result.reason.message });
  const providerSessions = scores.map(score => score.providerSessionId);
  const distinctProviderSessions = providerSessions.every(Boolean) && new Set(providerSessions).size === cases.length;
  const report = { surface: 'isolated Paperclip native Codex reviewer', host: state.host, model, reasoning,
    distinctProviderSessions, results: scores, evaluated: scores.filter(score => score.valid).length,
    missedDefects: scores.filter(score => score.missedDefect).length,
    falsePositives: scores.filter(score => score.falsePositive).length,
    missingDecisionCitations: scores.filter(score => score.valid && !score.citedDecision).length,
    passed: distinctProviderSessions && scores.every(score => score.passed) };
  await saveJson(file, report, 'wx');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

async function observeNativeReview(clientFile) {
  const { data, state, cases } = await loadNativeTrial(clientFile);
  const initial = await readEvidence('native-scores.json');
  const recordedRuns = Object.fromEntries(await Promise.all(cases.map(async ({ id }) => {
    const evidence = await readEvidence(`${id}/native-receipt.json`);
    assert.ok(evidence.heartbeatId, 'The original collection must bind a heartbeat for each case');
    return [id, evidence.heartbeatId];
  })));
  await saveJson('native-observation-recheck.json', { at: new Date().toISOString(), originalReport: 'native-scores.json',
    initialScores: initial.results, recordedRuns, scorerSha256: state.scorerSha256 }, 'wx');
  await collectNativeCases(data, cases, state, { file: 'native-scores-verified.json', recordedRuns });
}

async function collectNativeReview(data, item, receipt, { model, reasoning, expectedHeartbeatId }) {
  const { companyId, agentId, issueId } = receipt;
  const heartbeatId = await waitFor(async () => {
    const runs = await data('GET', `/api/companies/${companyId}/heartbeat-runs`);
    const matches = runs.filter(run => run.agentId === agentId && run.issueId === issueId);
    assert.ok(matches.length <= 1, 'Retried or overlapping reviewer session');
    return matches[0]?.id;
  }, `initial reviewer heartbeat for ${item.id}`, 60_000);
  if (expectedHeartbeatId) assert.equal(heartbeatId, expectedHeartbeatId);
  const endpoint = `/api/heartbeat-runs/${heartbeatId}`;
  const heartbeat = await waitFor(async () => {
    const run = await data('GET', endpoint);
    return ['succeeded', 'failed', 'cancelled', 'timed_out', 'blocked'].includes(run.status) && run;
  }, `terminal reviewer heartbeat for ${item.id}`, 300_000);
  const usage = heartbeat.usageJson ?? {};
  const nativeInput = heartbeat.runnerProfileJson?.nativeExecutionInput;
  const provider = nativeInput?.provider;
  const nativePromptSha256 = typeof nativeInput?.task?.description === 'string' ? sha256(nativeInput.task.description) : null;
  const evidence = { ...receipt, heartbeatId, status: heartbeat.status, errorCode: heartbeat.errorCode,
    startedAt: heartbeat.startedAt, finishedAt: heartbeat.finishedAt, nativeSessionId: heartbeat.nativeSessionId,
    sessionIdBefore: heartbeat.sessionIdBefore, sessionIdAfter: heartbeat.sessionIdAfter,
    providerSessionId: usage.persistedSessionId, actualModel: usage.model, provider: usage.provider,
    runnerReasoningEffort: provider?.reasoningEffort, runnerApprovalPolicy: provider?.approvalPolicy, nativePromptSha256,
    freshSession: usage.freshSession, sessionReused: usage.sessionReused,
    taskSessionReused: usage.taskSessionReused, runtimeMode: heartbeat.runtimeMode, driver: heartbeat.driverKind,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, billingType: usage.billingType,
    costStatus: usage.costStatus, costUsd: usage.costUsd ?? null };
  await saveJson(`${item.id}/native-receipt.json`, evidence);
  assert.equal(heartbeat.companyId, companyId);
  assert.equal(heartbeat.agentId, agentId);
  assert.equal(heartbeat.issueId, issueId);
  assert.equal(heartbeat.status, 'succeeded', `Reviewer heartbeat ${heartbeatId} ended ${heartbeat.status}`);
  assert.equal(heartbeat.runtimeMode, 'native');
  assert.equal(heartbeat.driverKind, 'codex_app_server');
  assert.equal(nativePromptSha256, item.promptSha256, 'Native reviewer did not receive the exact prepared evidence packet');
  assert.equal(usage.model, model, 'Provider accounting did not record the authorized model');
  assert.equal(provider?.reasoningEffort, reasoning, 'Runner did not pin the authorized reasoning level');
  assert.equal(usage.freshSession, true);
  assert.equal(usage.sessionReused, false);
  assert.equal(usage.taskSessionReused, false);

  const tools = [], toolStarts = [], instructionCalls = [], instructionResults = new Map();
  for (let cursor = 0; ;) {
    const events = await data('GET', `${endpoint}/events?limit=200&afterSeq=${cursor}`);
    for (const event of events) {
      const payload = event.payload?.prpEvent?.payload ?? event.payload ?? {};
      const call = payload.item;
      if (event.eventType === 'item.started' && call?.type === 'tool_use' && call.name === 'read_agent_instructions') {
        instructionCalls.push({ seq: event.seq, id: call.id, input: call.input });
      }
      if (event.eventType === 'item.completed' && call?.type === 'tool_result') {
        instructionResults.set(call.tool_use_id, call.result);
      }
      if (['tool.execution.started', 'tool.execution.completed'].includes(event.eventType)) {
        const name = /^[a-z][a-z0-9_.-]*$/i.test(payload.name ?? '') ? payload.name : 'unrecognized-tool';
        const list = event.eventType === 'tool.execution.started' ? toolStarts : tools;
        list.push({ seq: event.seq, at: event.createdAt, name, status: payload.status });
      }
    }
    if (events.length < 200) break;
    assert.ok(events.at(-1).seq > cursor, 'Native event pagination did not advance');
    cursor = events.at(-1).seq;
  }
  await saveJson(`${item.id}/native-tools.json`, tools);
  await saveJson(`${item.id}/native-tool-starts.json`, toolStarts);
  assert.ok(tools.some(({ name, status }) => name === 'paperclip_finish' && status === 'completed'),
    'Native reviewer did not complete the assigned issue');
  const taskTools = new Set(['get_task_context', 'list_documents', 'list_task_documents',
    'write_document', 'write_task_document', 'paperclip_finish', 'read_agent_instructions']);
  assert.ok([...tools, ...toolStarts].every(({ name }) => taskTools.has(name)),
    'Reviewer used a tool outside the isolated task scope');
  assert.equal(instructionCalls.length, toolStarts.filter(({ name }) => name === 'read_agent_instructions').length);
  const instructions = instructionCalls.map(call => {
    const result = instructionResults.get(call.id);
    assert.ok(call.input && Object.keys(call.input).every(key => key === 'targetAgentId') &&
      (call.input.targetAgentId === undefined || call.input.targetAgentId === agentId), 'Instruction read was not self-scoped');
    assert.equal(result?.entryFile, 'AGENTS.md');
    assert.equal(result.revision?.agentId, agentId);
    assert.equal(result.revision?.companyId, companyId);
    assert.equal(result.content, reviewerInstructions, 'Reviewer instructions differed from the neutral staged brief');
    assert.equal(result.revision.contentHash, sha256(result.content));
    return { callSeq: call.seq, callId: call.id, input: call.input, entryFile: result.entryFile,
      agentId, companyId, revisionId: result.revision.id, contentSha256: result.revision.contentHash };
  });
  await saveJson(`${item.id}/native-instruction-scope.json`, instructions);

  const documents = await data('GET', `/api/issues/${issueId}/documents`);
  const reply = documents.find(document => document.key === 'reviewer-result' && document.createdByAgentId === agentId);
  assert.ok(reply?.body, 'Reviewer did not author the requested native task document');
  await writeFile(join(observationDirectory, item.id, 'reviewer-reply.json'), reply.body);
  await saveJson(`${item.id}/native-receipt.json`, { ...evidence, replyDocumentId: reply.id,
    replyRevisionId: reply.latestRevisionId, replySha256: sha256(reply.body) });
  return { ...scoreReviewerCase(item, reply.body), heartbeatId, providerSessionId: usage.persistedSessionId };
}

const [action, evidenceDirectory, ...args] = process.argv.slice(2);
if (!evidenceDirectory || !['prepare', 'stage-native', 'native', 'observe-native', 'cleanup'].includes(action)) {
  throw new Error('Usage: node scripts/eval-reviewer-blind.mjs prepare EVIDENCE_DIRECTORY [DECISION_REF] | stage-native EVIDENCE_DIRECTORY CLIENT_MODULE EMPTY_WORKSPACE_PARENT MODEL REASONING | {native,observe-native,cleanup} EVIDENCE_DIRECTORY CLIENT_MODULE');
}
const observationDirectory = resolve(evidenceDirectory);
if (action === 'prepare') {
  const [decisionRef] = args;
  const cases = await prepareReviewerCases(observationDirectory, { decisionRef });
  console.log(JSON.stringify({ prepared: cases.map(({ id, promptSha256 }) => ({ id, promptSha256 })) }));
} else if (action === 'stage-native') {
  await stageNativeReview(...args);
} else if (action === 'native') {
  await nativeReview(...args);
} else if (action === 'observe-native') {
  await observeNativeReview(...args);
} else {
  const { data, host } = await connect(args[0]);
  const state = await readEvidence('native-state.json');
  assert.equal(state.host, host);
  await cleanupNative(data, state);
}
