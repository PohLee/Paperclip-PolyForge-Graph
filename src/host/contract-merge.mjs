import { resolveAutomationMode } from './automation-mode.mjs';
import { createHash } from 'node:crypto';
import { currentCandidates } from '../core/engine.mjs';
import { modelSeatRules } from '../plugin/trusted-pack-adapters.mjs';

const sha = /^[a-f0-9]{40}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const autoDesignType = 'g3-visual-auto-approval';

function canonicalDigest(value) {
  return digest(JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
      : item));
}
const gates = {
  product: { type: 'requirements-acceptance', kind: 'human', role: 'human-owner', outcome: 'accept', approver: 'ownerId' },
  design: { type: 'g3-visual-approval', kind: 'human', role: 'human-owner', outcome: 'approve', approver: 'ownerId' },
  technical: { type: 'technical-contract-approval', kind: 'agent', role: 'cto', outcome: 'accept', approver: 'ctoId' },
};

function validContractVersion(contractId, supersedes) {
  return typeof contractId === 'string' && Boolean(contractId.trim())
    && (supersedes === null || (typeof supersedes === 'string' && sha.test(supersedes)));
}

function canonicalPath(path) {
  return typeof path === 'string' && !/[\\:\x00-\x1f]/.test(path)
    && path.split('/').every(segment => segment && !/[. ]$/.test(segment));
}

function authorizedDecision(run, decisions, project, section, decisionId, manifest, mode, auditBytes) {
  const gate = gates[section];
  const decision = decisions.find(record => record.id === decisionId);
  const node = run.graph.nodes.find(node => node.id === decision?.nodeId);
  const state = run.nodeStates[node?.id];
  const autoDesign = section === 'design' && decision?.type === autoDesignType;
  if (!gate || !decision || (!autoDesign && decision.type !== gate.type) || node?.decisionType !== decision.type
    || state?.status !== 'completed' || state.attempts.at(-1)?.decisionId !== decision.id
    || decisions.some(record => record.supersedes === decision.id)
    || decision.status !== 'decided' || decision.outcome !== gate.outcome) {
    throw new Error('Current contract gate approval is required');
  }
  if (!currentCandidates(run, node).some(item => item.id === manifest.id && item.version === manifest.revisionId)) {
    throw new Error('Contract manifest must be a current gate candidate');
  }
  const approverId = project[gate.approver];
  const actor = decision.actor;
  const configuredApprover = approverId && actor?.id === approverId && actor.kind === gate.kind
    && actor.roles.includes(gate.role);
  const designDirector = autoDesign && ['assisted', 'full-auto'].includes(mode)
    && ['assisted', 'autonomous', 'full-auto'].includes(run.mode)
    && actor?.kind === 'agent' && actor.roles.includes('design-director')
    && designAuditPasses(run, decision, manifest, auditBytes);
  if (!configuredApprover && !designDirector) throw new Error('Contract approver is unauthorized');
  if (!decision.evidence.some(item => item.subjectRefs?.some(ref =>
    ref.artifactId === manifest.id && ref.version === manifest.revisionId))) {
    throw new Error('Contract approval does not bind the manifest revision');
  }
}

