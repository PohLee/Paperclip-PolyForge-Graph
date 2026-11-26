import { createHash } from 'node:crypto';

const sha = /^[a-f0-9]{40}$/;
const type = 'implementation-merge-approval';
const blockingReviews = ['interrogate', 'deep-review', 'edge-cases', 'security-review'];

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

export async function assertVerificationScope(validator, run, project, contractsRoot, verification) {
  for (const { contractId } of run.contract_pins.filter(pin => pin.section === 'product')) {
    const criteria = await validator.readVerificationCriteria({ contractId, contractsRoot });
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

function authorize(run, decisions, project, decisionId, subjects, risk) {
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
  const { actor } = decision;
  if (actor?.kind === 'human' && actor.id === project.ownerId && actor.roles.includes('human-owner')) return decision;
  const mode = project.automationMode ?? 'manual';
  if (actor?.kind !== 'agent' || !risk.authorAgentId || actor.id === risk.authorAgentId
    || (project.neverAutoMerge !== false && risk.neverAutoMerge.length > 0)
    || !((mode === 'assisted' && risk.riskLevel === 'low') || (mode === 'full-auto' && risk.evidenceComplete === true))) {
    throw new Error('Configured human owner approval is required');
  }
  return decision;
}

// Trusted Host supplies immutable manifest bytes and deterministic Pack risk data for this head.
export async function mergeImplementation({
  engine, github, project, runId, pullNumber, decisionId, manifest, riskLevel, neverAutoMerge = [], evidenceComplete, authorAgentId,
}) {
  const { repository } = project;
  if (!repository || !project.id || !Number.isSafeInteger(pullNumber) || pullNumber < 1
    || !manifest?.id || !manifest.revisionId) throw new Error('Invalid implementation merge request');
  const run = await engine.getRun(runId);
  if (run?.input.projectId !== project.id) throw new Error('Implementation run does not belong to the project');
  const verification = JSON.parse(Buffer.from(manifest.bytes).toString('utf8'));
  const headSha = verification.checkoutSha;
  if (!sha.test(headSha)) throw new Error('Verification manifest must bind a PR head SHA');
  const risk = { riskLevel, neverAutoMerge, evidenceComplete, authorAgentId };
  if (!Array.isArray(neverAutoMerge) || neverAutoMerge.some(category => typeof category !== 'string' || !category.trim())) {
    throw new Error('Invalid implementation risk categories');
  }
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
    return engine.recordImplementationMerge(runId, { ...request, baseSha: recovered.baseSha, mergeCommitSha: recovered.mergeCommitSha });
  }
  const subjects = [
    { artifactId: 'pr:' + repository + '#' + pullNumber, version: headSha },
    { artifactId: manifest.id, version: manifest.revisionId },
  ];
  async function authorizeCurrent() {
    await engine.assertCurrentContractPins(runId, decisionId);
    const current = await engine.getRun(runId);
    if (['paused', 'stopped'].includes(current?.status)) throw new Error('Implementation run is on hold');
    if (!current?.contract_pins?.length) throw new Error('Implementation requires non-empty contract pins');
    const decision = authorize(current, await engine.listDecisions({ runId }), project, decisionId, subjects, risk);
    assertFreshImplementationEvidence(current, decision, manifest);
    return current;
  }
  await authorizeCurrent();
  const baseSha = await github.getRef({ repository, ref: 'refs/heads/main' });
  if (!sha.test(baseSha)) throw new Error('Invalid main commit SHA');
  const pr = await github.getPullSnapshot({ repository, pullNumber, baseSha });
  if (pr.headSha !== headSha || pr.baseRef !== 'main' || pr.baseSha !== baseSha) {
    throw new Error('Implementation PR head or base changed');
  }
  const contractsRoot = project.contracts_root ?? project.contractsRoot ?? 'docs/contracts';
  const root = (project.contracts_root ?? project.contractsRoot ?? 'docs/contracts').toLowerCase();
  const isContract = path => {
    const normalized = path?.toLowerCase();
    return normalized === root || normalized?.startsWith(root + '/');
  };
  if (!pr.changes.length || pr.changes.some(item => isContract(item.path) || isContract(item.previousPath))) {
    throw new Error('Implementation PR must change files outside contract paths');
  }
  const validator = await github.loadValidator({ repository, ref: baseSha });
  await assertVerificationScope(validator, run, project, contractsRoot, verification);
  const judgment = validator.judgeVerificationManifest(verification);
  if (judgment.status !== 'pass' || judgment.gaps.length || verification.results.some(row => row.result !== 'pass')) {
    throw new Error('Passing verification with complete evidence is required');
  }
  await authorizeCurrent();
  const mergeCommitSha = await github.merge({ ...request, runId, baseSha }, async () => {
    const current = await authorizeCurrent();
    await assertVerificationScope(validator, current, project, contractsRoot, verification);
    await assertImplementationChecks(github, project, repository, headSha);
  });
  if (!sha.test(mergeCommitSha)) throw new Error('Invalid implementation receipt');
  return engine.recordImplementationMerge(runId, { ...request, baseSha, mergeCommitSha });
}
