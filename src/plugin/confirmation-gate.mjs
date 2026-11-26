import { createHash } from 'node:crypto';
import { decisionOutcomes, runValidationDigest } from '../core/index.mjs';

export async function confirmationGateConfig(host, companyId, run, node) {
  if (node?.type !== 'decision') return null;
  const type = node.decisionType ?? node.id;
  const g2 = run.graph.id === 'requirements-baseline' && run.graph.version === '0.1.2' && node.id === 'requirements-gate';
  const operator = await host.config?.get(companyId);
  const project = operator?.adlcProjects?.[run.input.projectId];
  const configured = project?.confirmationGates?.[type];
  if (!project?.ownerId || (!g2 && !configured)) return null;
  return { ...configured, ownerId: project.ownerId };
}

export async function syncConfirmationGate({ host, companyId, run, node, engine, trustedActor, config, confirmation }) {
  const issueId = run.input.paperclipIssueId;
  if (!issueId) throw new Error('Confirmation gate requires a Paperclip issue');
  const key = confirmation.documentKey ?? 'approval-manifest';
  const getDocument = () => host.issues.documents.get(issueId, key, companyId);
  const doc = await getDocument();
  const revisionId = doc?.latestRevisionId;
  if (!revisionId) return { status: 'waiting_manifest' };
  const runDigest = runValidationDigest(run);
  const generation = createHash('sha256').update(JSON.stringify([run.id, node.id, runDigest, doc.id, revisionId, confirmation])).digest('hex');
  const idempotencyKey = 'polyforge-confirmation:' + generation;
  const target = { type: 'issue_document', issueId, documentId: doc.id, key, revisionId };
  const allowed = decisionOutcomes(run, node);
  const accept = confirmation.acceptOutcome ?? 'accept';
  const reject = confirmation.rejectOutcome ?? (allowed.includes('hold') ? 'hold' : 'rework');
  if (!allowed.includes(accept) || !allowed.includes(reject)) throw new Error('Invalid confirmation gate outcomes');
  const interactions = await host.issues.listInteractions(issueId, companyId);
  const card = interactions.find(item => item.idempotencyKey === idempotencyKey)
    ?? await host.issues.requestConfirmation(issueId, {
      title: 'Approve ' + key, addresseeUserId: confirmation.ownerId, idempotencyKey,
      resolverPolicy: 'human_only', continuationPolicy: 'none',
      payload: { version: 1, target, prompt: 'Review the pinned revision before deciding.',
        rejectRequiresReason: true, supersedeOnUserComment: false },
    }, companyId);
  const receipt = { status: card.status, interactionId: card.id, issueId, runId: run.id, runDigest, nodeId: node.id };
  const outcome = card.status === 'accepted' && card.result?.outcome === 'accepted' ? accept
    : card.status === 'rejected' && card.result?.outcome === 'rejected' ? reject : null;
  if (!outcome || card.dismissedAt || card.consumedAt || card.revokedAt) return receipt;
  const bound = card.payload?.target;
  if (card.kind !== 'request_confirmation' || card.resolvedByUserId !== confirmation.ownerId || card.resolvedByAgentId
    || bound?.type !== 'issue_document' || bound.issueId !== issueId || bound.documentId !== doc.id
    || bound.key !== key || bound.revisionId !== revisionId) return { ...receipt, status: 'unauthorized' };
  const { actor } = await trustedActor(companyId, { actorType: 'user', userId: card.resolvedByUserId }, config);
  if (actor.kind !== 'human' || actor.id !== confirmation.ownerId || !actor.roles.includes('human-owner')) {
    return { ...receipt, status: 'unauthorized' };
  }
  const candidates = (node.candidateNodes ?? []).flatMap(id => run.nodeStates[id]?.artifacts ?? [])
    .filter(item => !node.candidateKinds || node.candidateKinds.includes(item.kind));
  const subjectRefs = [{ artifactId: doc.id, version: revisionId }, ...candidates.map(item => ({ artifactId: item.id, version: item.version }))];
  const rule = run.pack.decisionRules?.find(item => item.type === (node.decisionType ?? node.id) && item.mode === run.mode);
  const reason = card.result.reason || 'Owner selected ' + outcome + ' for ' + key;
  const evidence = [...new Set(['paperclip_confirmation', ...(rule?.requiredEvidence ?? [])])]
    .map(kind => ({ kind, summary: reason, issueId, interactionId: card.id, subjectRefs }));
  const current = await getDocument();
  if (current?.id !== doc.id || current.latestRevisionId !== revisionId) return { ...receipt, status: 'stale_target' };
  const args = { runId: run.id, nodeId: node.id, actor, outcome, reason, evidence,
    expectedRunDigest: runDigest, idempotencyKey: 'confirmation:' + card.id };
  if (run.pendingHuman?.kind === 'decision') {
    await engine.resolveHumanGate({ ...args, expectedDecisionId: run.pendingHuman.escalationDecisionId });
  } else {
    await engine.decideNode(args);
  }
  return { ...receipt, consumed: true };
}

