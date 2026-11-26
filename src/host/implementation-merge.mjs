import { modelSeatRules } from '../plugin/trusted-pack-adapters.mjs';
import { createHash } from 'node:crypto';

const sha = /^[a-f0-9]{40}$/;
const type = 'implementation-merge-approval';

const levels = ['low', 'medium', 'high'];
const blockingReviews = ['interrogate', 'deep-review', 'edge-cases', 'security-review'];

function approval(run, decisions, decisionId, subjects) {
  const decision = decisions.find(item => item.id === decisionId);
  const node = run?.graph.nodes.find(item => item.id === decision?.nodeId);
  const state = run?.nodeStates[node?.id];
  if (node?.decisionType !== type || decision?.type !== type || decision.status !== 'decided'
    || decision.outcome !== 'accept' || state?.status !== 'completed'
    || state.attempts.at(-1)?.decisionId !== decisionId
    || decisions.some(item => item.supersedes === decisionId)) {
    throw new Error('Current implementation merge approval is required');
  }
  const refs = decision.evidence.flatMap(item => item.subjectRefs ?? []);
  if (!subjects.every(subject => refs.some(ref => ref.artifactId === subject.artifactId && ref.version === subject.version))) {
    throw new Error('Implementation approval must bind the PR head and verification revision');
  }
  return decision;
}

function owner(decision, project) {
  const { actor } = decision;
  return actor?.kind === 'human' && actor.id === project.ownerId && actor.roles.includes('human-owner');
}

function gateEvidence(run, decision, subject) {
  const models = decision.evidence.filter(item => item.kind === 'implementation-risk'
    && item.subjectRefs?.some(ref => ref.artifactId === subject.artifactId && ref.version === subject.version));
  const model = models.length === 1 && levels.includes(models[0].riskLevel) ? models[0].riskLevel : null;
  const evidenceComplete = blockingReviews.every(review => run.nodeStates[review]?.status === 'completed'
    && run.nodeStates[review].attempts.at(-1)?.output?.reviewDisposition?.headSha === subject.version
    && run.nodeStates[review].attempts.at(-1)?.output?.reviewDisposition?.status === 'pass');
  return { model, evidenceComplete };
}

async function assessRisk(github, snapshot, repository, assessDeterministicRisk) {
  if (typeof assessDeterministicRisk !== 'function') return null;
  const { changes, baseSha, headSha } = snapshot;
  const dependencyChanges = await github.getDependencyChanges({ repository, baseSha, headSha, changes });
  if (!Array.isArray(dependencyChanges)) return null;
  const result = assessDeterministicRisk({
    changes: changes.map(({ path, status, previousPath }) => ({ path, status, previousPath })),
    dependencyChanges,
  });
  if (!levels.includes(result?.floor) || ![result.neverAutoMerge, result.rules].every(list =>
    Array.isArray(list) && list.every(value => typeof value === 'string' && value.trim()))) return null;
  return result;
}

