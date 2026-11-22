import test from 'node:test';
import assert from 'node:assert/strict';
import { runEvidenceReports } from '../../src/plugin/ui-run-evidence.mjs';

const internal = { kind: 'internal_evidence', id: 'internal-research-report', version: 'v2' };
const external = { kind: 'external_evidence', id: 'external-research-report', version: 'v4' };
const userResearch = { kind: 'user_research_record', id: 'user-research-record', version: 'v4' };
const brief = { kind: 'discovery_brief', id: 'discovery-report', version: 'v1' };

function attempt(artifacts, bodies, outcome = 'accept') {
  return {
    artifacts, output: Object.fromEntries(artifacts.map((artifact, index) =>
      [artifact.kind, { id: artifact.id, version: artifact.version, finding: bodies[index] }])),
    supervisorReview: { outcome, decisionId: `review-${artifacts[0].version}` },
  };
}

function runWith(researchRefs) {
  const report = attempt([brief], ['Synthesis finding']);
  report.output.discovery_brief.researchRefs = researchRefs;
  return {
    graph: {
      id: 'product-discovery', nodes: [{ id: 'internal-research' }, { id: 'external-research' },
        { id: 'synthesize-discovery', review: { requiredSourceRefs: { reportKind: brief.kind, sources: [
          { nodeId: 'internal-research', kind: internal.kind },
          { nodeId: 'external-research', kind: external.kind },
        ] } } }],
    },
    nodeStates: {
      'internal-research': { attempts: [
        attempt([{ ...internal, version: 'v1' }], ['Reworked internal finding'], 'rework'),
        attempt([internal], ['Original accepted internal finding']),
        attempt([{ ...internal, version: 'v3' }], ['Later accepted internal finding']),
      ] },
      'external-research': { attempts: [
        attempt([external, userResearch], ['Original accepted external finding', 'Original participant record']),
      ] },
      'synthesize-discovery': { attempts: [report] },
    },
  };
}

test('the discovery brief opens exact accepted original bodies and their supervisor attempt', () => {
  const [report] = runEvidenceReports(runWith([internal, external]));
  assert.equal(report.body.finding, 'Synthesis finding');
  assert.deepEqual(report.citations.map(({ source }) =>
    [source.node.id, source.attemptNumber, source.review.decisionId,
      source.artifacts.map(({ body }) => body.finding)]), [
    ['internal-research', 2, 'review-v2', ['Original accepted internal finding']],
    ['external-research', 1, 'review-v4', ['Original accepted external finding', 'Original participant record']],
  ]);
});

test('a reworked version, wrong source node or missing version cannot resolve as accepted research', () => {
  const run = runWith([{ ...internal, version: 'v1' }, { ...external, version: 'v8' },
    { ...internal, id: external.id, version: external.version }]);
  const [report] = runEvidenceReports(run);
  assert.deepEqual(report.citations.map(({ source }) => source), [null, null, null]);
});

test('the viewer preserves a legacy report without inventing citations or a mismatched source body', () => {
  const mismatched = runWith([internal, external]);
  mismatched.nodeStates['internal-research'].attempts[1].output.internal_evidence.version = 'v9';
  const [current] = runEvidenceReports(mismatched);
  assert.equal(current.citations[0].source.artifacts[0].body, null);

  const legacy = runWith(undefined);
  delete legacy.graph.nodes.at(-1).review.requiredSourceRefs;
  const [older] = runEvidenceReports(legacy);
  assert.equal(older.body.finding, 'Synthesis finding');
  assert.deepEqual(older.citations, []);
});

test('the persisted envelope identifies an unambiguous body without duplicated identity fields', () => {
  const run = runWith([internal, external]);
  for (const record of [run.nodeStates['internal-research'].attempts[1].output.internal_evidence,
    run.nodeStates['synthesize-discovery'].attempts[0].output.discovery_brief]) {
    delete record.id;
    delete record.version;
  }
  const [report] = runEvidenceReports(run);
  assert.equal(report.body.finding, 'Synthesis finding');
  assert.equal(report.citations[0].source.artifacts[0].body.finding, 'Original accepted internal finding');
});

test('an unidentified body cannot be silently assigned to a different version or same-kind artifact', () => {
  const revised = runWith([internal, external]);
  const source = revised.nodeStates['internal-research'].attempts[1];
  delete source.output.internal_evidence.version;
  source.artifacts.unshift({ ...internal, version: 'v1' });
  const [afterRevision] = runEvidenceReports(revised);
  assert.equal(afterRevision.citations[0].source.artifacts[0].body, null);

  const ambiguous = runWith([internal, external]);
  const externalAttempt = ambiguous.nodeStates['external-research'].attempts[0];
  delete externalAttempt.output.external_evidence.id;
  externalAttempt.artifacts.push({ ...external, id: 'another-external-report' });
  const [withDuplicateKind] = runEvidenceReports(ambiguous);
  assert.equal(withDuplicateKind.citations[1].source.artifacts[0].body, null);
});
