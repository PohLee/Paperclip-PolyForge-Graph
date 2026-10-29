const kinds = new Set(['retry', 'judge', 'approve', 'carry', 'trigger', 'stand-in']);

async function assertSources(engine, runId, evidence) {
  const run = await engine.getRun(runId);
  if (!run) throw new Error('Run not found');
  const decisions = await engine.listDecisions({ runId });
  for (const item of evidence) {
    const ref = item.sourceRef;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error('Evidence sourceRef is required');
    if (ref.kind === 'run_input' && typeof ref.key === 'string' && Object.hasOwn(run.input, ref.key)) continue;
    if (ref.kind === 'decision' && decisions.some(decision => decision.id === ref.id)) continue;
    if (ref.kind === 'artifact' && typeof ref.id === 'string' && typeof ref.version === 'string' &&
        Object.values(run.nodeStates).some(state => [...(state.artifacts ?? []),
          ...(state.attempts ?? []).flatMap(attempt => attempt.artifacts ?? [])]
          .some(artifact => artifact.id === ref.id && artifact.version === ref.version))) continue;
    if (ref.kind === 'product_decision' && typeof ref.id === 'string' && run.input.feature &&
        (await engine.getProductMemory(run.input.feature)).active.some(decision => decision.id === ref.id)) continue;
    if (ref.kind === 'external' && typeof ref.url === 'string' && /^https?:\/\/[^\s/]+/i.test(ref.url)) continue;
    throw new Error('Evidence sourceRef does not resolve within this run');
  }
}

export async function recordIntervention(engine, { runId, nodeId = null, actor, kind, reason,
  evidence, outcomeSignal, idempotencyKey }) {
  if (!kinds.has(kind)) throw new Error('Unknown intervention kind');
  if (!reason?.trim() || !Array.isArray(evidence) || !evidence.length ||
      !evidence.every(item => item.sourceRef) || !outcomeSignal?.trim()) {
    throw new Error('Intervention needs a reason, sourced evidence and outcome signal');
  }
  if (actor?.kind !== 'human') throw new Error('Record a human intervention with a human actor');
  await assertSources(engine, runId, evidence);
  return engine.recordDecision({ type: 'human_intervention', status: 'observed', outcome: kind,
    reason, actor, runId, nodeId, evidence: [...evidence, { kind: 'outcome_signal', summary: outcomeSignal }],
    idempotencyKey });
}

export async function proposeInterventionImprovement(engine, { runId, actor, interventionIds,
  mechanism, expectedOutcome, evidence, idempotencyKey }) {
  if (actor?.kind !== 'human') throw new Error('Improvement proposal requires a human actor');
  if (!Array.isArray(interventionIds) || !interventionIds.length ||
      new Set(interventionIds).size !== interventionIds.length || !mechanism?.trim() ||
      !expectedOutcome?.trim() || !Array.isArray(evidence) || !evidence.length ||
      !evidence.every(item => item.sourceRef)) {
    throw new Error('Proposal needs intervention IDs, a mechanism, expected outcome and evidence');
  }
  const observed = (await engine.listDecisions({ runId })).filter(item =>
    ['human_intervention', 'node_retry'].includes(item.type) && interventionIds.includes(item.id));
  if (observed.length !== interventionIds.length) throw new Error('Proposal references unknown interventions in this run');
  await assertSources(engine, runId, evidence);
  return engine.recordDecision({ type: 'intervention_improvement', status: 'proposed',
    outcome: expectedOutcome, reason: mechanism, actor, runId, evidence,
    affectedRefs: interventionIds.map(id => ({ kind: 'decision', id })), idempotencyKey });
}

export async function updateInterventionImprovement(engine, { runId, actor, previousDecisionId,
  status, reason, evidence, outcomeSignal, idempotencyKey }) {
  if (actor?.kind !== 'human' || !actor.roles?.includes('human-owner')) {
    throw new Error('Improvement status change requires a human owner');
  }
  if (!reason?.trim() || !outcomeSignal?.trim() || !Array.isArray(evidence) || !evidence.length ||
      !evidence.every(item => item.sourceRef)) {
    throw new Error('Status change needs reason, sourced evidence and outcome signal');
  }
  await assertSources(engine, runId, evidence);
  return engine.transitionImprovement({ runId, actor, previousDecisionId, status, reason,
    evidence: [...evidence, { kind: 'outcome_signal', summary: outcomeSignal }], idempotencyKey });
}

export async function interventionReport(engine, runId) {
  const run = await engine.getRun(runId);
  if (!run) throw new Error('Run not found');
  const decisions = await engine.listDecisions({ runId });
  const observed = decisions.filter(item => item.type === 'human_intervention' || item.type === 'node_retry')
    .map(item => item.type === 'node_retry' ? { ...item, outcome: 'retry', inferredFromGraphAction: true } : item);
  const proposals = decisions.filter(item => item.type === 'intervention_improvement');
  const superseded = new Set(proposals.map(item => item.supersedes).filter(Boolean));
  const counts = Object.fromEntries([...kinds].map(kind => [kind, observed.filter(item => item.outcome === kind).length]));
  return { runId, runStatus: run.status, counts, observed, proposals,
    activeProposals: proposals.filter(item => !superseded.has(item.id)),
    outcomeKnown: run.status === 'completed' || run.status === 'stopped',
    completionCount: run.status === 'completed' ? 1 : 0 };
}
