const answer = (answers, id) => answers.find((item) => item.questionId === id);
const answerText = (answers, id) => answer(answers, id)?.otherText ?? answer(answers, id)?.text ?? '';
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

async function proposalIssue(host, companyId, proposal) {
  if (proposal.issueId) return proposal.issueId;
  const originKind = `plugin:${host.manifest.id}:product-decision`;
  const found = await host.issues.list({ companyId, originKind, originId: proposal.id, limit: 2 });
  if (found.length > 1) throw new Error(`Duplicate product Decision issue for ${proposal.id}`);
  const issue = found[0] ?? await host.issues.create({ companyId,
    title: `Product Decision · ${proposal.feature}`,
    description: proposalDescription(proposal),
    status: 'todo', originKind, originId: proposal.id });
  return issue.id;
}

async function questionCard(host, companyId, targetIssueId, proposal, boardId, interactions, deferrals) {
  const idempotencyKey = cardKey(proposal.id, deferrals);
  return interactions.find((item) => item.idempotencyKey === idempotencyKey) ??
    host.issues.askUserQuestions(targetIssueId, {
      title: `Product Decision · ${proposal.feature}`,
      summary: `Proposed behavior: ${proposal.outcome}`,
      addresseeUserId: boardId, resolverPolicy: 'human_only', continuationPolicy: 'none', idempotencyKey,
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
    }, companyId);
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
    const targetIssueId = await proposalIssue(host, companyId, proposal);
    const interactions = await host.issues.listInteractions(targetIssueId, companyId);
    const deferrals = records.filter((item) => item.type === 'product' && item.proposalId === proposal.id &&
      item.status === 'deferred').length;
    const card = await questionCard(host, companyId, targetIssueId, proposal, boardId, interactions, deferrals);
    let syncError = null, decisionId = null;
    const current = (await engine.getProductMemory(proposal.feature)).active;
    if (!baselineIsActive(proposal, current)) {
      result.push(await invalidateStale(engine, proposal, targetIssueId, card.id));
      continue;
    }
    if (card.resolvedByUserId && card.result?.answers?.length) {
      try {
        const trusted = await trustedActor(companyId,
          { actorType: 'user', userId: card.resolvedByUserId }, config);
        if (trusted.actor.kind !== 'human' || !trusted.actor.roles.includes('human-owner')) {
          throw new Error('Product Decision resolver lacks human-owner role');
        }
        const outcome = answer(card.result.answers, 'choice')?.optionIds?.[0];
        const status = finalStatus[outcome];
        const reason = answerText(card.result.answers, 'reason').trim();
        if (!status || !reason) throw new Error('Product Decision choice and reason are required');
        const decision = await engine.recordProductDecision({
          feature: proposal.feature, actor: trusted.actor, status, outcome: proposal.outcome, reason,
          supersedes: proposal.supersedes, proposalId: proposal.id,
          changeScope: proposal.changeScope ?? [], runId: proposal.runId,
          issueId: targetIssueId,
          evidence: [...proposal.evidence, { kind: 'paperclip_decision', interactionId: card.id,
            issueId: targetIssueId, proposalId: proposal.id, choice: outcome, reason }],
          idempotencyKey: `native-product:${card.id}`,
        });
        decisionId = decision.id;
        if (status === 'deferred') {
          await questionCard(host, companyId, targetIssueId, proposal, boardId,
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
