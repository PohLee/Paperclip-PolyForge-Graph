import { createHash } from 'node:crypto';
import { currentCandidates } from '../core/engine.mjs';

const sha = /^[a-f0-9]{40}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gates = {
  product: { type: 'requirements-acceptance', kind: 'human', role: 'human-owner', outcome: 'accept', approver: 'ownerId' },
  // G3 runs in manual mode: the owner approves every visual contract. Assisted design-audit approval is P3.
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

function authorizedDecision(run, decisions, project, section, decisionId, manifest) {
  const gate = gates[section];
  const decision = decisions.find(record => record.id === decisionId);
  const node = run.graph.nodes.find(node => node.id === decision?.nodeId);
  const state = run.nodeStates[node?.id];
  if (!gate || !decision || decision.type !== gate.type || node?.decisionType !== gate.type
    || state?.status !== 'completed' || state.attempts.at(-1)?.decisionId !== decision.id
    || decisions.some(record => record.supersedes === decision.id)
    || decision.status !== 'decided' || decision.outcome !== gate.outcome) {
    throw new Error('Current contract gate approval is required');
  }
  if (!currentCandidates(run, node).some(item => item.id === manifest.id && item.version === manifest.revisionId)) {
    throw new Error('Contract manifest must be a current gate candidate');
  }
  const approverId = project[gate.approver];
  if (!approverId || decision.actor?.id !== approverId || decision.actor.kind !== gate.kind
    || !decision.actor.roles.includes(gate.role)) throw new Error('Contract approver is unauthorized');
  if (!decision.evidence.some(item => item.subjectRefs?.some(ref =>
    ref.artifactId === manifest.id && ref.version === manifest.revisionId))) {
    throw new Error('Contract approval does not bind the manifest revision');
  }
}

function fenced(path, root, section) {
  if (!canonicalPath(path) || !path.startsWith(root + '/')) return false;
  const relative = path.slice(root.length + 1);
  if (relative === 'INDEX.json') return true;
  const [year, month, folder, area, ...file] = relative.split('/');
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !folder?.startsWith(year + '-' + month + '-')) return false;
  if (area === 'contract.lock.json' && !file.length) return true;
  // G2 approves the interaction design together with the PRD, so product publication may write it.
  // G3 must not change the interaction design: a behavior change returns to G2.
  const interaction = area === 'design' && file.join('/') === 'interaction.md';
  const allowed = section === 'product' ? area === 'product' || interaction : area === section && !interaction;
  return allowed && file.length > 0 && !file.some(segment =>
    /^(?:index\.json|contract\.lock\.json|codeowners|\.github|\.gitlab-ci\.yml|azure-pipelines\.yml|jenkinsfile|\.circleci|\.buildkite)$/i.test(segment));
}

// Called only by trusted Host code. Project identities and manifest bytes are
// resolved by the Host from configuration and immutable document revisions.
export async function mergeContract({ engine, github, project, runId, pullNumber, section, decisionId, manifest }) {
  const root = project.contracts_root ?? project.contractsRoot ?? 'docs/contracts';
  if (!canonicalPath(root) || !Object.hasOwn(gates, section) || !Number.isSafeInteger(pullNumber)
    || pullNumber < 1 || !project.repository || !runId || !manifest?.id || !manifest.revisionId) {
    throw new Error('Invalid contract merge request');
  }
  const run = await engine.getRun(runId);
  if (!project.id || run?.input.projectId !== project.id) throw new Error('Contract run does not belong to the project');
  const request = { repository: project.repository, pullNumber, section, decisionId,
    manifestId: manifest.id, revisionId: manifest.revisionId, manifestDigest: digest(manifest.bytes) };
  const existing = run.contractMerges?.find(item => item.repository === request.repository && item.pullNumber === pullNumber);
  if (existing) {
    if (Object.entries(request).some(([key, value]) => existing[key] !== value)) throw new Error('Contract merge request changed');
    return existing;
  }
  authorizedDecision(run, await engine.listDecisions({ runId }), project, section, decisionId, manifest);

  const { repository } = request;
  const recovered = await github.getMergeReceipt({ ...request, runId });
  if (recovered) {
    const { baseSha, headSha, mergeCommitSha, contractId, supersedes } = recovered;
    if (![baseSha, headSha, mergeCommitSha].every(value => sha.test(value)) || !validContractVersion(contractId, supersedes)) throw new Error('Invalid contract merge receipt');
    return engine.recordContractMerge(runId, { ...request, baseSha, headSha, mergeCommitSha, contractId, supersedes });
  }
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
  authorizedDecision(await engine.getRun(runId), await engine.listDecisions({ runId }), project, section, decisionId, manifest);
  const publication = { ...request, baseSha, headSha: pr.headSha, contractId: plan.contractId, supersedes: plan.supersedes };
  const mergeCommitSha = await github.merge({ ...publication, runId });
  if (!sha.test(mergeCommitSha)) throw new Error('Invalid contract merge receipt');
  return engine.recordContractMerge(runId, { ...publication, mergeCommitSha });
}

export { createGitHubAppAdapter } from './github-app.mjs';
export { mergeImplementation } from './implementation-merge.mjs';
