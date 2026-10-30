/** Native Paperclip projection of a Core human decision for one company. */
export function createDecisionHandoff({ host, companyId, config, trustedActor }) {
  return {
    async issue({ originKind, originId, title, description, duplicateError }) {
      const found = await host.issues.list({ companyId, originKind, originId, limit: 2 });
      if (found.length > 1) throw new Error(duplicateError);
      const issue = found[0] ?? await host.issues.create({ companyId, title, description,
        status: 'todo', originKind, originId });
      return issue.id;
    },

    async card(issueId, { interactions, idempotencyKey, title, summary, addresseeUserId, payload }) {
      const existing = interactions ?? await host.issues.listInteractions(issueId, companyId);
      return existing.find((item) => item.idempotencyKey === idempotencyKey) ??
        host.issues.askUserQuestions(issueId, { title, summary, addresseeUserId,
          resolverPolicy: 'human_only', continuationPolicy: 'none', idempotencyKey,
          payload }, companyId);
    },

    /** Never trust the card's claimed resolver or parse its answer before authentication. */
    async answer(issueId, card, authorityError = 'Decision resolver lacks human-owner role') {
      if (!card.resolvedByUserId || !card.result?.answers?.length) return null;
      const trusted = await trustedActor(companyId,
        { actorType: 'user', userId: card.resolvedByUserId }, config);
      if (!trusted.actor.roles.includes('human-owner')) throw new Error(authorityError);
      const answers = card.result.answers;
      const choice = answers.find((item) => item.questionId === 'choice')?.optionIds?.[0];
      const reasonAnswer = answers.find((item) => item.questionId === 'reason');
      return { actor: trusted.actor, choice, answers,
        requiredReason: (reasonAnswer?.otherText ?? reasonAnswer?.text ?? '').trim(),
        boardReason: reasonAnswer?.otherText ?? card.result.reason ?? `Board selected ${choice}`,
        receipt: { kind: 'paperclip_decision', interactionId: card.id, issueId } };
    },
  };
}
