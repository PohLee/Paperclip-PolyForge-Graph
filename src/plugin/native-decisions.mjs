import { createHash } from 'node:crypto';
import { createDecisionHandoff } from './decision-handoff.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const answer = (answers, id) => answers.find((item) => item.questionId === id);
const answerText = (answers, id) => answer(answers, id)?.otherText ?? answer(answers, id)?.text ?? '';
const refs = (artifacts) => artifacts.map((item) => ({ artifactId: item.id, version: item.version }));

function contractQuestions(run, node, existingEvidence) {
  const questions = [], build = (answers, outcome) => {
    const evidence = [], artifacts = [];
    for (const [index, kind] of (run.pack.decisionRules?.find((rule) => rule.type ===
      (node.decisionType ?? node.id) && rule.mode === run.mode)?.requiredEvidence ?? []).entries()) {
      if (hasComplete(kind)) continue;
      const summary = answerText(answers, `evidence-${index}`).trim();
      if (summary) evidence.push({ kind, summary, subjectRefs: refs(candidateArtifacts) });
    }
    if (node.decisionContract?.type === 'acceptance-proof' && ['accept', 'ready', 'merged'].includes(outcome)) {
      const source = run.nodeStates[node.decisionContract.sourceNode];
      const matrix = source?.artifacts?.find((item) => item.kind === 'acceptance_matrix');
      for (const [index, row] of (source?.output?.criteria ?? []).filter((item) => item.result === 'unverified').entries()) {
        evidence.push({ kind: 'acceptance_exception', criterionId: row.id,
          reason: answerText(answers, `exception-reason-${index}`).trim(),
          risk: answerText(answers, `exception-risk-${index}`).trim(),
          subjectRefs: matrix ? refs([matrix]) : [] });
      }
    }
    if (node.decisionContract?.type === 'technical-design-approval' && ['accept', 'ready', 'merged'].includes(outcome)) {
      const source = run.nodeStates[node.decisionContract.sourceNode];
      const design = run.nodeStates['draft-technical-design']?.artifacts?.find((item) => item.kind === 'technical_design');
      const audit = source?.artifacts?.find((item) => item.kind === 'design_audit');
      for (const [index, finding] of (source?.output?.findings ?? []).entries()) {
        evidence.push({ kind: 'design_finding_disposition', findingId: finding.id,
          status: answer(answers, `finding-status-${index}`)?.optionIds?.[0],
          reason: answerText(answers, `finding-reason-${index}`).trim(),
          proofRef: answerText(answers, `finding-proof-${index}`).trim(),
          subjectRefs: refs([design, audit].filter(Boolean)) });
      }
    }
    if (node.selection && outcome === 'accept') {
      const selected = answer(answers, 'selected-artifact')?.optionIds?.[0];
      const item = candidateArtifacts.find((candidate) => `${candidate.id}@${candidate.version}` === selected);
      if (item) artifacts.push(item);
    }
    return { evidence, artifacts };
  };
  const candidateArtifacts = (node.candidateNodes ?? []).flatMap((id) => run.nodeStates[id]?.artifacts ?? []);
  const hasComplete = (kind) => existingEvidence.some((item) => item.kind === kind &&
    candidateArtifacts.every((candidate) => item.subjectRefs?.some((ref) =>
      ref.artifactId === candidate.id && ref.version === candidate.version)));
  const rule = run.pack.decisionRules?.find((item) => item.type === (node.decisionType ?? node.id) && item.mode === run.mode);
  for (const [index, kind] of (rule?.requiredEvidence ?? []).entries()) {
    if (!hasComplete(kind)) questions.push({ id: `evidence-${index}`,
      prompt: `Evidence for ${kind} (refer to the pinned candidate)`, required: true, answerMode: 'text' });
  }
  if (node.decisionContract?.type === 'acceptance-proof') {
    const source = run.nodeStates[node.decisionContract.sourceNode];
    for (const [index, row] of (source?.output?.criteria ?? []).filter((item) => item.result === 'unverified').entries()) {
      questions.push({ id: `exception-reason-${index}`, prompt: `Exception reason for ${row.id}, if accepting`, required: false, answerMode: 'text' },
        { id: `exception-risk-${index}`, prompt: `Known risk for ${row.id}, if accepting`, required: false, answerMode: 'text' });
    }
  }
  if (node.decisionContract?.type === 'technical-design-approval') {
    const source = run.nodeStates[node.decisionContract.sourceNode];
    for (const [index, finding] of (source?.output?.findings ?? []).entries()) questions.push(
      { id: `finding-status-${index}`, prompt: `Disposition for ${finding.id}, if accepting`, required: false,
        answerMode: 'single_select', options: [{ id: 'resolved', label: 'Resolved' }, { id: 'accepted-risk', label: 'Accept risk' }] },
      { id: `finding-reason-${index}`, prompt: `Reason for ${finding.id}`, required: false, answerMode: 'text' },
      { id: `finding-proof-${index}`, prompt: `Resolution proof for ${finding.id}, if resolved`, required: false, answerMode: 'text' });
  }
  if (node.selection) questions.push({ id: 'selected-artifact', prompt: 'Pinned artifact to select, if accepting',
    required: false, answerMode: 'single_select', options: candidateArtifacts.map((item) =>
      ({ id: `${item.id}@${item.version}`, label: `${item.id}@${item.version}` })) });
  return { questions, build };
}

