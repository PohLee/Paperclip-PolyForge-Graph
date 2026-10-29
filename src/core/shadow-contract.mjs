const digest = /^sha256:[a-f0-9]{64}$/;

const sameRef = (left, right) => left?.id === right?.id && left?.version === right?.version &&
  left?.digest === right?.digest;

/** Validate a completed review against the immutable candidate snapshot. */
export function validateShadowReviewResult(result, snapshot) {
  if (!snapshot?.id || !Array.isArray(snapshot.candidateRefs) || !snapshot.candidateRefs.length ||
      !result || !digest.test(result.outputDigest)) {
    throw new Error('Bounded Shadow review result and reserved snapshot required');
  }
  const legacy = result.status === 'synthetic-fixture-reviewed';
  const provenance = result.provenance;
  if (provenance && (!['process', 'codex_local', 'claude_local', 'opencode_local'].includes(provenance.adapterType) ||
      typeof provenance.synthetic !== 'boolean' ||
      (provenance.synthetic && provenance.adapterType !== 'process'))) {
    throw new Error('Invalid Shadow execution provenance');
  }
  if (!legacy && (result.status !== 'reviewed' || result.schemaVersion !== 1 ||
      !['accept', 'rework'].includes(result.verdict) ||
      !Array.isArray(result.candidateRefs) || result.candidateRefs.length !== snapshot.candidateRefs.length ||
      result.candidateRefs.some((ref, index) => !sameRef(ref, snapshot.candidateRefs[index])))) {
    throw new Error('Reviewed Shadow result must cite the exact reserved candidate snapshot');
  }
  if (!Array.isArray(result.findings) || result.findings.length > 20 ||
      (legacy && !result.findings.length)) {
    throw new Error('Bounded Shadow review findings required');
  }
  for (const finding of result.findings) {
    if (!['P0', 'P1', 'P2', 'P3'].includes(finding?.severity) ||
        typeof finding.summary !== 'string' || !finding.summary.trim() || finding.summary.length > 1000 ||
        !snapshot.candidateRefs.some(ref => sameRef(ref, finding.sourceRef))) {
      throw new Error('Shadow finding must cite a reserved candidate');
    }
    if (!legacy && result.verdict === 'accept' && ['P0', 'P1'].includes(finding.severity)) {
      throw new Error('Accepted Shadow review cannot contain P0/P1 findings');
    }
  }
  return legacy
    ? { status: result.status, findings: result.findings, outputDigest: result.outputDigest, snapshotId: snapshot.id }
    : { status: result.status, schemaVersion: 1, verdict: result.verdict,
        candidateRefs: result.candidateRefs, findings: result.findings,
        outputDigest: result.outputDigest, snapshotId: snapshot.id,
        ...(provenance ? { provenance: { adapterType: provenance.adapterType, synthetic: provenance.synthetic } } : {}) };
}
