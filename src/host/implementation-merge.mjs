import { contractPublicationError } from './contract-publication-causes.mjs';
import { resolveAutomationMode } from './automation-mode.mjs';
import { modelSeatRules } from '../plugin/trusted-pack-adapters.mjs';
import { createHash } from 'node:crypto';
import { currentCandidates } from '../core/engine.mjs';

const sha = /^[a-f0-9]{40}$/;
const type = 'implementation-merge-approval';

export function assertFreshImplementationEvidence(run, decision, manifest) {
  if (!run.contractPinsUpdatedAt) return;
  const fresh = record => Date.parse(record?.at) > Date.parse(run.contractPinsUpdatedAt);
  const states = Object.values(run.nodeStates);
  const verification = states.some(state => state.status === 'completed' && fresh(state.attempts.at(-1))
    && state.attempts.at(-1).artifacts?.some(({ id, version, kind }) =>
      id === manifest.id && version === manifest.revisionId && kind === 'verification_manifest'));
  const review = run.nodeStates['review-head'];
  const reviews = (review?.status === 'completed' && fresh(review.attempts.at(-1))) ||
    blockingReviews.every(name => {
      const state = run.nodeStates[name];
      return state?.status === 'completed' && fresh(state.attempts.at(-1));
    });
  if (!fresh(decision) || !verification || !reviews) throw new Error('Implementation evidence predates the contract pin update');
}

export async function assertImplementationChecks(github, project, repository, headSha) {
  const checks = await github.getCheckStatus({ repository, sha: headSha });
  const passed = check => check.status === 'completed' && check.conclusion === 'success';
  const required = project.requiredChecks;
  const selected = required?.length ? checks.filter(check => required.includes(check.name)) : checks;
  if (!selected.length || !selected.every(passed) || required?.some(name => !selected.some(check => check.name === name))) {
    throw new Error('Required implementation checks are missing or unsuccessful');
  }
}

export async function assertVerificationScope(validator, run, project, contractsRoot, verification, audit) {
  const productPins = new Set(run.contract_pins.filter(pin => pin.section === 'product').map(pin => pin.contractId));
  for (const contractId of new Set(run.contract_pins.map(pin => pin.contractId))) {
    const matches = event => event.kind === 'contract.merged' && event.projectId === project.id
      && event.contractId === contractId && event.repository?.toLowerCase() === project.repository.toLowerCase();
    const receipt = audit.findLast(matches);
    const productReceipt = audit.findLast(event => matches(event) && event.section === 'product');
    if (!receipt) throw contractPublicationError('contract-drift');
    const criteria = await validator.readVerificationCriteria({ contractId, contractsRoot, receipt, productReceipt });
    if (!productPins.has(contractId)) continue;
    if (!Array.isArray(criteria) || !criteria.every(row =>
      typeof row?.id === 'string' && row.id && verification.expectedScenarios?.includes(row.id))) {
      throw new Error('Verification must cover every pinned product scenario');
    }
  }
  const dimensions = new Map(verification.dimensions?.map(({ name, values }) => [name, values]));
  for (const dimension of project.verificationDimensions ?? []) {
    const name = typeof dimension === 'string' ? dimension : dimension.name;
    if (!dimensions.has(name) || dimension.values?.some(value => !dimensions.get(name)?.includes(value))) {
      throw new Error('Verification is missing a configured dimension');
    }
  }
}

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
  const candidates = currentCandidates(run, node);
  if (!subjects.every(({ artifactId, version }) => candidates.some(item => item.id === artifactId && item.version === version))) {
    throw new Error('Implementation approval requires the current PR head and verification candidates');
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
  const perNode = blockingReviews.every(review => run.nodeStates[review]?.status === 'completed'
    && run.nodeStates[review].attempts.at(-1)?.output?.reviewDisposition?.headSha === subject.version
    && run.nodeStates[review].attempts.at(-1)?.output?.reviewDisposition?.status === 'pass');
  return { model, evidenceComplete: perNode || aggregatedReviewsPass(run, subject.version) };
}

// verification@0.1.9 records all blocking reviews in one `review-head` attempt as `pr_reviews`.
// A review passes when it completed and every finding is a nit/P3 or was fixed.
function aggregatedReviewsPass(run, headSha) {
  const state = run.nodeStates['review-head'];
  const report = state?.status === 'completed' ? state.attempts.at(-1)?.output?.adlcProductMethods?.pr_reviews : null;
  if (!report || report.headSha !== headSha) return false;
  return blockingReviews.every(name => {
    const review = report.reviews?.[name];
    return review?.status === 'completed' && Array.isArray(review.findings)
      && review.findings.every(finding => ['nit', 'P3'].includes(finding?.severity) || finding?.disposition === 'fixed');
  });
}