function designAuditPasses(run, decision, manifest, auditBytes) {
  if (!auditBytes) return false;
  const state = run.nodeStates['design-audit'];
  const attempt = state?.status === 'completed' ? state.attempts.at(-1) : null;
  const artifact = attempt?.artifacts?.findLast(item => item.kind === 'visual_audit');
  const payload = attempt?.output?.creativeArtifacts?.visual_audit;
  if (!artifact || !payload || !decision.evidence.some(item => item.subjectRefs?.some(ref =>
    ref.artifactId === artifact.id && ref.version === artifact.version))) return false;
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

function fenced(path, root, section) {
  if (!canonicalPath(path) || !path.startsWith(root + '/')) return false;
  const relative = path.slice(root.length + 1);
  const [year, month, folder, area, ...file] = relative.split('/');
  try {
    modelSeatRules.validateContractPath(relative);
    if (relative === 'INDEX.json') return true;
    modelSeatRules.parseContractFolder(`${year}/${month}/${folder}`);
  } catch {
    return false;
  }
  if (area === 'contract.lock.json' && !file.length) return true;
  // G2 approves the interaction design together with the PRD, so product publication may write it.
  // G3 must not change the interaction design: a behavior change returns to G2.
  const interaction = area === 'design' && file.join('/') === 'interaction.md';
  const allowed = section === 'product' ? area === 'product' || interaction : area === section && !interaction;
  return allowed && file.length > 0 && !file.some(segment =>
    modelSeatRules.contractReservedSegments.includes(segment.toLowerCase()));
}

// Called only by trusted Host code. Project identities and manifest bytes are
// resolved by the Host from configuration and immutable document revisions.
export async function mergeContract({ engine, github, project, runId, pullNumber, section, decisionId, manifest, auditBytes, authorize }) {
  const root = project.contracts_root ?? project.contractsRoot ?? 'knowledge/contracts';
  if (!canonicalPath(root) || !Object.hasOwn(gates, section) || !Number.isSafeInteger(pullNumber)
    || pullNumber < 1 || !project.repository || !runId || !manifest?.id || !manifest.revisionId) {
    throw new Error('Invalid contract merge request');
  }
  const run = await engine.getRun(runId);
  if (!project.id || run?.input.projectId !== project.id) throw new Error('Contract run does not belong to the project');
  const request = { repository: project.repository, pullNumber, section, decisionId,
    manifestId: manifest.id, revisionId: manifest.revisionId, manifestDigest: digest(manifest.bytes), ...(auditBytes ? { auditDigest: digest(auditBytes) } : {}) };
  const existing = run.contractMerges?.find(item => item.repository === request.repository && item.pullNumber === pullNumber);
  if (existing) {
    if (Object.entries(request).some(([key, value]) => existing[key] !== value)) throw new Error('Contract merge request changed');
    return existing;
  }
  const { repository } = request;
  const recovered = await github.getMergeReceipt({ ...request, runId });
  if (recovered) {
    const { baseSha, headSha, mergeCommitSha, contractId, supersedes } = recovered;
    if (![baseSha, headSha, mergeCommitSha].every(value => sha.test(value)) || !validContractVersion(contractId, supersedes)) throw new Error('Invalid contract merge receipt');
    return engine.recordContractMerge(runId, { ...request, baseSha, headSha, mergeCommitSha, contractId, supersedes, ...(recovered.mode && { mode: recovered.mode }) });
  }
  // Checked after receipt recovery so an older trusted Pack or a legacy root can still return recorded merges.
  if (typeof modelSeatRules.parseContractFolder !== 'function' || typeof modelSeatRules.validateContractPath !== 'function'
    || !Array.isArray(modelSeatRules.contractReservedSegments)) {
    throw new Error('Trusted ADLC Pack lacks contract layout v2 helpers');
  }
  if (!/^[\x20-\x7e]+$/.test(root)) throw new Error('Invalid contracts root');
  const mode = await resolveAutomationMode(engine, project, runId, decisionId);
  async function authorizeCurrent() {
    const current = await engine.getRun(runId);
    if (current?.contract_pins !== undefined) {
      if (['paused', 'stopped'].includes(current.status)) throw new Error('Contract run is on hold');
      await engine.assertCurrentContractPins(runId, decisionId);
    }
    authorizedDecision(current, await engine.listDecisions({ runId }),
      project, section, decisionId, manifest, mode, auditBytes);
  }
  await authorizeCurrent();

  const baseSha = await github.getRef({ repository, ref: 'refs/heads/main' });
  if (!sha.test(baseSha)) throw new Error('Invalid main commit SHA');
  const pr = await github.getPullSnapshot({ repository, pullNumber, baseSha });
  if (!sha.test(pr.headSha) || pr.baseRef !== 'main' || pr.baseSha !== baseSha) {
    throw new Error('Contract PR must be current against main');
  }
  const paths = new Set();
  for (const { path, previousPath, mode, status } of pr.changes) {
    if (!fenced(path, root, section) || previousPath || !['added', 'modified'].includes(status)
      || mode !== '100644' || paths.has(path.toLowerCase())) throw new Error('Contract PR path is forbidden: ' + path);
    paths.add(path.toLowerCase());
  }
  if (!paths.size) throw new Error('Contract PR has no changes');

  const validator = await github.loadValidator({ repository, ref: baseSha });
  const plan = await validator.recompute({ repository, baseSha, headSha: pr.headSha,
    contractsRoot: root, section, manifest: { ...manifest, digest: request.manifestDigest } });
  if (!validContractVersion(plan.contractId, plan.supersedes)) throw new Error('Invalid validator contractId or supersedes');
  if (plan.supersedes === undefined || plan.supersedes !== plan.currentRevision) {
    throw new Error('Contract supersedes is stale');
  }
  const { deliverables } = JSON.parse(Buffer.from(manifest.bytes).toString('utf8'));
  if (!Array.isArray(deliverables) || !deliverables.length) throw new Error('Contract manifest has no deliverables');
  for (const { key, digest: approvedDigest } of deliverables) {
    const bytes = plan.deliverables.get(key);
    if (bytes === undefined || digest(bytes) !== approvedDigest) throw new Error('Contract deliverable digest mismatch: ' + key);
  }
  if (plan.changes.size !== paths.size) throw new Error('Contract PR differs from the approved publication');
  for (const { path, bytes } of pr.changes) {
    const expected = plan.changes.get(path);
    if (expected === undefined || digest(bytes) !== digest(expected)) {
      throw new Error('Contract file digest mismatch: ' + path);
    }
  }
  await authorizeCurrent();
  const publication = { ...request, mode, baseSha, headSha: pr.headSha, contractId: plan.contractId, supersedes: plan.supersedes };
  const mergeCommitSha = await github.merge({ ...publication, runId }, async phase => {
    await authorizeCurrent();
    return authorize?.(phase);
  });
  if (!sha.test(mergeCommitSha)) throw new Error('Invalid contract merge receipt');
  return engine.recordContractMerge(runId, { ...publication, mergeCommitSha });
}

export { createGitHubAppAdapter } from './github-app.mjs';
export { mergeImplementation } from './implementation-merge.mjs';
