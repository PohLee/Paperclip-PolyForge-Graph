import { PaperclipStore, getDispatch, claimDispatch, claimDispatchWakeup, bindDispatchRunFromCheckout, updateDispatch, getDispatchForIssue, listGraphCompanies } from './store.mjs';
import { contextInventory, reviewPacket } from './review-context.mjs';

export function pinnedGoalMarkdown(run) {
  const revisions = run.goalContext?.revisions ?? [];
  const lines = [`# GOAL.md`, '', `Graph run: ${run.id}`, `Captured: ${run.goalContext?.capturedAt ?? 'unknown'}`, ''];
  if (!revisions.length) lines.push('No company or agent goals were active when this run started.');
  for (const revision of revisions) {
    lines.push(`## ${revision.scope} goals · ${revision.subjectId}`, '',
      `Revision: ${revision.id} (version ${revision.version})`, '');
    for (const goal of revision.goals ?? []) {
      lines.push(`### ${goal.title}`, '', `Goal ID: ${goal.id}`,
        ...(goal.parentGoalId ? [`Parent goal: ${goal.parentGoalId}`] : []), '');
      for (const kr of goal.keyResults ?? []) lines.push(
        `- ${kr.id}: target ${kr.target} ${kr.unit}; baseline ${kr.baseline ?? 'unknown'}; source ${kr.source}; window ${kr.window}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function createDispatch(host, engineFor, getGraphConfig, persistence = {
  get: (...args) => getDispatch(host.db, ...args),
  claim: (...args) => claimDispatch(host.db, ...args),
  wakeClaim: (...args) => claimDispatchWakeup(host.db, ...args),
  bindRun: (...args) => bindDispatchRunFromCheckout(host.db, ...args),
  update: (...args) => updateDispatch(host.db, ...args),
  forIssue: (...args) => getDispatchForIssue(host.db, ...args),
  companies: () => listGraphCompanies(host.db),
  readState: (companyId) => new PaperclipStore(host.db, companyId).read(),
}, shadowRuntime = null) {
  const errorMessage = (error) => error instanceof Error ? error.message : String(error);
  async function assertIssue(companyId, issueId) {
    const issue = await host.issues.get(issueId, companyId);
    if (!issue) throw new Error('Paperclip issue not found in company');
    return issue;
  }
  function callbackKey(operation, runId, nodeId, idempotencyKey) {
    const prefix = { submit: 'node', 'self-review': 'self', review: 'review',
      decide: 'decide', escalate: 'escalate', 'record-work-decision': 'work-decision',
      'record-conflict-position': 'conflict-position' }[operation];
    return prefix && idempotencyKey ? `${prefix}:${runId}:${nodeId}:${idempotencyKey}` : null;
  }

  async function assertAgentCallback({ companyId, issueId, run, actor, nodeId, operation, idempotencyKey }) {
    let dispatch = await persistence.forIssue(companyId, issueId, run.id, nodeId);
    if (!dispatch || dispatch.agent_id !== actor.id) throw new Error('Agent is not bound to this Graph node issue');
    const nodeState = run.nodeStates[nodeId];
    if (!nodeState) throw new Error('Graph node not found for agent callback');
    const expectedPhase = operation === 'review' ? 'supervisor' : 'work';
    const expectedAttempt = ['review', 'self-review'].includes(operation) || nodeState.status !== 'pending'
      ? nodeState.attempts.length : nodeState.attempts.length + 1;
    const currentAttempt = dispatch.phase === expectedPhase && dispatch.attempt === expectedAttempt;
    if (!currentAttempt) {
      const key = callbackKey(operation, run.id, nodeId, idempotencyKey);
      const state = key ? await persistence.readState(companyId) : null;
      if (!key || !Object.hasOwn(state?.idempotency ?? {}, key)) {
        throw new Error('Stale Graph attempt or wrong dispatch phase');
      }
    }
    let checkoutVerified = false;
    if (currentAttempt && dispatch.state === 'waking' && !dispatch.agent_run_id) {
      // The host can start a checked-out run before requestWakeup returns its ID.
      // Its trusted checkout is the only alternate source allowed to pin that ID.
      const checkout = await host.issues.assertCheckoutOwner({
        issueId, companyId, actorAgentId: actor.id, actorRunId: actor.executionId,
      });
      if (checkout?.checkoutRunId !== actor.executionId || checkout?.assigneeAgentId !== actor.id) {
        throw new Error('Paperclip checkout does not identify this Graph agent run');
      }
      checkoutVerified = true;
      await persistence.bindRun(companyId, run.id, nodeId, dispatch.attempt, dispatch.phase,
        issueId, actor.id, actor.executionId);
      dispatch = await persistence.forIssue(companyId, issueId, run.id, nodeId);
    }
    if (!dispatch?.agent_run_id || dispatch.agent_run_id !== actor.executionId || dispatch.state !== 'woken') {
      throw new Error('Paperclip agent run does not match the Graph dispatch');
    }
    const pinnedNode = run.graph.nodes.find((item) => item.id === nodeId);
    const dispatchRole = dispatch.phase === 'supervisor' ? pinnedNode?.review?.supervisorRole : pinnedNode?.role;
    if (dispatchRole && !actor.roles.includes(dispatchRole)) actor.roles.push(dispatchRole);
    if (!checkoutVerified) await host.issues.assertCheckoutOwner({
      issueId, companyId, actorAgentId: actor.id, actorRunId: actor.executionId,
    });
  }
  function rolePrompt(pack, roleId) {
    const role = pack.roles?.[roleId];
    if (!role) throw new Error(`Pack role ${roleId} is missing`);
    const docs = role.documents ?? {};
    return ['soul', 'role', 'goal', 'instruction', 'decision_model']
      .filter((name) => docs[name])
      .map((name) => `## ${name}.md\n\n${docs[name]}`)
      .join('\n\n');
  }

  function bounded(value, depth = 0) {
    if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}… [truncated; fetch Graph run for full value]` : value;
    if (Array.isArray(value)) return value.slice(0, 40).map((item) => bounded(item, depth + 1));
    if (value && typeof value === 'object') {
      if (depth >= 6) return '[nested content omitted; fetch Graph run]';
      return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, bounded(item, depth + 1)]));
    }
    return value;
  }

  async function dispatchContext(engine, run, node, phase) {
    const cleanReview = reviewPacket(run, node.id, phase);
    if (cleanReview) return JSON.stringify(bounded(cleanReview), null, 2);
    const upstream = new Set();
    const pending = [node.id];
    while (pending.length) {
      const current = pending.pop();
      for (const edge of run.graph.edges.filter((item) => item.to === current)) {
        if (upstream.has(edge.from)) continue;
        upstream.add(edge.from); pending.push(edge.from);
      }
    }
    if (phase === 'supervisor') upstream.add(node.id);
    const priorWork = [...upstream].filter((id) => ['completed', 'awaiting_supervisor_review'].includes(run.nodeStates[id]?.status))
      .map((id) => {
        const state = run.nodeStates[id];
        const attempt = state.attempts?.at(-1);
        return { nodeId: id, status: state.status, artifacts: state.artifacts ?? attempt?.artifacts ?? [],
          output: attempt?.output ?? null, evidence: attempt?.evidence ?? [],
          decisionIds: attempt?.decisionIds ?? [],
          selfReviews: phase === 'supervisor' && id === node.id ? attempt?.selfReviews ?? [] : undefined };
      });
    const productMemory = run.input.feature ? await engine.getProductMemory(run.input.feature) : null;
    const resolutionIds = new Set(run.conflicts.filter((item) => item.status === 'resolved' && item.resolutionDecisionId)
      .map((item) => item.resolutionDecisionId));
    const humanResolutions = resolutionIds.size ? (await engine.listDecisions({ runId: run.id }))
      .filter((item) => resolutionIds.has(item.id)) : [];
    return JSON.stringify(bounded({
      pack: { id: run.packId, version: run.packVersion }, graph: { id: run.graph.id, version: run.graph.version },
      node, mode: run.mode, startInput: Object.fromEntries(Object.entries(run.input).filter(([key]) => key !== 'goalContext')),
      goalContext: run.goalContext, priorWork, productMemory, humanResolutions,
      decisionRule: node.type === 'decision' ? run.pack.decisionRules?.find((rule) =>
        rule.type === (node.decisionType ?? node.id) && rule.mode === run.mode) : null,
    }), null, 2);
  }

  async function dispatchNode(companyId, engine, run, node, config, phase) {
    const agentRole = phase === 'supervisor' ? node.review.supervisorRole : node.role;
    const nodeState = run.nodeStates[node.id];
    const attempt = phase === 'supervisor' ? nodeState.attempts.length : nodeState.attempts.length + 1;
    const originId = `${run.id}:${node.id}:${attempt}:${phase}`;
    const existing = await persistence.get(companyId, run.id, node.id, attempt, phase);
    if (existing?.issue_id && existing.agent_id &&
      (existing.state === 'waking' || (existing.state === 'woken' && existing.agent_run_id))) {
      return { nodeId: node.id, phase, status: existing.state, issueId: existing.issue_id,
        agentId: existing.agent_id, agentRunId: existing.agent_run_id };
    }
    let agentId = existing?.agent_id ?? config.roleBindings[`${run.packId}:${agentRole}`] ??
      (run.packId === 'adlc' ? config.roleBindings[agentRole] : undefined);
    if (!agentId) return { nodeId: node.id, phase, status: 'unbound', role: agentRole };
    const ownsClaim = await persistence.claim(companyId, run.id, node.id, attempt, phase, agentId);
    let dispatch = await persistence.get(companyId, run.id, node.id, attempt, phase);
    agentId = dispatch.agent_id;
    const agent = await host.agents.get(agentId, companyId);
    if (!agent) return { nodeId: node.id, phase, status: 'missing_agent', role: agentRole, agentId };
    if (!ownsClaim && !dispatch.issue_id) return { nodeId: node.id, phase, status: 'claimed_elsewhere' };
    await engine.recordDecision({
      type: 'paperclip_node_dispatch', status: 'approved', outcome: 'requested',
      reason: `Dispatch ${phase} for ${node.id} attempt ${attempt} to bound ${run.packId} role ${agentRole}`,
      actor: { id: host.manifest.id, kind: 'system', roles: [], executionId: null },
      runId: run.id, nodeId: node.id, issueId: run.input.paperclipIssueId,
      affectedRefs: [{ kind: 'paperclip_agent', id: agentId }, { kind: 'dispatch_origin', id: originId }],
      idempotencyKey: `dispatch-intent:${originId}`,
    });
    let issueId = dispatch.issue_id;
    if (!issueId) {
      const prior = await host.issues.list({
        companyId, originKind: `plugin:${host.manifest.id}:node`, originId, limit: 2,
      });
      if (prior.length > 1) throw new Error(`Duplicate Paperclip issues for ${originId}`);
      if (prior[0]) issueId = prior[0].id;
      else {
        const parent = await assertIssue(companyId, run.input.paperclipIssueId);
        const context = await dispatchContext(engine, run, node, phase);
        const roleInstructions = rolePrompt(run.pack, agentRole);
        const evidenceInstructions = node.outputContract || node.decisionContract
          ? run.pack.policyDocuments?.evidenceContracts ?? 'Read the pinned pack evidence contract before submitting.' : null;
        const inventory = contextInventory({ context, roleInstructions, evidenceInstructions });
        host.logger?.info?.('Graph dispatch context inventory', { runId: run.id, nodeId: node.id, phase, ...inventory });
        const issue = await host.issues.create({
          companyId,
          parentId: parent.id,
          projectId: parent.projectId ?? undefined,
          inheritExecutionWorkspaceFromIssueId: parent.id,
          title: `${run.graph.id} · ${node.id}${phase === 'supervisor' ? ' review' : ''}`,
          description: [
            `PolyForge Graph run ${run.id}, node ${node.id}, attempt ${attempt}.`,
            `Graph version ${run.graph.version}; Pack ${run.packId}@${run.packVersion}.`,
            `Use the ${host.manifest.id}:graph-command tool. Pass this Paperclip issue ID, Graph run ID and node ID.`,
            `Read the scoped Graph API for current status and full pinned context: GET /api/plugins/${host.manifest.id}/api/issues/<this-issue-id>/graph?runId=${run.id}. Submit results through the Graph command with the host-provided Paperclip run identity.`,
            phase === 'supervisor'
              ? 'Independently inspect the submitted artifact and evidence, then call review with outcome accept or rework. Do not approve your own execution.'
              : node.type === 'decision'
                ? 'Inspect the pinned candidate and evidence, then call decide with outcome, reason, and evidence. If a CPO/CTO conflict pauses this gate, re-read the scoped Graph API after human resolution; a continued gate must cite its human Decision Record ID as conflict_resolution evidence.'
                : node.decisionTraceRequired
                  ? 'Before submitting an important artifact, call record-work-decision for an explicit product, engineering or process choice with sourced evidence. Pass its returned Decision Record ID in submit.decisionIds. For feature-scoped work, declare behaviorImpact as none, changes, or unknown; unknown blocks submission, and changes needs a scope plus an approved superseding product decision. This records the choice you actually make; it does not capture hidden reasoning. Then call submit with a versioned artifact. If review is required, self-review in this same Paperclip run until no P0/P1 remains or round 5; supervisor review follows.'
                  : 'Produce a versioned artifact and call submit. If this node requires review, call self-review in this same Paperclip run until no P0/P1 remains or round 5; supervisor review follows.',
            `Root Paperclip issue: ${parent.id}.`,
            `## Pinned node contract and work context\n\n${context}`,
            ...(node.outputContract || node.decisionContract ? [
              'Submit structured output matching the pinned output contract. Contract artifacts and output are immutable per attempt; correct them through supervisor rework and a new artifact version. Missing checks stay unverified; only authenticated humans can record acceptance exceptions.',
              evidenceInstructions
            ] : []),
            roleInstructions,
          ].join('\n\n'),
          status: 'todo', priority: 'medium',
          assigneeAgentId: agentId,
          originKind: `plugin:${host.manifest.id}:node`, originId,
        });
        issueId = issue.id;
      }
      await persistence.update(companyId, run.id, node.id, attempt, phase, { issueId });
      dispatch = await persistence.get(companyId, run.id, node.id, attempt, phase);
    }
    if (host.issues.documents) {
      const goalsBody = pinnedGoalMarkdown(run);
      const existingGoalDoc = await host.issues.documents.get(issueId, 'goal', companyId);
      if (existingGoalDoc && existingGoalDoc.body !== goalsBody) throw new Error('Run-scoped GOAL.md differs from pinned goal revision');
      if (!existingGoalDoc) await host.issues.documents.upsert({ issueId, companyId, key: 'goal',
        title: 'GOAL.md · pinned run commitments', format: 'markdown', body: goalsBody,
        changeSummary: `Pinned goals for Graph run ${run.id}` });
    }
    if (run.input.feature) {
      const memory = await engine.getProductMemory(run.input.feature);
      await engine.recordDecision({ type: 'product_memory_context', status: 'applied', outcome: 'included_in_issue',
        reason: `Current product memory for ${run.input.feature} was included in the Graph dispatch context`,
        actor: { id: host.manifest.id, kind: 'system', roles: [], executionId: null },
        runId: run.id, nodeId: node.id, issueId,
        evidence: [{ kind: 'active_product_decisions', decisionIds: memory.active.map((item) => item.id) }],
        idempotencyKey: `memory-context:${originId}` });
    }
    if (dispatch.state === 'issued' && await persistence.wakeClaim(companyId, run.id, node.id, attempt, phase)) {
      const wakeup = await host.issues.requestWakeup(issueId, companyId, {
        reason: 'plugin:polyforge_graph', contextSource: 'polyforge-graph',
        idempotencyKey: originId,
      });
      if (wakeup.runId) await persistence.update(companyId, run.id, node.id, attempt, phase, {
        state: 'woken', agentRunId: wakeup.runId,
      });
      return { nodeId: node.id, phase, status: wakeup.queued ? 'queued' : 'not_queued', issueId, agentId, agentRunId: wakeup.runId };
    }
    dispatch = await persistence.get(companyId, run.id, node.id, attempt, phase);
    return { nodeId: node.id, phase, status: dispatch.state, issueId, agentId, agentRunId: dispatch.agent_run_id };
  }

  async function dispatchReady(companyId, engine, runId, config) {
    const actions = [];
    for (let guard = 0; guard < 100; guard++) {
      const run = await engine.getRun(runId);
      if (!run || run.status !== 'running') break;
      const work = await engine.getWorkItems(runId);
      const automatic = work.filter((item) => item.kind === 'automatic');
      if (automatic.length) {
        for (const item of automatic) await engine.submitNode({
          runId, nodeId: item.nodeId,
          actor: { id: host.manifest.id, kind: 'system', roles: [], executionId: null },
          output: { automatedTransition: true },
          idempotencyKey: `automatic:${runId}:${item.nodeId}:${run.nodeStates[item.nodeId].attempts.length + 1}`,
        });
        continue;
      }
      for (const item of work) {
        if (item.kind === 'human') actions.push({ nodeId: item.nodeId, phase: item.phase, status: 'waiting_human' });
        else if (item.kind === 'blocked') actions.push({ nodeId: item.nodeId, phase: item.phase, status: 'blocked', reason: item.reason });
        else if (item.role) {
          const node = run.graph.nodes.find((entry) => entry.id === item.nodeId);
          if (item.phase === 'work' && node.shadow && run.nodeStates?.[node.id]?.status === 'pending') {
            if (!shadowRuntime) throw new Error('Required Shadow execution runtime unavailable');
            const shadow = await shadowRuntime.beforeDispatch({ companyId, engine, run, node, config,
              agentId: config.roleBindings?.[`${run.packId}:${node.role}`] });
            if (!shadow.ready) {
              actions.push({ nodeId: node.id, phase: item.phase, ...shadow });
              continue;
            }
          }
          actions.push(await dispatchNode(companyId, engine, run, node, config, item.phase));
        } else actions.push({ nodeId: item.nodeId, phase: item.phase, status: 'unbound' });
      }
      return actions;
    }
    return actions;
  }

  async function currentDispatches(companyId, run) {
    return (await Promise.all(run.graph.nodes.flatMap((node) => {
      const nodeState = run.nodeStates[node.id];
      if (!['pending', 'awaiting_self_review', 'awaiting_supervisor_review'].includes(nodeState?.status)) return [];
      const phase = nodeState.status === 'awaiting_supervisor_review' ? 'supervisor' : 'work';
      const attempt = nodeState.attempts.length + (nodeState.status === 'pending' ? 1 : 0);
      return [persistence.get(companyId, run.id, node.id, attempt, phase).then((row) =>
        row ? { nodeId: node.id, phase, attempt, issueId: row.issue_id,
          agentId: row.agent_id, agentRunId: row.agent_run_id, state: row.state } : null)];
    }))).filter(Boolean);
  }

  async function recoverDispatches() {
    for (const companyId of await persistence.companies()) {
      const { engine, store } = await engineFor(companyId);
      const state = await store.read();
      const config = await getGraphConfig(host.db, companyId);
      for (const run of Object.values(state?.runs ?? {})) {
        if (run.status !== 'running') continue;
        try { await dispatchReady(companyId, engine, run.id, config); }
        catch (error) { host.logger.warn('Graph dispatch recovery failed', { runId: run.id, error: errorMessage(error) }); }
      }
    }
  }
  return { dispatchReady, assertAgentCallback, currentDispatches, recoverDispatches };
}
