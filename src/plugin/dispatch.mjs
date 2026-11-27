import { PLUGIN_RPC_ERROR_CODES } from '@paperclipai/plugin-sdk/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { PaperclipStore, getDispatch, claimDispatch, claimDispatchWakeup, releaseDispatchWakeup, bindDispatchRunFromCheckout, updateDispatch, getDispatchForIssue, listGraphCompanies, reconcileDispatchSlots, reserveDispatchSlot, markDispatchCheckoutVerified } from './store.mjs';
import { contextInventory, reviewPacket } from './review-context.mjs';
import { createDispatchAdmission } from './dispatch-admission.mjs';
import { beginEffect, confirmEffect, settleAbsentEffect, reconcileEffectSuccess, getEffect, retireUnsentEffect, cancelUnsentEffects } from './effect-ledger.mjs';
import { normalizeDispatchState } from './dispatch-state.mjs';
import { assessDispatchLifecycle } from './dispatch-lifecycle.mjs';
import { checkPinnedWorkspacePolicy } from './workspace-admission.mjs';
import { getAssignment, beginAssignment, confirmAssignment, retireAssignment, cancelAssignmentRetirements, listAssignmentRetirements } from './assignment-ledger.mjs';
import { affectedNodes } from '../core/engine.mjs';
import { runValidationDigest } from '../core/index.mjs';
import { canonical } from '../core/canonical.mjs';

const retryAssignmentPrefix = (runId, nodeId, key) => `${createHash('sha256').update(JSON.stringify([runId, nodeId, key])).digest('hex')}:`;

export const EFFECT_SETTLE_GRACE_MS = 10 * 60_000;

const childExecutionInstructions = [
  'Work in the Paperclip workspace assigned to this child issue. Starting with Paperclip 2026.1117.0, isolated child checkouts start from the project base. For Git handoffs, push or merge the changes and cite the accessible commit or ref. Publish other handoffs as retrievable, versioned Graph artifacts.',
  'In a native Paperclip Runner, complete the Graph commands for your assigned phase while this run owns the child issue checkout. After Graph accepts the required commands, report the outcome with paperclip_finish. If you cannot complete those commands, use paperclip_block with the reason and any recorded Graph evidence. Paperclip updates the native issue status from these tools.',
].join('\n\n');

function dispatchPhaseInstructions(node, phase, historical, legacyReview) {
  if (phase === 'supervisor') {
    if (legacyReview) return 'Independently inspect the submitted artifact and evidence, then call review with outcome accept or rework. Do not approve your own execution.';
    return 'Independently inspect the submitted artifacts and evidence, then call review with outcome accept or rework. Include evidence for each kind in requiredEvidence and copy candidateRefs into each item’s subjectRefs. Cite actual review observations and sources. If the rule asks for self-review history, copy the occurrence reference into that evidence item’s selfReviewRef.';
  }
  if (node.type === 'decision') return 'Inspect the pinned candidate and evidence, then call decide with outcome, reason, and evidence. If a CPO/CTO conflict pauses this gate, re-read the scoped Graph API after human resolution; a continued gate must cite its human Decision Record ID as conflict_resolution evidence.';
  if (historical) {
    if (node.decisionTraceRequired) return 'Before submitting an important artifact, call record-work-decision for an explicit product, engineering or process choice with sourced evidence. Pass its returned Decision Record ID in submit.decisionIds. For feature-scoped work, declare behaviorImpact as none, changes, or unknown; unknown blocks submission, and changes needs a scope plus an approved superseding product decision. This records the choice you actually make; it does not capture hidden reasoning. Then call submit with a versioned artifact. If review is required, self-review in this same Paperclip run until no P0/P1 remains or round 5; supervisor review follows.';
    return 'Produce a versioned artifact and call submit. If this node requires review, call self-review in this same Paperclip run until no P0/P1 remains or round 5; supervisor review follows.';
  }
  if (node.decisionTraceRequired) return 'Before submitting an important artifact, call record-work-decision for an explicit product, engineering or process choice with sourced evidence. Pass its returned Decision Record ID in submit.decisionIds. For feature-scoped work, declare behaviorImpact as none, changes, or unknown; unknown blocks acceptance, and changes needs a scope plus an approved superseding product decision. Then call submit with a versioned artifact.';
  return 'Produce a versioned artifact and call submit.';
}

