import { latestAttemptArtifacts as latestArtifacts, artifactBody } from '../core/artifact-output.mjs';

const refMatches = (artifact, ref) => artifact.kind === ref.kind &&
  artifact.id === ref.id && artifact.version === ref.version;

function resolveSource(run, sourceNode, ref) {
  const matches = (run.nodeStates[sourceNode.id]?.attempts ?? []).flatMap((attempt, index) => {
    if (attempt.supervisorReview?.outcome !== 'accept') return [];
    const artifacts = latestArtifacts(attempt);
    if (!artifacts.some(artifact => refMatches(artifact, ref))) return [];
    return [{ node: sourceNode, attemptNumber: index + 1, review: attempt.supervisorReview,
      artifacts: artifacts.map(artifact => ({ artifact, body: artifactBody(attempt, artifact) }))
        .filter(item => refMatches(item.artifact, ref) || item.body) }];
  });
  return matches.length === 1 ? matches[0] : null;
}

export function runEvidenceReports(run) {
  return run.graph.nodes.flatMap(node => {
    const rule = node.review?.requiredSourceRefs;
    const reportKind = rule?.reportKind ??
      (run.graph.id === 'product-discovery' && node.id === 'synthesize-discovery' ? 'discovery_brief' : null);
    if (!reportKind) return [];
    const attempts = run.nodeStates[node.id]?.attempts ?? [];
    const attempt = attempts.at(-1);
    const artifacts = latestArtifacts(attempt);
    const artifact = artifacts.find(item => item.kind === reportKind);
    if (!artifact) return [];
    const body = artifactBody(attempt, artifact);
    const citations = (Array.isArray(body?.researchRefs) ? body.researchRefs : [])
      .filter(ref => [ref?.kind, ref?.id, ref?.version].every(value => typeof value === 'string' && value))
      .map(ref => {
        const sourceNodeId = rule?.sources?.find(source => source.kind === ref.kind)?.nodeId;
        const sourceNode = run.graph.nodes.find(item => item.id === sourceNodeId);
        return { ref, source: sourceNode ? resolveSource(run, sourceNode, ref) : null };
      });
    return [{ node, artifact, body, attemptNumber: attempts.length, review: attempt.supervisorReview, citations,
      related: artifacts.filter(item => item !== artifact).map(item => ({ artifact: item, body: artifactBody(attempt, item) }))
        .filter(item => item.body) }];
  });
}