async function assessRisk(github, snapshot, repository, assessDeterministicRisk, project = {}) {
  if (typeof assessDeterministicRisk !== 'function') return null;
  const { changes, baseSha, headSha } = snapshot;
  const dependencyChanges = await github.getDependencyChanges({ repository, baseSha, headSha, changes });
  if (!Array.isArray(dependencyChanges)) return null;
  const result = assessDeterministicRisk({
    changes: changes.map(({ path, status, previousPath }) => ({ path, status, previousPath })),
    dependencyChanges,
    ciPaths: Array.isArray(project.ciPaths) ? project.ciPaths : [],
    riskRules: Array.isArray(project.riskRules) ? project.riskRules : [],
    ...(project.neverAutoMerge && typeof project.neverAutoMerge === 'object' && !Array.isArray(project.neverAutoMerge)
      ? { neverAutoMerge: project.neverAutoMerge } : {}),
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
  const ceiling = await resolveAutomationMode(engine, project, runId, decisionId);
  const modes = ['manual', 'assisted', 'full-auto'];
  const pinnedMode = run.mode === 'autonomous' ? 'full-auto' : run.mode ?? 'manual';
  const mode = modes[Math.min(modes.indexOf(ceiling), Math.max(0, modes.indexOf(pinnedMode)))];
  let deterministic;
  async function currentApproval() {
    try { await engine.assertCurrentContractPins(runId, decisionId); }
    catch (error) {
      if (error.code === 'contract-receipt-missing') throw contractPublicationError('contract-drift');
      throw error;
    }
    const current = await engine.getRun(runId);
    if (['paused', 'stopped'].includes(current?.status)) throw new Error('Implementation run is on hold');
    if (!current?.contract_pins?.length) throw new Error('Implementation requires non-empty contract pins');
    if (!current.contract_pins.some(pin => pin.section === 'product')) throw new Error('Implementation requires a product contract pin');
    const decision = approval(current, await engine.listDecisions({ runId }), decisionId, subjects);
    assertFreshImplementationEvidence(current, decision, manifest);
    return { current, decision };
  }
  const initial = await currentApproval();
  if (mode === 'manual' && !owner(initial.decision, project)) throw new Error('Configured human owner approval is required');
  const baseSha = await github.getRef({ repository, ref: 'refs/heads/main' });
  if (!sha.test(baseSha)) throw new Error('Invalid main commit SHA');
  const pr = await github.getPullSnapshot({ repository, pullNumber, baseSha });
  if (pr.headSha !== headSha || pr.baseRef !== 'main' || pr.baseSha !== baseSha) {
    throw new Error('Implementation PR head or base changed');
  }
  const contractsRoot = project.contracts_root ?? project.contractsRoot ?? 'knowledge/contracts';
  if (typeof modelSeatRules.foldContractPath !== 'function' || typeof modelSeatRules.isContractsRoot !== 'function') {
    throw new Error('Trusted ADLC Pack lacks contract layout v2 helpers');
  }
  if (!modelSeatRules.isContractsRoot(contractsRoot)) throw new Error('Invalid contracts root');
  // The Pack folds compatibility forms and full case (ſ/s, ẞ/ss, ς/σ), so every case-insensitive spelling matches.
  const fold = modelSeatRules.foldContractPath;
  const root = fold(contractsRoot);
  const isContract = path => {
    const normalized = typeof path === 'string' ? fold(path) : undefined;
    return normalized === root || normalized?.startsWith(root + '/');
  };
  if (!pr.changes.length || pr.changes.some(item => isContract(item.path) || isContract(item.previousPath))) {
    throw new Error('Implementation PR must change files outside contract paths');
  }
  const validator = await github.loadValidator({ repository, ref: baseSha });
  await assertVerificationScope(validator, run, project, contractsRoot, verification, await engine.getAudit());
  const judgment = validator.judgeVerificationManifest(verification);
  if (judgment.status !== 'pass' || judgment.gaps.length || verification.results.some(row => row.result !== 'pass')) {
    throw new Error('Passing verification with complete evidence is required');
  }
  try {
    deterministic = await assessRisk(github, pr, repository, assessDeterministicRisk, project);
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
    await assertVerificationScope(validator, (await currentApproval()).current, project, contractsRoot, verification, await engine.getAudit());
    await assertImplementationChecks(github, project, repository, headSha);
  });
  if (!sha.test(mergeCommitSha)) throw new Error('Invalid implementation receipt');
  return engine.recordImplementationMerge(runId, { ...request, baseSha, mergeCommitSha, ...authorization });
}