// The Host supplies immutable verification bytes and resolves the author identity.
export async function mergeImplementation({
  engine, github, project, runId, pullNumber, decisionId, manifest, authorAgentId,
}, { assessDeterministicRisk = modelSeatRules.assessDeterministicRisk } = {}) {
  const { repository } = project;
  if (!repository || !project.id || !Number.isSafeInteger(pullNumber) || pullNumber < 1
    || !manifest?.id || !manifest.revisionId) throw new Error('Invalid implementation merge request');
  const run = await engine.getRun(runId);
  if (run?.input.projectId !== project.id) throw new Error('Implementation run does not belong to the project');
  const verification = JSON.parse(Buffer.from(manifest.bytes).toString('utf8'));
  const headSha = verification.checkoutSha;
  if (!sha.test(headSha)) throw new Error('Verification manifest must bind a PR head SHA');
  const request = { repository, pullNumber, decisionId, headSha, manifestId: manifest.id, revisionId: manifest.revisionId,
    manifestDigest: createHash('sha256').update(manifest.bytes).digest('hex') };
  const existing = run.implementationMerges?.find(item => item.repository === repository && item.pullNumber === pullNumber);
  if (existing) {
    if (Object.entries(request).some(([key, value]) => existing[key] !== value)) throw new Error('Implementation merge request changed');
    return existing;
  }
  const recovered = await github.getMergeReceipt({ ...request, runId });
  if (recovered) {
    if (![recovered.baseSha, recovered.mergeCommitSha].every(value => sha.test(value))) throw new Error('Invalid implementation receipt');
    return engine.recordImplementationMerge(runId, { ...request, baseSha: recovered.baseSha, mergeCommitSha: recovered.mergeCommitSha, ...recovered.authorization });
  }
  const subjects = [
    { artifactId: 'pr:' + repository + '#' + pullNumber, version: headSha },
    { artifactId: manifest.id, version: manifest.revisionId },
  ];
  const mode = project.automationMode ?? 'manual';
  let deterministic;
  async function currentApproval() {
    await engine.assertCurrentContractPins(runId, decisionId);
    const current = await engine.getRun(runId);
    if (['paused', 'stopped'].includes(current?.status)) throw new Error('Implementation run is on hold');
    return { current, decision: approval(current, await engine.listDecisions({ runId }), decisionId, subjects) };
  }
  const initial = await currentApproval();
  if (mode === 'manual' && !owner(initial.decision, project)) throw new Error('Configured human owner approval is required');
  const baseSha = await github.getRef({ repository, ref: 'refs/heads/main' });
  if (!sha.test(baseSha)) throw new Error('Invalid main commit SHA');
  const pr = await github.getPullSnapshot({ repository, pullNumber, baseSha });
  if (pr.headSha !== headSha || pr.baseRef !== 'main' || pr.baseSha !== baseSha) {
    throw new Error('Implementation PR head or base changed');
  }
  const root = (project.contracts_root ?? project.contractsRoot ?? 'docs/contracts').toLowerCase();
  const isContract = path => {
    const normalized = path?.toLowerCase();
    return normalized === root || normalized?.startsWith(root + '/');
  };
  if (!pr.changes.length || pr.changes.some(item => isContract(item.path) || isContract(item.previousPath))) {
    throw new Error('Implementation PR must change files outside contract paths');
  }
  const validator = await github.loadValidator({ repository, ref: baseSha });
  const judgment = validator.judgeVerificationManifest(verification);
  if (judgment.status !== 'pass' || judgment.gaps.length || verification.results.some(row => row.result !== 'pass')) {
    throw new Error('Passing verification with complete evidence is required');
  }
  try {
    deterministic = await assessRisk(github, pr, repository, assessDeterministicRisk);
  } catch (error) {
    if (!owner(initial.decision, project)) throw new Error('Trusted implementation risk is unavailable', { cause: error });
  }
  async function authorizeCurrent() {
    const { current, decision } = await currentApproval();
    const { model, evidenceComplete } = gateEvidence(current, decision, subjects[0]);
    const riskLevel = deterministic && model ? levels[Math.max(levels.indexOf(deterministic.floor), levels.indexOf(model))] : null;
    const autoMerged = !owner(decision, project);
    if (autoMerged && (decision.actor?.kind !== 'agent' || !authorAgentId || decision.actor.id === authorAgentId
      || !riskLevel || deterministic.neverAutoMerge.length || !evidenceComplete
      || !(mode === 'full-auto' || (mode === 'assisted' && riskLevel === 'low'
        && decision.actor.roles?.includes('cto-caio'))))) {
      throw new Error('Configured human owner approval is required');
    }
    return { mode, riskLevel, rules: deterministic?.rules ?? [], neverAutoMerge: deterministic?.neverAutoMerge ?? [],
      evidenceComplete, autoMerged };
  }
  const authorization = await authorizeCurrent();
  const mergeCommitSha = await github.merge({ ...request, runId, baseSha, authorization }, async () => {
    const current = await authorizeCurrent();
    if (JSON.stringify(current) !== JSON.stringify(authorization)) throw new Error('Implementation authorization changed');
  });
  if (!sha.test(mergeCommitSha)) throw new Error('Invalid implementation receipt');
  return engine.recordImplementationMerge(runId, { ...request, baseSha, mergeCommitSha, ...authorization });
}