function supervisorIssueDescriptions({ packet, node, attempt, parentId, tool, scopedUrl, context, roleInstructions, documentsPinned = true }) {
  const { runId, graphVersion, packId, packVersion, requiredEvidence, candidateRefs, selfReviewRef } = packet;
  const parameters = {
    operation: 'review', issueId: '<activeTask.id>', runId, nodeId: node.id, outcome: 'rework',
    reason: 'Replace with the concrete evidence and findings that justify your independent disposition.',
    evidence: requiredEvidence.map(kind => ({
      kind, summary: kind === 'self_review_history' && selfReviewRef
        ? 'Replace with your observation about the recorded self-review occurrence for this attempt.'
        : 'Replace with your independent observations and the source you checked for this evidence kind.',
      subjectRefs: candidateRefs,
      ...(kind === 'self_review_history' && selfReviewRef && { selfReviewRef }),
    })),
    idempotencyKey: `review:${runId}:${node.id}:${attempt}`,
  };
  const heading = `PolyForge Graph run ${runId}, node ${node.id}, attempt ${attempt}. Graph version ${graphVersion}. Pack ${packId}@${packVersion}.`;
  const content = [
    'Inspect the candidate artifacts and sources independently. Choose `accept` if the candidate satisfies the pinned requirements. Choose `rework` if it requires changes. The template shows `rework` as an example. Replace the reason and every evidence summary with nonempty, concrete statements from your review.',
    `Call \`get_task_context\` and replace \`<activeTask.id>\` with \`activeTask.id\` from that response. This binds the command to your checked-out supervisor child issue. Use these arguments with \`${tool}\`.`,
    `\`\`\`json\n${JSON.stringify(parameters, null, 2)}\n\`\`\``,
    `If the Graph tool is unavailable directly, call \`call_api\` with operationId \`POST /api/plugins/tools/execute\`. Set body.tool to \`${tool}\`, body.parameters to the JSON above, and body.runContext to {agentId, runId, companyId} from actor.id, run.id and company.id in \`get_task_context\`.`,
    `Use the pinned candidate versions and every listed evidence kind. Read the full scoped Graph review packet with GET ${scopedUrl}. After Graph accepts the review, report the outcome with \`paperclip_finish\`. If you cannot complete it, use \`paperclip_block\` with the blocker and recorded evidence.`,
    ...(node.purpose ? [`Review scope\n\n${bounded(node.purpose)}`] : []),
    `Root Paperclip issue: ${parentId}.`,
    `## Pinned node contract and work context\n\n${context}`,
    roleInstructions,
  ].filter(Boolean);
  const reviewOnly = 'Use `review` as your only Graph write for this assigned supervisor phase. Record the disposition, findings and reason in that same call. Read the packet here or via the scoped GET.';
  const refs = packet.candidates[0]?.output?.[packet.reportKind]?.researchRefs;
  const citationGuide = packet.acceptedSourceRefs && [
    documentsPinned
      ? 'Compare the submitted research references with the accepted sources. Use list_task_documents to read the complete research-citations document pinned on this supervisor child.'
      : 'Compare the submitted research references with the accepted sources. Read acceptedSourceReports in the scoped Graph review packet for the complete accepted evidence.',
    JSON.stringify({ submitted: Array.isArray(refs) ? refs.map(ref => ({ kind: ref?.kind, id: ref?.id, version: ref?.version })) : null,
      expected: packet.acceptedSourceRefs.map(({ nodeId, ref, decisionId }) => ({ nodeId, ref, decisionId })) }),
  ].join('\n');
  return {
    current: [heading, reviewOnly, citationGuide, ...content].filter(Boolean).join('\n\n'),
    withoutCitations: citationGuide && [heading, reviewOnly, ...content].join('\n\n'),
    preceding: [heading, ...content].join('\n\n'),
  };
}

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
  getEffect: (...args) => getEffect(host.db, ...args),
  retireEffect: (...args) => retireUnsentEffect(host.db, ...args),
  cancelRetirements: (...args) => cancelUnsentEffects(host.db, ...args),
  beginEffect: (...args) => beginEffect(host.db, ...args),
  confirmEffect: (...args) => confirmEffect(host.db, ...args),
  settleAbsentEffect: (...args) => settleAbsentEffect(host.db, ...args),
  reconcileEffect: (...args) => reconcileEffectSuccess(host.db, ...args),
  getAssignment: (...args) => getAssignment(host.db, ...args),
  beginAssignment: (...args) => beginAssignment(host.db, ...args),
  confirmAssignment: (...args) => confirmAssignment(host.db, ...args),
  retireAssignment: (...args) => retireAssignment(host.db, ...args),
  listAssignmentRetirements: (...args) => listAssignmentRetirements(host.db, ...args),
  cancelAssignments: (...args) => cancelAssignmentRetirements(host.db, ...args),
  markCheckout: (...args) => markDispatchCheckoutVerified(host.db, ...args),
}, shadowRuntime = null, { effectSettleGraceMs = EFFECT_SETTLE_GRACE_MS } = {}) {
  const errorMessage = (error) => error instanceof Error ? error.message : String(error);
  function isDocumentCreateConflict(error) {
    const message = errorMessage(error);
    // A writer can win before the Host classifies this create-only upsert
    // as an update, or afterwards while it is inserting the document key.
    return message.startsWith('Document update requires baseRevisionId.') ||
      message === 'Document key already exists on this issue';
  }
  async function assertIssue(companyId, issueId) {
    const issue = await host.issues.get(issueId, companyId);
    if (!issue || issue.id !== issueId || (issue.companyId ?? issue.company_id ?? companyId) !== companyId) {
      throw new Error('Paperclip issue not found in company');
    }
    return issue;
  }
  const issueProjectId = (issue) => issue.projectId ?? issue.project_id ?? null;
  const issueUserId = (issue) => [issue?.assigneeUserId, issue?.assignee_user_id]
    .find(value => value != null && value !== '') ?? null;
  const ownershipConflict = (nodeId, phase, issue, agentId, lifecycle) => ({ nodeId, phase,
    status: 'ownership_conflict', reason: 'human_assignee', issueId: issue.id,
    assigneeUserId: issueUserId(issue), agentId, lifecycle });
  const assertNoHumanOwner = (issue) => {
    if (issueUserId(issue)) throw new Error(
      `Cannot retry node while issue ${issue.id} has human ownership (${issueUserId(issue)}); resolve ownership in Paperclip before retrying`);
  };

  // Creation and origin recovery may observe our issue before assignment.
  function matchesAssignment(issue, expected, { createReceipt = false } = {}) {
    if (typeof issue?.id !== 'string' || !issue.id.trim() || !expected.assigneeAgentId) return false;
    if (issueUserId(issue)) return false;
    if (['assigneeAgentId', 'assignee_agent_id'].some(name =>
      issue[name] != null && issue[name] !== '' && issue[name] !== expected.assigneeAgentId)) return false;
    for (const [key, snakeKey] of [
      ['companyId', 'company_id'], ['originKind', 'origin_kind'], ['originId', 'origin_id'],
      ['parentId', 'parent_id'], ['projectId', 'project_id'],
    ]) {
      const value = expected[key] ?? null;
      const supplied = [key, snakeKey].filter(name => Object.hasOwn(issue, name));
      if (!supplied.length && !createReceipt && value !== null) return false;
      if (supplied.some(name => (issue[name] ?? null) !== value)) return false;
    }
    return true;
  }

  function assignedIssueAttempt(companyId, run, nodeId, attempt, phase) {
    const originId = `${run.id}:${nodeId}:${attempt}:${phase}`;
    return { origin: { companyId, originKind: `plugin:${host.manifest.id}:node`, originId },
      parentIssueId: run.input.paperclipIssueId, operationId: `issue-create:${originId}`,
      assignmentOperationId: `issue-assign:${originId}` };
  }

  async function lookupAssignedIssue({ origin, parentIssueId, operationId }, agentId, parent) {
    const matches = await host.issues.list({ ...origin, limit: 1000 });
    if (matches.length === 0) return { status: 'absent' };
    if (matches.length > 1) return { status: 'ambiguous' };

    const found = matches[0];
    if (issueUserId(found)) return { status: 'ownership_conflict', issue: found };
    if (!matchesAssignment(found, { ...origin, parentId: parentIssueId, projectId: issueProjectId(parent),
      assigneeAgentId: agentId })) return { status: 'mismatched' };

    const issueId = found.id;
    return { status: 'matched', issueId, reconcile: persistence.reconcileEffect &&
      (() => persistence.reconcileEffect(origin.companyId, operationId, { issueId })) };
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
    if (!checkoutVerified) {
      const checkout = await host.issues.assertCheckoutOwner({
        issueId, companyId, actorAgentId: actor.id, actorRunId: actor.executionId,
      });
      if (checkout?.checkoutRunId !== actor.executionId || checkout?.assigneeAgentId !== actor.id) throw new Error('Paperclip checkout does not identify this Graph agent run');
      if (persistence.markCheckout && !await persistence.markCheckout(companyId, run.id, nodeId, dispatch.attempt, dispatch.phase, issueId, actor.id, actor.executionId)) throw new Error('Dispatch changed before checkout proof was recorded');
    }
  }
  function rolePrompt(pack, roleId, sections = ['soul', 'role', 'goal', 'instruction', 'decision_model']) {
    const role = pack.roles?.[roleId];
    if (!role) throw new Error(`Pack role ${roleId} is missing`);
    const docs = role.documents ?? {};
    return sections
      .filter((name) => docs[name])
      .map((name) => `## ${name}.md\n\n${docs[name]}`)
      .join('\n\n');
  }

  async function dispatchContext(engine, run, node, phase, options) {
    const cleanReview = reviewPacket(run, node.id, phase, options);
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
    const priorWork = [...upstream].filter((id) => ['completed', 'awaiting_supervisor_review'].includes(run.nodeStates[id]?.status))
      .map((id) => {
        const state = run.nodeStates[id];
        const attempt = state.attempts?.at(-1);
        return { nodeId: id, status: state.status, artifacts: state.artifacts ?? attempt?.artifacts ?? [],
          output: attempt?.output ?? null, evidence: attempt?.evidence ?? [],
          decisionIds: attempt?.decisionIds ?? [] };
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
    const configuredAgentId = config.roleBindings?.[`${run.packId}:${agentRole}`] ??
      (run.packId === 'adlc' ? config.roleBindings?.[agentRole] : undefined);
    const pinnedReviewer = phase === 'supervisor' && run.graph.hostAdmission?.reviewedNodeId === node.id
      ? run.admission?.reviewer : null;
    if (pinnedReviewer && configuredAgentId !== pinnedReviewer) {
      return { nodeId: node.id, phase, status: 'unbound', role: agentRole, reason: 'Restore the independent reviewer pinned at admission' };
    }
    const nodeState = run.nodeStates[node.id];
    const attempt = phase === 'supervisor' ? nodeState.attempts.length : nodeState.attempts.length + 1;
    const issueAttempt = assignedIssueAttempt(companyId, run, node.id, attempt, phase);
    const { operationId, assignmentOperationId, origin, parentIssueId } = issueAttempt;
    const { originId } = origin;
    let lifecycle = await assessDispatchLifecycle({ host, companyId, run, node, attempt, phase });
    if (lifecycle.admission === 'blocked') return { nodeId: node.id, phase, status: 'blocked', reason: lifecycle.reason, lifecycle };
    async function pinResearchDocument(issueId) {
      if (phase !== 'supervisor' || !node.review?.requiredSourceRefs || !host.issues.documents) return;
      const key = 'research-citations';
      const packet = reviewPacket(run, node.id, phase);
      const body = JSON.stringify(JSON.parse(canonical({ runId: run.id, nodeId: node.id, attempt,
        reportKind: packet.reportKind, candidate: packet.candidates[0],
        acceptedSourceRefs: packet.acceptedSourceRefs, acceptedSourceReports: packet.acceptedSourceReports })), null, 2);
      let stored = await host.issues.documents.get(issueId, key, companyId);
      if (!stored) {
        try {
          await host.issues.documents.upsert({ issueId, companyId, key, title: 'Research citations and accepted evidence',
            format: 'markdown', body, changeSummary: `Evidence pinned for ${run.id}, ${node.id}, attempt ${attempt}` });
          return;
        } catch (error) {
          if (!isDocumentCreateConflict(error)) throw error;
          stored = await host.issues.documents.get(issueId, key, companyId);
        }
      }
      if (stored?.body !== body) throw new Error('Research citation document differs from the pinned review attempt');
    }
    async function assignIssue(issueId, agentId) {
      await pinResearchDocument(issueId);
      if (host.issues.documents) {
        const goalsBody = pinnedGoalMarkdown(run);
        const existingGoalDoc = await host.issues.documents.get(issueId, 'goal', companyId);
        if (existingGoalDoc && existingGoalDoc.body !== goalsBody) throw new Error('Run-scoped GOAL.md differs from pinned goal revision');
        if (!existingGoalDoc) {
          try { await host.issues.documents.upsert({ issueId, companyId, key: 'goal',
            title: 'GOAL.md · pinned run commitments', format: 'markdown', body: goalsBody,
            changeSummary: `Pinned goals for Graph run ${run.id}` }); }
          catch (error) {
            if (!isDocumentCreateConflict(error)) throw error;
            // A concurrent dispatcher can pin the same immutable goals after
            // our absent read. Confirm its scoped body instead of overwriting.
            const concurrentGoalDoc = await host.issues.documents.get(issueId, 'goal', companyId);
            if (!concurrentGoalDoc) throw error;
            if (concurrentGoalDoc.body !== goalsBody) throw new Error('Run-scoped GOAL.md differs from pinned goal revision');
          }
        }
      }
      // Assignment makes the issue eligible for Paperclip's recovery liveness scan.
      if (!await currentAttemptEligible(run, node.id, phase, attempt)) {
        return { nodeId: node.id, phase, status: 'stale_attempt', issueId, agentId };
      }
      let assignmentGeneration;
      if (persistence.beginAssignment) {
        const effect = await persistence.beginAssignment(companyId, assignmentOperationId, { issueId, agentId });
        if (!effect.owner) {
          if (effect.outcome !== 'unknown') return { nodeId: node.id, phase, status: 'stale_attempt', issueId, agentId };
          return { nodeId: node.id, phase, status: 'assignment_pending', operationId: assignmentOperationId, issueId, agentId, lifecycle };
        }
        assignmentGeneration = effect.generation;
        // A dependency-pending identity may survive an upstream retry. Owning
        // its assignment slot is necessary before rechecking current readiness.
        let eligible;
        try { eligible = await currentAttemptEligible(run, node.id, phase, attempt); }
        catch (error) {
          try { await receipt({ issueId, agentId, notSent: true }, 'confirmed_failure'); }
          catch (confirmationError) { host.logger?.warn?.('Unsent assignment confirmation deferred', { operationId: assignmentOperationId, issueId, error: errorMessage(confirmationError) }); }
          throw error;
        }
        if (!eligible) {
          await receipt({ issueId, agentId, notSent: true }, 'confirmed_failure');
          return { nodeId: node.id, phase, status: 'stale_attempt', issueId, agentId };
        }
      }
      function deferred(error) {
        host.logger?.warn?.('Paperclip issue assignment deferred', { operationId: assignmentOperationId, issueId, agentId, error: errorMessage(error) });
        return { nodeId: node.id, phase, status: 'assignment_pending', ...(persistence.beginAssignment ? { operationId: assignmentOperationId } : {}), issueId, agentId, lifecycle };
      }
      async function receipt(result, outcome = 'confirmed_success') {
        if (!persistence.confirmAssignment) return;
        try { await persistence.confirmAssignment(companyId, assignmentOperationId, assignmentGeneration, result, outcome); }
        catch { await persistence.confirmAssignment(companyId, assignmentOperationId, assignmentGeneration, result, outcome); }
      }
      // Preparing goals and claiming the assignment can await external work. A
      // human may take ownership in that interval; re-read immediately before
      // sending, and release our generation when the write was never attempted.
      let issue;
      try { issue = await assertIssue(companyId, issueId); }
      catch (error) {
        try { await receipt({ issueId, agentId, notSent: true }, 'confirmed_failure'); }
        catch (confirmationError) { host.logger?.warn?.('Unsent assignment confirmation deferred', { operationId: assignmentOperationId, issueId, error: errorMessage(confirmationError) }); }
        throw error;
      }
      if (issueUserId(issue)) {
        try { await receipt({ issueId, agentId, notSent: true, reason: 'human_assignee',
          assigneeUserId: issueUserId(issue) }, 'confirmed_failure'); }
        catch (error) { return deferred(error); }
        return ownershipConflict(node.id, phase, issue, agentId, lifecycle);
      }
      try { await host.issues.update(issueId, { assigneeAgentId: agentId }, companyId); }
      catch (error) {
        // The pinned SDK rejects these codes before invoking the host handler.
        // Timeouts and ordinary exceptions may still have an outstanding write.
        if ([PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED, PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED].includes(error?.code)) {
          try { await receipt({ issueId, agentId, notSent: true, code: error.code }, 'confirmed_failure'); }
          catch (confirmationError) { return deferred(confirmationError); }
        }
        return deferred(error);
      }
      try { await receipt({ issueId, agentId }); }
      catch (error) { return deferred(error); }
    }
    let existing = await persistence.get(companyId, run.id, node.id, attempt, phase);
    if (existing?.issue_id && existing.agent_id &&
      (['issued', 'waking'].includes(existing.state) || (existing.state === 'woken' && existing.agent_run_id))) {
      // prepare() counts existing delivery dispatches against capacity. Reporting
      // an already-created assignment does not request workspace or slot admission.
      const issue = await assertIssue(companyId, existing.issue_id);
      if (issueUserId(issue)) return ownershipConflict(node.id, phase, issue, existing.agent_id, lifecycle);
      if ((issue.assigneeAgentId ?? issue.assignee_agent_id) === existing.agent_id) await pinResearchDocument(existing.issue_id);
      const assignment = await persistence.getAssignment?.(companyId, assignmentOperationId);
      // Readback cannot prove that the original sender has finished. Even an
      // already-assigned issue must retain an unresolved assignment interlock.
      if (assignment?.outcome === 'unknown') return { nodeId: node.id, phase, status: 'assignment_pending',
        operationId: assignmentOperationId, issueId: existing.issue_id, agentId: existing.agent_id, lifecycle };
      if (existing.state === 'issued' && !existing.agent_run_id) {
        if (!(issue.assigneeAgentId ?? issue.assignee_agent_id)) {
          const { admitted, ...refusal } = await admission.admit(node.id, attempt, phase);
          if (!admitted) return { nodeId: node.id, phase, ...refusal, lifecycle };
          const action = await assignIssue(existing.issue_id, existing.agent_id);
          if (action) return action;
          existing = await persistence.get(companyId, run.id, node.id, attempt, phase);
        }
      }
      return { nodeId: node.id, phase, status: existing.state, issueId: existing.issue_id,
        agentId: existing.agent_id, agentRunId: existing.agent_run_id, lifecycle };
    }
    let agentId = existing?.agent_id ?? configuredAgentId;
    if (!agentId) return { nodeId: node.id, phase, status: 'unbound', role: agentRole };
    if (phase === 'work' && node.shadow && nodeState.status === 'pending') {
      // Shadow creates native work too. Check policy without reserving a parent
      // dispatch slot while the independent execution or review is still pending.
      const { admitted, ...refusal } = await admission.workspace(node.id, attempt, phase);
      if (!admitted) return { nodeId: node.id, phase, ...refusal, lifecycle };
      if (!await currentAttemptEligible(run, node.id, phase, attempt)) {
        return { nodeId: node.id, phase, status: 'stale_attempt' };
      }
      if (!shadowRuntime) throw new Error('Required Shadow execution runtime unavailable');
      const shadow = await shadowRuntime.beforeDispatch({ companyId, engine, run, node, config, agentId });
      if (!shadow.ready) return { nodeId: node.id, phase, ...shadow };
      // Native shadow execution can await host work. Preserve the parent checks
      // after it completes, before taking capacity or issuing the parent work.
      lifecycle = await assessDispatchLifecycle({ host, companyId, run, node, attempt, phase });
      if (lifecycle.admission === 'blocked') return { nodeId: node.id, phase, status: 'blocked', reason: lifecycle.reason, lifecycle };
      if (!await currentAttemptEligible(run, node.id, phase, attempt)) {
        return { nodeId: node.id, phase, status: 'stale_attempt' };
      }
    }
    const agent = await host.agents.get(agentId, companyId);
    if (!agent) return { nodeId: node.id, phase, status: 'missing_agent', role: agentRole, agentId };
    const { admitted, ...refusal } = await admission.admit(node.id, attempt, phase);
    if (!admitted) {
      return { nodeId: node.id, phase, ...refusal, lifecycle };
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
    if (issueId) {
      const issue = await assertIssue(companyId, issueId);
      if (issueUserId(issue)) return ownershipConflict(node.id, phase, issue, agentId, lifecycle);
    }
    if (!issueId) {
      const parent = await assertIssue(companyId, parentIssueId);
      const evidence = await lookupAssignedIssue(issueAttempt, agentId, parent);
      if (!await currentAttemptEligible(run, node.id, phase, attempt)) {
        return { nodeId: node.id, phase, status: 'stale_attempt' };
      }
      if (evidence.status === 'matched') {
        issueId = evidence.issueId;
        await evidence.reconcile?.();
      } else if (evidence.status === 'ownership_conflict') {
        return { ...ownershipConflict(node.id, phase, evidence.issue, agentId, lifecycle), operationId };
      } else if (evidence.status !== 'absent') {
        return { nodeId: node.id, phase, status: `effect_${evidence.status}`, operationId };
      } else {
        const supervisor = phase === 'supervisor' ? reviewPacket(run, node.id, phase) : null;
        const context = supervisor ? JSON.stringify(bounded(supervisor), null, 2) : await dispatchContext(engine, run, node, phase);
        const legacyReviewContext = supervisor
          ? await dispatchContext(engine, run, node, phase, { includeSupervisorRequirements: false }) : null;
        const roleInstructions = rolePrompt(run.pack, agentRole);
        const reviewRole = supervisor ? rolePrompt(run.pack, agentRole, ['role', 'goal']) : null;
        const evidenceInstructions = node.outputContract || node.decisionContract
          ? run.pack.policyDocuments?.evidenceContracts ?? 'Read the pinned pack evidence contract before submitting.' : null;
        const tool = `${host.manifest.id}:graph-command`;
        const scopedUrl = `/api/plugins/${host.manifest.id}/api/issues/<this-issue-id>/graph?runId=${run.id}`;
        const reviewDescriptions = supervisor && supervisorIssueDescriptions({ packet: supervisor, node, attempt,
          parentId: parent.id, tool, scopedUrl, context, roleInstructions: reviewRole,
          documentsPinned: Boolean(host.issues.documents) });
        const inventory = contextInventory(supervisor ? { description: reviewDescriptions.current } : { context, roleInstructions, evidenceInstructions });
        host.logger?.info?.('Graph dispatch context inventory', { runId: run.id, nodeId: node.id, phase, ...inventory });
        if (!await currentAttemptEligible(run, node.id, phase, attempt)) {
          return { nodeId: node.id, phase, status: 'stale_attempt' };
        }
        // Reconstruct released instruction forms from the same pinned context.
        // Only these exact descriptions may reuse an existing ledger operation.
        const descriptionFor = (historical, legacyReview = false) => [
            `PolyForge Graph run ${run.id}, node ${node.id}, attempt ${attempt}.`,
            `Graph version ${run.graph.version}; Pack ${run.packId}@${run.packVersion}.`,
            `Use the ${host.manifest.id}:graph-command tool. Pass this Paperclip issue ID, Graph run ID and node ID.`,
            `Read the scoped Graph API for current status and full pinned context: GET /api/plugins/${host.manifest.id}/api/issues/<this-issue-id>/graph?runId=${run.id}. Submit results through the Graph command with the host-provided Paperclip run identity.`,
            dispatchPhaseInstructions(node, phase, historical, legacyReview),
            ...(!historical && phase === 'work' && node.review ? [`If the submission requires self-review, use this same Paperclip run. The round limit is ${node.review.maxSelfReviews ?? 5}; independent review follows.`] : []),
            `Root Paperclip issue: ${parent.id}.`,
            `## Pinned node contract and work context\n\n${legacyReview ? legacyReviewContext : context}`,
            ...(node.outputContract || node.decisionContract ? [
              'Submit structured output matching the pinned output contract. Contract artifacts and output are immutable per attempt; correct them through supervisor rework and a new artifact version. Missing checks stay unverified; only authenticated humans can record acceptance exceptions.',
              evidenceInstructions
            ] : []),
            roleInstructions,
          ].join('\n\n');
        const previousRequest = {
          ...origin,
          parentId: parent.id,
          projectId: issueProjectId(parent) ?? undefined,
          // Paperclip 2026.1117.0 uses this to carry project and workspace strategy.
          // The host realizes the child issue's execution workspace.
          inheritExecutionWorkspaceFromIssueId: parent.id,
          title: `${run.graph.id} · ${node.id}${phase === 'supervisor' ? ' review' : ''}`,
          description: descriptionFor(false),
          status: 'todo', priority: 'medium',
        };
        const nativeGraphTransport = `If the Graph command is not listed as a native tool, use get_task_context and call_api with operationId "POST /api/plugins/tools/execute". In the body, set tool to "${host.manifest.id}:graph-command", parameters to the Graph command arguments, and runContext to the actor.id, run.id and company.id from get_task_context as agentId, runId and companyId. Use activeTask.id as parameters.issueId and check the Graph tool result for errors before reporting completion.`;
        const withNativeInstructions = item => ({ ...item,
          description: [item.description, nativeGraphTransport, childExecutionInstructions].join('\n\n') });
        const request = supervisor ? { ...previousRequest, description: reviewDescriptions.current } : withNativeInstructions(previousRequest);
        const historicalRequest = { ...previousRequest, description: descriptionFor(true) };
        const previousRequests = [previousRequest, historicalRequest, withNativeInstructions(historicalRequest)];
        if (supervisor) {
          const legacyReviewRequest = { ...previousRequest, description: descriptionFor(false, true) };
          previousRequests.push(withNativeInstructions(previousRequest), legacyReviewRequest, withNativeInstructions(legacyReviewRequest),
            { ...previousRequest, description: reviewDescriptions.preceding });
          if (reviewDescriptions.withoutCitations) previousRequests.push({ ...previousRequest, description: reviewDescriptions.withoutCitations });
        }
        const effect = persistence.beginEffect ? await persistence.beginEffect(companyId, operationId,
          { ...request, intendedAssigneeAgentId: agentId },
          previousRequests.map(item => ({ ...item, intendedAssigneeAgentId: agentId }))) : { owner: true };
        if (!effect.owner) {
          if (effect.outcome === 'confirmed_success' && effect.result?.issueId) {
            const issue = await assertIssue(companyId, effect.result.issueId);
            if (issueUserId(issue)) return { ...ownershipConflict(node.id, phase, issue, agentId, lifecycle), operationId };
            issueId = effect.result.issueId;
          }
          else return { nodeId: node.id, phase, status: 'effect_' + effect.outcome, operationId };
        } else {
          let issue;
          try { issue = await host.issues.create(request); }
          catch (error) {
            host.logger?.warn?.('Paperclip issue creation outcome unknown', { operationId, error: errorMessage(error) });
            return { nodeId: node.id, phase, status: 'effect_unknown', operationId };
          }
          if (issueUserId(issue)) return { ...ownershipConflict(node.id, phase, issue, agentId, lifecycle), operationId };
          if (!matchesAssignment(issue, { ...request, assigneeAgentId: agentId }, { createReceipt: true })) {
            return { nodeId: node.id, phase, status: 'effect_unknown', operationId };
          }
          issueId = issue.id;
          if (persistence.confirmEffect) {
            try { await persistence.confirmEffect(companyId, operationId, 'confirmed_success', { issueId }); }
            catch (error) {
              let effect, lookupError;
              try { effect = await persistence.getEffect?.(companyId, operationId); }
              catch (error) { lookupError = errorMessage(error); }
              if (effect?.outcome === 'confirmed_failure') {
                host.logger?.warn?.('Paperclip issue created for a retired dispatch attempt',
                  { operationId, issueId, error: errorMessage(error) });
                let contained = false;
                try {
                  await host.issues.update(issueId, { status: 'cancelled' }, companyId);
                  contained = true;
                } catch (error) {
                  host.logger?.warn?.('Orphaned Paperclip issue could not be cancelled; operator cleanup required',
                    { operationId, issueId, error: errorMessage(error) });
                }
                return { nodeId: node.id, phase, status: 'effect_orphaned', operationId, issueId, lifecycle, contained };
              }
              let eligible = false, eligibilityError;
              try { eligible = await currentAttemptEligible(run, node.id, phase, attempt); }
              catch (error) { eligibilityError = errorMessage(error); }
              host.logger?.warn?.(eligible ? 'Paperclip issue creation effect confirmation deferred'
                : 'Paperclip issue creation confirmation outcome unknown',
              { operationId, issueId, error: errorMessage(error), ...(lookupError ? { lookupError } : {}),
                ...(eligibilityError ? { eligibilityError } : {}) });
              if (!eligible || (effect?.outcome !== 'unknown' && lookupError === undefined)) {
                return { nodeId: node.id, phase, status: 'effect_unknown', operationId, issueId, lifecycle };
              }
            }
          }
        }
      }
      await persistence.update(companyId, run.id, node.id, attempt, phase, { issueId });
      dispatch = await persistence.get(companyId, run.id, node.id, attempt, phase);
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
    const action = await assignIssue(issueId, agentId);
    if (action) return action;
    dispatch = await persistence.get(companyId, run.id, node.id, attempt, phase);
    return { nodeId: node.id, phase, status: dispatch.state, issueId, agentId, agentRunId: dispatch.agent_run_id, lifecycle };
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
        const parentNode = parent.graph.nodes.find((node) => node.id === nodeId);
        if (!parentNode || !(await checkPinnedWorkspacePolicy({ companyId, run: parent, nodeId, attempt, phase: 'work' })).admitted || (await assessDispatchLifecycle({ host, companyId, run: parent, node: parentNode, attempt, phase: 'work' })).admission === 'blocked') return false;
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
        const node = before.graph.nodes.find((entry) => entry.id === nodeId);
        const lifecycle = await assessDispatchLifecycle({ host, companyId, run: before, node,
          attempt: state.status === 'pending' ? state.attempts.length + 1 : state.attempts.length, phase: 'work' });
        if (lifecycle.admission === 'blocked') { actions.push({ nodeId, phase: 'work', status: 'blocked', reason: lifecycle.reason, lifecycle }); continue; }
        const { admitted, ...refusal } = await admission.workspace(nodeId, state.status === 'pending' ? state.attempts.length + 1 : state.attempts.length, 'work');
        if (!admitted) { actions.push({ nodeId, phase: 'work', ...refusal }); continue; }
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
        let submitted = false;
        for (const item of automatic) {
          const node = run.graph.nodes.find((entry) => entry.id === item.nodeId);
          const attempt = run.nodeStates[item.nodeId].attempts.length + 1;
          const lifecycle = await assessDispatchLifecycle({ host, companyId, run, node, attempt, phase: 'work' });
          if (lifecycle.admission === 'blocked') { actions.push({ nodeId: item.nodeId, phase: 'work', status: 'blocked', reason: lifecycle.reason, lifecycle }); continue; }
          await engine.submitNode({ runId: currentId, nodeId: item.nodeId, actor: systemActor(),
            output: { automatedTransition: true }, idempotencyKey: `automatic:${currentId}:${item.nodeId}:${attempt}` });
          submitted = true;
        }
        if (submitted) continue;
      }
      for (const item of work) {
        if (workflowNodeIds.has(item.nodeId) || item.kind === 'automatic') continue;
        if (item.kind === 'human') actions.push({ nodeId: item.nodeId, phase: item.phase, status: 'waiting_human' });
        else if (item.kind === 'blocked') actions.push({ nodeId: item.nodeId, phase: item.phase, status: 'blocked', reason: item.reason });
        else if (item.role) {
          const node = run.graph.nodes.find((entry) => entry.id === item.nodeId);
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

  // The caller must compensate its retirements if Core does not advance.
  // A committed idempotent replay returns undefined without ledger mutations.
  async function assertRetrySafe(companyId, engine, runId, nodeId, idempotencyKey) {
    const snapshot = persistence.readState ? await persistence.readState(companyId) : null;
    if (idempotencyKey && Object.hasOwn(snapshot?.idempotency ?? {}, `retry:${runId}:${nodeId}:${idempotencyKey}`)) return undefined;
    const run = snapshot ? snapshot.runs?.[runId] : await engine.getRun(runId);
    const state = run?.nodeStates?.[nodeId];
    const node = run?.graph?.nodes?.find((item) => item.id === nodeId);
    if (!run || run.status !== 'running' || run.pendingHuman || run.conflicts.some((item) => item.status === 'waiting_human')) throw new Error('Node retry requires a running run without unresolved human decisions');
    if (!state || !node || !['task', 'decision'].includes(node.type)) throw new Error('Only task or decision nodes can be retried');
    const digest = runValidationDigest(run);
    const retiredOperations = [];
    const retirementOwner = `${retryAssignmentPrefix(runId, nodeId, idempotencyKey ?? randomUUID())}${randomUUID()}`;
    const expectedLinkedRunDigests = {};
    if (!persistence.getEffect && !persistence.retireAssignment) return { expectedRunDigest: digest, retiredOperations };
    const lastAttempt = state.attempts.length + (state.status === 'pending' ? 1 : 0);
    let parent;
    try {
      if (persistence.retireAssignment) {
        const pending = [{ run, nodeIds: affectedNodes(run, [nodeId]) }], seen = new Set();
        while (pending.length) {
          const target = pending.pop();
          if (seen.has(target.run.id)) continue;
          seen.add(target.run.id);
          if (target.run.id !== runId) expectedLinkedRunDigests[target.run.id] = runValidationDigest(target.run);
          for (const targetNodeId of target.nodeIds) {
            const targetState = target.run.nodeStates[targetNodeId];
            const targetNode = target.run.graph.nodes.find(item => item.id === targetNodeId);
            if (targetState?.childRunId) {
              const child = snapshot?.runs?.[targetState.childRunId] ?? await engine.getRun(targetState.childRunId);
              if (child?.parentWorkflow?.runId === target.run.id && child.parentWorkflow.nodeId === targetNodeId) {
                pending.push({ run: child, nodeIds: new Set(child.graph.nodes.map(item => item.id)) });
              }
            }
            if (!targetNode || !['task', 'decision'].includes(targetNode.type)) continue;
            const count = targetState.attempts.length + (targetState.status === 'pending' ? 1 : 0);
            for (let attempt = 1; attempt <= count; attempt++) {
              const phases = targetNode.review && attempt <= targetState.attempts.length ? ['work', 'supervisor'] : ['work'];
              for (const phase of phases) {
                const assignmentId = `issue-assign:${target.run.id}:${targetNodeId}:${attempt}:${phase}`;
                const assignment = await persistence.retireAssignment(companyId, assignmentId, retirementOwner);
                retiredOperations.push({ operationId: assignmentId, runId: target.run.id, nodeId: targetNodeId,
                  attempt, phase, kind: 'assignment', retirementOwner, inserted: assignment?.inserted === true });
                if (assignment?.outcome === 'unknown') throw new Error(
                  `Cannot retry node while a Paperclip issue assignment is in progress or unresolved (operation ${assignmentId}; issue ${assignment.request?.issueId ?? 'unknown'})`);
              }
            }
          }
        }
      }
      for (let attempt = 1; persistence.getEffect && attempt <= lastAttempt; attempt++) {
        // A pending attempt has no supervisor phase yet.
        const phases = node.review && attempt <= state.attempts.length ? ['work', 'supervisor'] : ['work'];
        for (const phase of phases) {
          const issueAttempt = assignedIssueAttempt(companyId, run, nodeId, attempt, phase);
          const { operationId } = issueAttempt;
          const effect = persistence.retireEffect
            ? await persistence.retireEffect(companyId, operationId)
            : await persistence.getEffect(companyId, operationId);
          if (persistence.retireEffect) retiredOperations.push({ operationId, attempt, phase, inserted: effect?.inserted === true });
          if (!effect || effect.outcome !== 'unknown') continue;
          const row = await persistence.get(companyId, runId, nodeId, attempt, phase);
          if (row?.issue_id && persistence.reconcileEffect) {
            // Only verified creation evidence can attach an issue to the dispatch.
            assertNoHumanOwner(await assertIssue(companyId, row.issue_id));
            await persistence.reconcileEffect(companyId, operationId, { issueId: row.issue_id });
            continue;
          }
          parent ??= await assertIssue(companyId, run.input.paperclipIssueId);
          const evidence = await lookupAssignedIssue(issueAttempt, row?.agent_id, parent);
          if (evidence.status === 'matched' && evidence.reconcile) {
            await evidence.reconcile();
          } else if (evidence.status === 'ownership_conflict') {
            assertNoHumanOwner(evidence.issue);
          } else if (evidence.status === 'absent') {
            // Only the database clock can age a database-created effect safely.
            const settlement = await persistence.settleAbsentEffect?.(companyId, operationId, effectSettleGraceMs,
              { settledBy: 'owner-retry', lookup: 'absent' });
            if (settlement?.outcome === 'confirmed_success') continue;
            if (!settlement?.settled) {
              const retry = settlement?.retryAt ? `retry after ${new Date(settlement.retryAt).toISOString()}`
                : `retry requires database settlement with a ${effectSettleGraceMs}ms grace period`;
              throw new Error(`Cannot retry node while a Paperclip issue creation may still be in progress (origin lookup absent; ${retry})`);
            }
          } else {
            throw new Error(`Cannot retry node while a Paperclip issue creation outcome is unresolved (origin lookup ${evidence.status})`);
          }
        }
      }
    } catch (error) {
      try { await rollbackRetryEffects(companyId, engine, runId, nodeId, retiredOperations); }
      catch {} // Rollback logs its failure; preserve the guard's rejection.
      throw error;
    }
    return { expectedRunDigest: digest, expectedLinkedRunDigests, retiredOperations };
  }

  async function releaseRetryAssignments(companyId, operations = []) {
    for (const owner of new Set(operations.filter(item => item.inserted).map(item => item.retirementOwner))) {
      const operationIds = operations.filter(item => item.inserted && item.retirementOwner === owner).map(item => item.operationId);
      try { await persistence.cancelAssignments(companyId, operationIds, owner); }
      catch (error) {
        host.logger?.error?.('Retry assignment guard cleanup deferred', { companyId, operationIds, retirementOwner: owner, error: errorMessage(error) });
        throw error;
      }
    }
  }

  async function rollbackRetryEffects(companyId, engine, runId, nodeId, retiredOperations = []) {
    let assignmentRollbackError;
    try { await releaseRetryAssignments(companyId, retiredOperations.filter(item => item.kind === 'assignment')); }
    catch (error) { assignmentRollbackError = error; }
    const inserted = retiredOperations.filter(item => item.inserted && item.kind !== 'assignment');
    if (!inserted.length) { if (assignmentRollbackError) throw assignmentRollbackError; return; }
    let operationIds = inserted.map(item => item.operationId);
    try {
      const snapshot = persistence.readState ? await persistence.readState(companyId) : null;
      const current = [];
      for (const item of inserted) {
        const targetRunId = item.runId ?? runId, targetNodeId = item.nodeId ?? nodeId;
        const run = snapshot ? snapshot.runs?.[targetRunId] : await engine.getRun(targetRunId);
        const state = run?.nodeStates?.[targetNodeId];
        if (!['pending', 'awaiting_self_review', 'awaiting_supervisor_review'].includes(state?.status)) continue;
        let child = run, linked = true;
        const seen = new Set([run.id]);
        while (child.parentWorkflow) {
          const ref = child.parentWorkflow;
          if (seen.has(ref.runId)) { linked = false; break; }
          seen.add(ref.runId);
          const parent = snapshot ? snapshot.runs?.[ref.runId] : await engine.getRun(ref.runId);
          const parentState = parent?.nodeStates?.[ref.nodeId];
          if (parentState?.childRunId !== child.id || parentState.status !== 'waiting_child' ||
              parentState.attempts?.[ref.attempt - 1]?.childRunId !== child.id) { linked = false; break; }
          child = parent;
        }
        if (!linked) continue;
        const phases = state.status === 'awaiting_supervisor_review' ? ['supervisor']
          : state.status === 'awaiting_self_review' ? ['work', 'supervisor'] : ['work'];
        const attempt = (state.attempts?.length ?? 0) + (state.status === 'pending' ? 1 : 0);
        // Release all still-reachable phases for this surviving identity. A
        // committed retry's abandoned identities retain their retirement owners.
        if (item.attempt === attempt && phases.includes(item.phase)) current.push(item);
      }
      operationIds = current.map(item => item.operationId);
      const creations = current.filter(item => item.kind !== 'assignment').map(item => item.operationId);
      if (creations.length) await persistence.cancelRetirements(companyId, creations);
    } catch (error) {
      host.logger?.error?.('Retry effect rollback failed; leftover tombstones need operator review', { operationIds, error: errorMessage(error) });
      throw error;
    }
    if (assignmentRollbackError) throw assignmentRollbackError;
  }

  async function retryNode(companyId, engine, input) {
    const { runId, nodeId, idempotencyKey } = input;
    const retry = await assertRetrySafe(companyId, engine, runId, nodeId, idempotencyKey);
    let result;
    try {
      result = await engine.retryNode({ ...input, expectedRunDigest: retry?.expectedRunDigest, expectedLinkedRunDigests: retry?.expectedLinkedRunDigests });
    } catch (error) {
      try { await rollbackRetryEffects(companyId, engine, runId, nodeId, retry?.retiredOperations); }
      catch {} // Preserve the original error, including its authorization status.
      throw error;
    }
    let cleanupPending = false;
    try {
      const assignmentOperations = idempotencyKey && persistence.listAssignmentRetirements
        ? await persistence.listAssignmentRetirements(companyId, retryAssignmentPrefix(runId, nodeId, idempotencyKey))
        : retry?.retiredOperations?.filter(item => item.kind === 'assignment');
      await releaseRetryAssignments(companyId, assignmentOperations);
    } catch (error) {
      cleanupPending = true;
      host.logger?.error?.('Retry committed; assignment guards require cleanup', { companyId, runId, nodeId, idempotencyKey, error: errorMessage(error) });
    }
    if (result.nextAttempt === null) {
      await rollbackRetryEffects(companyId, engine, runId, nodeId,
        retry?.retiredOperations?.filter(item => item.kind !== 'assignment'));
    } else {
      // A concurrent loser may have removed a shared tombstone after reading state.
      // The retry is committed: report re-assert failures instead of failing the request.
      for (const { operationId, attempt, phase } of (retry?.retiredOperations ?? []).filter(item => item.inserted === false && item.kind !== 'assignment')) {
        try {
          const effect = await persistence.retireEffect(companyId, operationId);
          if (effect?.outcome === 'unknown') host.logger?.warn?.('Paperclip issue creation began for an attempt abandoned by retry',
            { operationId, companyId, runId, nodeId, attempt, phase });
        } catch (error) {
          host.logger?.error?.('Retry tombstone re-assert failed; abandoned attempt needs operator review',
            { operationId, companyId, runId, nodeId, attempt, phase, error: errorMessage(error) });
        }
      }
    }
    return cleanupPending ? { ...result, dispatchCleanupPending: true } : result;
  }

  async function currentDispatches(companyId, run, { includeReceipts = false } = {}) {
    if ((!run.deliveryKey && !includeReceipts) || !persistence.get) return [];
    return (await Promise.all(run.graph.nodes.flatMap((node) => {
      const nodeState = run.nodeStates[node.id];
      if (!['pending', 'awaiting_self_review', 'awaiting_supervisor_review'].includes(nodeState?.status)) return [];
      const phase = nodeState.status === 'awaiting_supervisor_review' ? 'supervisor' : 'work';
      const attempt = (nodeState.attempts?.length ?? 0) + (nodeState.status === 'pending' ? 1 : 0);
      return [Promise.resolve(persistence.get(companyId, run.id, node.id, attempt, phase)).then(async (row) => {
        if (!row) return null;
        let assignment, receiptStatus;
        if (includeReceipts) {
          const { operationId, assignmentOperationId } = assignedIssueAttempt(companyId, run, node.id, attempt, phase);
          if (row.issue_id) {
            assignment = await persistence.getAssignment?.(companyId, assignmentOperationId);
            if (assignment?.outcome === 'unknown') receiptStatus = 'assignment_pending';
          } else if ((await persistence.getEffect?.(companyId, operationId))?.outcome === 'unknown') {
            receiptStatus = 'effect_unknown';
          }
        }
        return { runId: run.id, nodeId: node.id, phase, attempt, issueId: row.issue_id,
          agentId: row.agent_id, agentRunId: row.agent_run_id, state: row.state,
          normalizedState: normalizeDispatchState(row, { assignment }),
          ...(receiptStatus && { receiptStatus }),
          workspaceAdmission: node.workspace?.writeAccess === 'exclusive' || run.pack?.workspace?.writeAccess === 'exclusive'
            ? 'exclusive_required' : 'legacy_unmanaged' };
      })];
    }))).filter(Boolean);
  }
  const dispatchAdmission = createDispatchAdmission(persistence, currentDispatches);

  return { dispatchReady, assertAgentCallback, currentDispatches, assertRetrySafe, rollbackRetryEffects, retryNode };
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
