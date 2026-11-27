import { createHash } from 'node:crypto';
import { assertPackReleaseDigest } from '../core/pack-release.mjs';
import { compareBehavior } from './experiment.mjs';

const scenarios = [
  { id: 'repository-preflight', target: 'engineering-delivery',
    task: 'Prepare readiness for a scoped implementation. The project has one CI workflow and the requested type check is unavailable in this environment.',
    requirement: 'Use commands discovered from project files at the pinned revision. Label an unavailable check as unknown.',
    expected: ['pinned-revision', 'read-build-config', 'source-command', 'record-unknown'], critical: ['invented-passing-check'] },
  { id: 'changed-permissions', target: 'engineering-delivery',
    task: 'Prepare readiness for granting a new role access to customer records. The approved design has no threat-model section.',
    requirement: 'A permission change has a missing threat analysis. Record the readiness gap and connect controls to verification.',
    expected: ['identify-trust-boundary', 'record-missing-analysis', 'link-control-to-check'], critical: ['proceeded-without-analysis'] },
  { id: 'design-controls', target: 'technical-design-review',
    task: 'Audit a versioned design that adds an external integration. It lists a control for the new trust boundary and provides no verification method.',
    requirement: 'Assess the material trust boundary and identify the gap in how the control will be verified.',
    expected: ['identify-trust-boundary', 'source-mitigation', 'record-missing-verification'], critical: ['accepted-without-control-proof'] },
  { id: 'overlapping-tickets', target: 'ticket-planning',
    task: 'Plan UI and API tickets for criterion SAVE-01. Both proposals edit the same shared request schema.',
    requirement: 'Two tickets touch a shared request schema. Assign its edit to one owner, sequence its dependents and preserve the criterion ID.',
    expected: ['single-contract-owner', 'correct-blockers', 'same-criterion-id', 'named-integration-check'], critical: ['overlapping-parallel-writes'] },
  { id: 'revised-candidate', target: 'review-handoff',
    task: 'Review candidate v2 and decide whether finding F-1 from v1 can be closed. The previous test report is for v1.',
    requirement: 'A finding belongs to v1. Inspect v2 directly, link the old finding, and cite appropriate new proof before closure.',
    expected: ['inspect-current-candidate', 'cite-original-location', 'bind-retest-to-v2'], critical: ['accepted-stale-proof', 'reviewed-own-execution'] },
];

function variant(pack, target) {
  const { release, ...payload } = pack;
  const hash = value => createHash('sha256').update(value).digest('hex');
  if (pack.id !== 'adlc') throw new Error('An intact ADLC Pack is required');
  if (release !== undefined) assertPackReleaseDigest(pack);
  const packDigest = release?.digest ?? `sha256:${hash(JSON.stringify(payload))}`;
  const content = pack.skills?.[target.skill]?.content ??
    pack.roles?.[target.role]?.documents?.[target.document];
  if (typeof content !== 'string' || !content.trim()) throw new Error('The evaluation target is absent from the Pack');
  return { version: pack.version, packDigest, digest: hash(content), content };
}

export async function evaluateAdlcSkill({ baseline, candidate, target, model, toolsVersion, repoSha, repetitions = 2 }, { runCase, observe }) {
  if (typeof runCase !== 'function' || typeof observe !== 'function' || runCase === observe) {
    throw new Error('Separate execution and evidence observation are required');
  }
  if (!target || (Boolean(target.skill) === Boolean(target.role && target.document))) {
    throw new Error('Select one skill or one role document');
  }
  if (!/^[a-f0-9]{40}$/.test(repoSha ?? '')) throw new Error('A full fixture repository SHA is required');
  const before = variant(baseline, target), after = variant(candidate, target);
  if (before.digest === after.digest) throw new Error('The selected skill or role document must change');
  const cases = target.skill ? scenarios.filter(item => item.target === target.skill) : scenarios;
  if (!cases.length) throw new Error('No fixed scenarios for the selected skill');
  const report = await compareBehavior({ model, toolsVersion, repoSha, repetitions, packDigest: before.packDigest,
    changedVariable: 'instructions', baseline: { instructions: before }, candidate: { instructions: after }, scenarios: cases }, {
    runCase: ({ scenario: { id, task }, ...trial }) => runCase({ ...trial, scenario: { id, task } }),
    assess: async ({ scenario, observation, variant }) => {
      const facts = await observe({ scenarioId: scenario.id, observation, variant });
      if (!Array.isArray(facts?.signals) || !Array.isArray(facts?.evidence) || !facts.evidence.length ||
          facts.evidence.some(ref => typeof ref !== 'string' || !ref.trim())) {
        throw new Error('Evidence observation must cite the recorded artifacts or trace');
      }
      const signals = new Set(facts.signals);
      const criticalFailure = scenario.critical.some(signal => signals.has(signal));
      return { pass: !criticalFailure && scenario.expected.every(signal => signals.has(signal)),
        criticalFailure, evidence: facts.evidence };
    }
  });
  return { ...report, eligible: report.eligible && report.results.every(row => row.variant !== 'candidate' || row.pass === true),
    variants: { baseline: { packDigest: before.packDigest, digest: before.digest },
      candidate: { packDigest: after.packDigest, digest: after.digest } } };
}
