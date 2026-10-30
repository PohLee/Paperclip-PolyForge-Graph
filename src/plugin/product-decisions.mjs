import { createDecisionHandoff } from './decision-handoff.mjs';
const finalStatus = { approve: 'approved', reject: 'rejected', defer: 'deferred' };
const cardKey = (proposalId, deferrals) => `polyforge-product-decision:${proposalId}${deferrals ? `:${deferrals}` : ''}`;
const baselineIsActive = (proposal, active) => proposal.supersedes
  ? active.some((item) => item.id === proposal.supersedes) : active.length === 0;
const staleWarning = 'The proposal baseline changed. Any existing question card is stale and cannot approve this proposal.';
const proposalDescription = (proposal) => [
  `Proposal ${proposal.id}`,
  `Behavior: ${proposal.outcome}`,
  `Supersedes: ${proposal.supersedes ?? 'no prior decision'}`,
  `Scope: ${(proposal.changeScope ?? []).join(', ') || 'unspecified'}`,
  `Reason: ${proposal.reason}`,
  ...proposal.evidence.map((item) => `${item.kind}: ${item.summary ?? item.id ?? 'recorded evidence'}`),
].join('\n').slice(0, 4000);

async function proposalIssue(handoff, host, proposal) {
  if (proposal.issueId) return proposal.issueId;
  return handoff.issue({
    originKind: `plugin:${host.manifest.id}:product-decision`, originId: proposal.id,
    title: `Product Decision · ${proposal.feature}`,
    description: proposalDescription(proposal),
    duplicateError: `Duplicate product Decision issue for ${proposal.id}` });
}

async function questionCard(handoff, targetIssueId, proposal, boardId, interactions, deferrals) {
  const idempotencyKey = cardKey(proposal.id, deferrals);
  return handoff.card(targetIssueId, { interactions, idempotencyKey,
    title: `Product Decision · ${proposal.feature}`,
    summary: `Proposed behavior: ${proposal.outcome}`,
    addresseeUserId: boardId,
    payload: { version: 1, title: `Product Decision · ${proposal.feature}`, submitLabel: 'Record decision',
      questionSet: { schema: 'paperclip.question_set.v1',
        description: proposalDescription(proposal),
        questions: [
          { id: 'choice', prompt: 'What should happen to this proposed behavior?', required: true,
            answerMode: 'single_select', options: [
              { id: 'approve', label: 'Approve change' },
              { id: 'reject', label: 'Reject change' },
              { id: 'defer', label: 'Defer decision' },
            ] },
          { id: 'reason', prompt: 'Why?', required: true, answerMode: 'text' },
        ] },
    },
  });
}

async function invalidateStale(engine, proposal, issueId, interactionId) {
  const decision = await engine.invalidateProductProposal({ proposalId: proposal.id,
    reason: 'The proposal baseline is no longer active',
    idempotencyKey: `stale-product:${proposal.id}` });
  return { kind: 'product_decision', proposalId: proposal.id, decisionId: decision.id,
    issueId, interactionId, status: 'stale', warning: staleWarning, syncError: null };
}

/** Materialize an unresolved product proposal as a native Paperclip human Decision. */
export async function syncProductDecisionCards({ host, companyId, engine, control, config,
  trustedActor, issueId = null }) {
  const handoff = createDecisionHandoff({ host, companyId, config, trustedActor });
  const records = await engine.listDecisions();
  const resolved = new Set(records.filter((item) => item.type === 'product' && item.proposalId &&
    ['approved', 'rejected', 'invalidated'].includes(item.status)).map((item) => item.proposalId));
  const proposals = records.filter((item) => item.type === 'product' && item.status === 'proposed' &&
    !resolved.has(item.id) && (!issueId || item.issueId === issueId));
  const setup = await control.getSetup();
  let boardId = setup.organization?.board?.id;
  if (!boardId) {
    const members = await host.access?.members?.list({ companyId }) ?? [];
    const owners = members.filter((item) => item.principalType === 'user' &&
      item.membershipRole === 'owner' && item.status === 'active');
    boardId = owners.length === 1 ? owners[0].principalId : null;
  }
  const result = [];
  for (const proposal of proposals) {
    const active = (await engine.getProductMemory(proposal.feature)).active;
    if (!baselineIsActive(proposal, active)) {
      result.push(await invalidateStale(engine, proposal, proposal.issueId ?? null, null));
      continue;
    }
    if (!boardId) continue;
    const targetIssueId = await proposalIssue(handoff, host, proposal);
    const interactions = await host.issues.listInteractions(targetIssueId, companyId);
    const deferrals = records.filter((item) => item.type === 'product' && item.proposalId === proposal.id &&
      item.status === 'deferred').length;
    const card = await questionCard(handoff, targetIssueId, proposal, boardId, interactions, deferrals);
    let syncError = null, decisionId = null;
    const current = (await engine.getProductMemory(proposal.feature)).active;
    if (!baselineIsActive(proposal, current)) {
      result.push(await invalidateStale(engine, proposal, targetIssueId, card.id));
      continue;
    }
    if (card.resolvedByUserId && card.result?.answers?.length) {
      try {
        const resolved = await handoff.answer(targetIssueId, card,
          'Product Decision resolver lacks human-owner role');
        if (resolved.actor.kind !== 'human') throw new Error('Product Decision resolver lacks human-owner role');
        const outcome = resolved.choice, reason = resolved.requiredReason;
        const status = finalStatus[outcome];
        if (!status || !reason) throw new Error('Product Decision choice and reason are required');
        const decision = await engine.recordProductDecision({
          feature: proposal.feature, actor: resolved.actor, status, outcome: proposal.outcome, reason,
          supersedes: proposal.supersedes, proposalId: proposal.id,
          changeScope: proposal.changeScope ?? [], runId: proposal.runId,
          issueId: targetIssueId,
          evidence: [...proposal.evidence, { ...resolved.receipt,
            proposalId: proposal.id, choice: outcome, reason }],
          idempotencyKey: `native-product:${card.id}`,
        });
        decisionId = decision.id;
        if (status === 'deferred') {
          await questionCard(handoff, targetIssueId, proposal, boardId,
            interactions, deferrals + 1);
        }
      } catch (error) {
        syncError = error instanceof Error ? error.message : String(error);
        if (['Product proposal baseline is stale', 'Only an active product decision can be superseded']
          .includes(syncError)) {
          result.push(await invalidateStale(engine, proposal, targetIssueId, card.id));
          continue;
        }
      }
    }
    result.push({ kind: 'product_decision', proposalId: proposal.id, decisionId,
      issueId: targetIssueId, interactionId: card.id, status: card.status,
      url: `/issues/${targetIssueId}`, syncError });
  }
  return result;
}
