import { PaperclipStore, getDispatch, claimDispatch, claimDispatchWakeup, releaseDispatchWakeup, bindDispatchRunFromCheckout, updateDispatch, getDispatchForIssue, listGraphCompanies, reconcileDispatchSlots, reserveDispatchSlot } from './store.mjs';
import { contextInventory, reviewPacket } from './review-context.mjs';
import { createDispatchAdmission } from './dispatch-admission.mjs';

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
  wakeRelease: (...args) => releaseDispatchWakeup(host.db, ...args),
  bindRun: (...args) => bindDispatchRunFromCheckout(host.db, ...args),
  update: (...args) => updateDispatch(host.db, ...args),
  forIssue: (...args) => getDispatchForIssue(host.db, ...args),
  companies: () => listGraphCompanies(host.db),
  readState: (companyId) => new PaperclipStore(host.db, companyId).read(),
  reconcileSlots: (...args) => reconcileDispatchSlots(host.db, ...args),
  reserveSlot: (input) => reserveDispatchSlot(host.db, input),
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
    if (currentAttempt && ['issued', 'waking'].includes(dispatch.state) && !dispatch.agent_run_id) {
      // Paperclip may start an assigned issue as part of issue creation. Its trusted
      // checkout is the only source allowed to pin the run before a wakeup response.
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

  async function dispatchNode(companyId, engine, run, node, config, phase, admission, currentAttemptEligible) {
    const agentRole = phase === 'supervisor' ? node.review.supervisorRole : node.role;
    const nodeState = run.nodeStates[node.id];
    const attempt = phase === 'supervisor' ? nodeState.attempts.length : nodeState.attempts.length + 1;
    const originId = `${run.id}:${node.id}:${attempt}:${phase}`;
    const existing = await persistence.get(companyId, run.id, node.id, attempt, phase);
    if (existing?.issue_id && existing.agent_id &&
      (['issued', 'waking'].includes(existing.state) || (existing.state === 'woken' && existing.agent_run_id))) {
      return { nodeId: node.id, phase, status: existing.state, issueId: existing.issue_id,
        agentId: existing.agent_id, agentRunId: existing.agent_run_id };
    }
    let agentId = existing?.agent_id ?? config.roleBindings[`${run.packId}:${agentRole}`] ??
      (run.packId === 'adlc' ? config.roleBindings[agentRole] : undefined);
    if (!agentId) return { nodeId: node.id, phase, status: 'unbound', role: agentRole };
    const agent = await host.agents.get(agentId, companyId);
    if (!agent) return { nodeId: node.id, phase, status: 'missing_agent', role: agentRole, agentId };
    if (!await admission.admit(node.id, attempt, phase)) {
      return { nodeId: node.id, phase, status: 'deferred_agent_limit' };
    }
    const ownsClaim = await persistence.claim(companyId, run.id, node.id, attempt, phase, agentId);
    let dispatch = await persistence.get(companyId, run.id, node.id, attempt, phase);
    agentId = dispatch.agent_id;
    if (!ownsClaim && !dispatch.issue_id) return { nodeId: node.id, phase, status: 'claimed_elsewhere' };
    if (!await currentAttemptEligible(run, node.id, phase, attempt)) {
      return { nodeId: node.id, phase, status: 'stale_attempt' };
    }
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
        companyId, originKind: `plugin:${host.manifest.id}:node`, originId, limit: 1000,
      });
      if (prior.length > 1) {
        prior.sort((a, b) => (Date.parse(a.createdAt ?? a.created_at) || 0) - (Date.parse(b.createdAt ?? b.created_at) || 0) ||
          String(a.id).localeCompare(String(b.id)));
        host.logger?.warn?.('Duplicate Paperclip issues for dispatch origin', { originId, issueId: prior[0].id });
      }
      if (prior[0]) issueId = prior[0].id;
      else {
        const parent = await assertIssue(companyId, run.input.paperclipIssueId);
        const context = await dispatchContext(engine, run, node, phase);
        const roleInstructions = rolePrompt(run.pack, agentRole);
        const evidenceInstructions = node.outputContract || node.decisionContract
          ? run.pack.policyDocuments?.evidenceContracts ?? 'Read the pinned pack evidence contract before submitting.' : null;
        const inventory = contextInventory({ context, roleInstructions, evidenceInstructions });
        host.logger?.info?.('Graph dispatch context inventory', { runId: run.id, nodeId: node.id, phase, ...inventory });
        if (!await currentAttemptEligible(run, node.id, phase, attempt)) {
          return { nodeId: node.id, phase, status: 'stale_attempt' };
        }
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
    // Assigned issue creation is Paperclip's wakeup mechanism. Calling requestWakeup
    // here can start a second execution and race the issue_assigned checkout callback.
    if (!await currentAttemptEligible(run, node.id, phase, attempt)) {
      return { nodeId: node.id, phase, status: 'stale_attempt', issueId, agentId };
    }
    dispatch = await persistence.get(companyId, run.id, node.id, attempt, phase);
    return { nodeId: node.id, phase, status: dispatch.state, issueId, agentId, agentRunId: dispatch.agent_run_id };
  }

  async function dispatchReady(companyId, engine, runId, config) {
    const actions = [];
    const systemActor = () => {
      if (!host.manifest?.id) throw new Error('Trusted plugin identity required for system dispatch');
      return { id: host.manifest.id, kind: 'system', roles: [], executionId: null };
    };
    const active = new Set();
    async function eligibleLineage(run) {
      let child = run;
      const seen = new Set([run.id]);
      while (child.parentWorkflow) {
        const { runId: parentId, nodeId, attempt } = child.parentWorkflow;
        if (seen.has(parentId)) return false;
        seen.add(parentId);
        const parent = await engine.getRun(parentId);
        const state = parent?.nodeStates?.[nodeId];
        if (!parent || parent.status !== 'running' || state?.childRunId !== child.id ||
            state.status !== 'waiting_child' || state.attempts?.[attempt - 1]?.childRunId !== child.id ||
            parent.input?.paperclipCompanyId !== companyId ||
            parent.input?.paperclipIssueId !== child.input?.paperclipIssueId) return false;
        child = parent;
      }
      return true;
    }
    async function currentAttemptEligible(original, nodeId, phase, attempt) {
      const work = await engine.getWorkItems(original.id);
      if (!work.some((item) => item.nodeId === nodeId && item.phase === phase && item.role)) return false;
      const current = await engine.getRun(original.id);
      if (!current || current.status !== 'running' ||
          current.input?.paperclipCompanyId !== companyId ||
          current.input?.paperclipIssueId !== original.input?.paperclipIssueId) return false;
      const state = current.nodeStates?.[nodeId];
      if (phase === 'supervisor'
        ? state?.status !== 'awaiting_supervisor_review' || state.attempts.length !== attempt
        : state?.status !== 'pending' || state.attempts.length + 1 !== attempt) return false;
      if (!await eligibleLineage(current)) return false;
      return typeof engine.isDispatchEligible !== 'function' || await engine.isDispatchEligible(current.id);
    }
    async function dispatchRun(currentId) {
      if (active.has(currentId)) return;
      active.add(currentId);
      try {
      for (let guard = 0; guard < 100; guard++) {
      const run = await engine.getRun(currentId);
      if (!run) break;
      if (!await eligibleLineage(run)) break;
      if (typeof engine.isHostRunSupported === 'function' && !await engine.isHostRunSupported(run)) break;
      const admission = await dispatchAdmission.prepare(companyId, run);
      if (run.status !== 'running') break;
      const work = await engine.getWorkItems(currentId);
      const workflowItems = work.filter((item) => item.kind === 'workflow' ||
        run.graph.nodes.some((node) => node.id === item.nodeId && node.type === 'workflow'));
      const linked = run.graph.nodes.filter((node) => node.type === 'workflow' &&
        run.nodeStates?.[node.id]?.childRunId && run.nodeStates[node.id].status === 'waiting_child');
      let changed = false;
      const workflowNodeIds = new Set([...workflowItems.map((item) => item.nodeId), ...linked.map((node) => node.id)]);
      for (const nodeId of workflowNodeIds) {
        const before = await engine.getRun(currentId);
        if (!before || before.status !== 'running' || !await eligibleLineage(before)) break;
        const state = before.nodeStates?.[nodeId];
        if (!['pending', 'waiting_child'].includes(state?.status)) continue;
        const child = await engine.startChildWorkflow({ runId: currentId, nodeId, actor: systemActor() });
        if (!child || child.parentWorkflow?.runId !== currentId ||
            child.parentWorkflow?.nodeId !== nodeId ||
            child.parentWorkflow?.attempt !== (state.status === 'pending' ? state.attempts.length + 1 : state.attempts.length)) {
          throw new Error('Linked workflow child does not match current parent attempt');
        }
        actions.push({ runId: currentId, nodeId, childRunId: child.id, status: 'workflow_child' });
        await dispatchRun(child.id);
        const latest = await engine.getRun(currentId);
        if (!latest || latest.status !== 'running' || latest.nodeStates?.[nodeId]?.childRunId !== child.id ||
            !await eligibleLineage(latest)) continue;
        const reconciled = await engine.reconcileChildWorkflow({ runId: currentId, nodeId, actor: systemActor() });
        if (reconciled?.nodeStates?.[nodeId]?.status !== 'waiting_child' &&
            (reconciled?.nodeStates?.[nodeId]?.status !== state.status || reconciled?.status !== before.status)) changed = true;
      }
      if (changed) continue;
      const automatic = work.filter((item) => item.kind === 'automatic' && !workflowNodeIds.has(item.nodeId));
      if (automatic.length) {
        for (const item of automatic) await engine.submitNode({
          runId: currentId, nodeId: item.nodeId,
          actor: systemActor(),
          output: { automatedTransition: true },
          idempotencyKey: `automatic:${currentId}:${item.nodeId}:${run.nodeStates[item.nodeId].attempts.length + 1}`,
        });
        continue;
      }
      for (const item of work) {
        if (workflowNodeIds.has(item.nodeId)) continue;
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
          const dispatched = await dispatchNode(companyId, engine, run, node, config, item.phase, admission,
            currentAttemptEligible);
          actions.push(dispatched);
        } else actions.push({ nodeId: item.nodeId, phase: item.phase, status: 'unbound' });
      }
      break;
    }
      } finally { active.delete(currentId); }
    }
    await dispatchRun(runId);
    let child = await engine.getRun(runId);
    const ancestors = new Set([runId]);
    while (child?.parentWorkflow && !ancestors.has(child.parentWorkflow.runId)) {
      const { runId: parentId, nodeId } = child.parentWorkflow;
      ancestors.add(parentId);
      const parent = await engine.getRun(parentId);
      if (!parent || parent.status !== 'running' || parent.nodeStates?.[nodeId]?.childRunId !== child.id ||
          !await eligibleLineage(child)) break;
      await engine.reconcileChildWorkflow({ runId: parentId, nodeId, actor: systemActor() });
      await dispatchRun(parentId);
      child = await engine.getRun(parentId);
    }
    return actions;
  }

  async function currentDispatches(companyId, run) {
    if (!run.deliveryKey || !persistence.get) return [];
    return (await Promise.all(run.graph.nodes.flatMap((node) => {
      const nodeState = run.nodeStates[node.id];
      if (!['pending', 'awaiting_self_review', 'awaiting_supervisor_review'].includes(nodeState?.status)) return [];
      const phase = nodeState.status === 'awaiting_supervisor_review' ? 'supervisor' : 'work';
      const attempt = (nodeState.attempts?.length ?? 0) + (nodeState.status === 'pending' ? 1 : 0);
      return [Promise.resolve(persistence.get(companyId, run.id, node.id, attempt, phase)).then((row) =>
        row ? { runId: run.id, nodeId: node.id, phase, attempt, issueId: row.issue_id,
          agentId: row.agent_id, agentRunId: row.agent_run_id, state: row.state } : null)];
    }))).filter(Boolean);
  }
  const dispatchAdmission = createDispatchAdmission(persistence, currentDispatches);

  return { dispatchReady, assertAgentCallback, currentDispatches };
}

export function bounded(value, depth = 0) {
  const marker = '[truncated; fetch Graph run for full value]';
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}… ${marker}` : value;
  if (Array.isArray(value)) return [...value.slice(0, 40).map(item => bounded(item, depth + 1)), ...(value.length > 40 ? [marker] : [])];
  if (value && typeof value === 'object') {
    if (depth >= 6) return '[nested content omitted; fetch Graph run]';
    const entries = Object.entries(value);
    const result = Object.fromEntries(entries.slice(0, 40).map(([key, item]) => [key, bounded(item, depth + 1)]));
    if (entries.length > 40) {
      let key = '_truncated';
      while (Object.hasOwn(result, key)) key += '_';
      result[key] = marker;
    }
    return result;
  }
  return value;
}
