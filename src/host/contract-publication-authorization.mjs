import { canonical } from '../core/canonical.mjs';
import { currentCandidates } from '../core/engine.mjs';
import { publicationDigest } from './contract-publication.mjs';
import { contractPublicationError } from './contract-publication-causes.mjs';

const autoDesignType = 'g3-visual-auto-approval';

function canonicalDigest(value) {
  return publicationDigest(canonical(value));
}
const gates = {
  design: { type: 'g3-visual-approval', kind: 'human', role: 'human-owner', outcome: 'approve', approver: 'ownerId' },
  technical: { type: 'technical-contract-approval', kind: 'agent', role: 'cto', outcome: 'accept', approver: 'ctoId' },
};

// Supplemental evidence, such as notes or conflict resolutions, may omit subject references.
const references = (evidence, artifactId, version) => evidence.some(item => Array.isArray(item?.subjectRefs)
  && item.subjectRefs.some(ref => ref?.artifactId === artifactId && ref.version === version));

export function authorizedDecision(run, decisions, project, section, decisionId, manifest, mode, auditBytes) {
  const gate = gates[section];
  const decision = decisions.find(record => record.id === decisionId);
  const node = run.graph.nodes.find(node => node.id === decision?.nodeId);
  const state = run.nodeStates[node?.id];
  const autoDesign = section === 'design' && decision?.type === autoDesignType;
  if (!gate || !decision || (!autoDesign && decision.type !== gate.type) || node?.decisionType !== decision.type
    || state?.status !== 'completed' || state.attempts.at(-1)?.decisionId !== decision.id
    || decisions.some(record => record.supersedes === decision.id)
    || decision.status !== 'decided' || decision.outcome !== gate.outcome) {
    throw contractPublicationError('publication-unauthorized');
  }
  if (!currentCandidates(run, node).some(item => item.id === manifest.id && item.version === manifest.revisionId)) {
    throw contractPublicationError('publication-unauthorized');
  }
  const approverId = project[gate.approver];
  const { actor, evidence } = decision;
  if (!Array.isArray(actor?.roles) || !Array.isArray(evidence)) {
    throw contractPublicationError('publication-unauthorized');
  }
  const configuredApprover = approverId && actor.id === approverId && actor.kind === gate.kind
    && actor.roles.includes(gate.role);
  const designDirector = autoDesign && ['assisted', 'full-auto'].includes(mode)
    && ['assisted', 'autonomous', 'full-auto'].includes(run.mode)
    && actor.kind === 'agent' && actor.roles.includes('design-director')
    && designAuditPasses(run, evidence, manifest, auditBytes);
  if (!configuredApprover && !designDirector) throw contractPublicationError('publication-unauthorized');
  if (!references(evidence, manifest.id, manifest.revisionId)) {
    throw contractPublicationError('publication-unauthorized');
  }
}

function designAuditPasses(run, evidence, manifest, auditBytes) {
  if (!auditBytes) return false;
  const state = run.nodeStates['design-audit'];
  const attempt = state?.status === 'completed' ? state.attempts.at(-1) : null;
  const artifact = attempt?.artifacts?.findLast(item => item.kind === 'visual_audit');
  const payload = attempt?.output?.creativeArtifacts?.visual_audit;
  if (!artifact || !payload || !references(evidence, artifact.id, artifact.version)) return false;
  try {
    const visual = JSON.parse(Buffer.from(manifest.bytes).toString('utf8'));
    const audit = JSON.parse(Buffer.from(auditBytes).toString('utf8'));
    return canonicalDigest(audit) === canonicalDigest(payload)
      && visual.systemScope === 'in-system' && visual.behaviorChanged === false
      && audit.behaviorChanged === false && audit.manifestDigest === canonicalDigest(visual)
      && Array.isArray(audit.findings) && audit.findings.every(finding => ['P2', 'P3', 'nit'].includes(finding?.severity));
  } catch {
    return false;
  }
}