/** Mirror a paused Graph choice into Paperclip's native Decision interaction. */
export async function syncGraphDecision({ host, companyId, run, engine, control, config,
  trustedActor, dispatchReady }) {
  const handoff = createDecisionHandoff({ host, companyId, config, trustedActor });
  const rootIssueId = run?.input?.paperclipIssueId;
  if (!rootIssueId || run.status !== 'paused') return [];
  const setup = await control.getSetup();
  if (!setup.organization?.board?.id) return [];
  const choices = [];
  if (run.pendingHuman?.kind === 'decision') {
    const node = run.graph.nodes.find((item) => item.id === run.pendingHuman.nodeId);
    const escalation = (await engine.listDecisions({ runId: run.id }))
      .find((item) => item.id === run.pendingHuman.escalationDecisionId);
    choices.push({ key: `gate:${run.pendingHuman.nodeId}:${run.pendingHuman.escalationDecisionId}`,
      kind: 'decision', nodeId: node.id, node, escalation, title: `Graph Decision · ${node.id}`,
      options: (node.outcomes ?? [...new Set(run.graph.edges.filter((edge) => edge.from === node.id)
        .flatMap((edge) => Array.isArray(edge.when) ? edge.when : edge.when ? [edge.when] : []))])
        .map((id) => ({ id, label: id })),
      candidateRefs: (node.candidateNodes ?? []).flatMap((id) => run.nodeStates[id]?.artifacts ?? []) });
  }
  if (run.pendingHuman?.kind === 'rework_limit') choices.push({
    key: `rework:${run.pendingHuman.nodeId}:${run.pendingHuman.decisionId}`,
    kind: 'rework_limit', nodeId: run.pendingHuman.nodeId, title: 'Rework limit Decision',
    options: [{ id: 'continue', label: 'Continue rework' }, { id: 'stop', label: 'Stop work' }], candidateRefs: [],
  });
  for (const conflict of run.conflicts?.filter((item) => item.status === 'waiting_human') ?? []) choices.push({
    key: `conflict:${conflict.id}`, kind: 'conflict', conflictId: conflict.id,
    conflict,
    nodeId: conflict.nodeId, title: 'CPO / CTO Decision',
    options: conflict.options.map((item) => ({ id: item.id, label: item.label ?? item.id })),
    candidateRefs: [],
  });
  if (run.takeover) choices.push({ key: `takeover:${run.takeover.id}`, kind: 'takeover',
    takeoverId: run.takeover.id, nodeId: run.takeover.nodeId, title: 'Human takeover Decision',
    options: [{ id: 'resume', label: 'Resume agents' }, { id: 'stop', label: 'Stop work' }], candidateRefs: [],
  });
  if (!choices.length) return [];
  const interactions = await host.issues.listInteractions(rootIssueId, companyId);
  const result = [];
  for (const choice of choices) {
    const contract = choice.node ? contractQuestions(run, choice.node, choice.escalation?.evidence ?? []) : null;
    const version = digest({ key: choice.key, candidates: choice.candidateRefs,
      contract: choice.node?.decisionContract, questions: contract?.questions });
    const idempotencyKey = `polyforge-graph-decision:${run.id}:${choice.key}:${version}`;
    const card = await handoff.card(rootIssueId, { interactions, idempotencyKey,
      title: choice.title,
      summary: `Graph ${run.graph.id}, node ${choice.nodeId}`,
      addresseeUserId: setup.organization.board.id,
      payload: { version: 1, title: choice.title, submitLabel: 'Record Decision',
        questionSet: { schema: 'paperclip.question_set.v1',
          description: choice.candidateRefs.length ? `Pinned candidates: ${choice.candidateRefs.map((ref) => `${ref.id}@${ref.version}`).join(', ')}` : undefined,
          questions: [
            { id: 'choice', prompt: 'Choose the next step', required: true, answerMode: 'single_select',
              options: choice.options },
            { id: 'reason', prompt: 'Why?', required: true, answerMode: 'text' },
            ...(contract?.questions ?? []),
          ] },
      },
    });
    let syncError = null;
    if (card.resolvedByUserId && card.result?.answers?.length) {
      try {
        const resolved = await handoff.answer(rootIssueId, card);
        const outcome = resolved.choice, reason = resolved.boardReason;
        if (!choice.options.some((item) => item.id === outcome)) throw new Error('Paperclip Decision outcome is invalid');
        const evidence = [{ ...resolved.receipt,
          reason, subjectRefs: choice.candidateRefs.map((ref) => ({ artifactId: ref.id, version: ref.version })) }];
        if (choice.kind === 'decision') {
          const extra = contract.build(resolved.answers, outcome);
          const priorEvidence = (choice.escalation?.evidence ?? []).filter((item) =>
            !extra.evidence.some((replacement) => replacement.kind === item.kind));
          await engine.resolveHumanGate({ runId: run.id, nodeId: choice.nodeId, actor: resolved.actor,
            outcome, reason, evidence: [...priorEvidence, ...evidence, ...extra.evidence],
            artifacts: extra.artifacts,
            idempotencyKey: `native:${card.id}` });
        } else if (choice.kind === 'rework_limit') {
          await engine.resolveReworkLimit({ runId: run.id, actor: resolved.actor,
            outcome, reason, idempotencyKey: `native:${card.id}` });
        } else if (choice.kind === 'conflict') {
          const sourceDecisionId = choice.conflict.positionDecisionIds?.cpo ?? choice.conflict.escalationDecisionId;
          const sourcedEvidence = [{ ...resolved.receipt, summary: reason,
            sourceRef: sourceDecisionId ? { kind: 'decision', id: sourceDecisionId } : undefined }];
          await engine.resolveConflict({ runId: run.id, conflictId: choice.conflictId,
            actor: resolved.actor, outcome, reason, evidence: sourcedEvidence,
            idempotencyKey: `native:${card.id}` });
        } else if (choice.kind === 'takeover') {
          await control.resolveTakeover({ runId: run.id, takeoverId: choice.takeoverId,
            actor: resolved.actor, outcome, reason, idempotencyKey: `native:${card.id}` });
        }
        const updated = await engine.getRun(run.id);
        if (updated.status === 'running') await dispatchReady(companyId, engine, run.id, config);
      } catch (error) { syncError = error instanceof Error ? error.message : String(error); }
    }
    result.push({ kind: choice.kind, runId: run.id, nodeId: choice.nodeId, issueId: rootIssueId,
      interactionId: card.id, status: card.status, candidateVersion: version,
      url: `/issues/${rootIssueId}`, syncError });
  }
  return result;
}
