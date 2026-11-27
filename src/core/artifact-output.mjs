export const latestAttemptArtifacts = attempt => [...new Map((attempt?.artifacts ?? [])
  .map(artifact => [artifact.id, artifact])).values()];

export function artifactBody(attempt, artifact) {
  const output = attempt?.output;
  if (!output || !Object.hasOwn(output, artifact.kind)) return null;
  const body = output[artifact.kind];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.hasOwn(body, 'id') ? body.id !== artifact.id :
    latestAttemptArtifacts(attempt).filter(item => item.kind === artifact.kind).length !== 1) return null;
  // A self-review may revise an artifact without replacing its attempt output.
  if (Object.hasOwn(body, 'version') ? body.version !== artifact.version :
    attempt.artifacts.some(item => item.id === artifact.id && item.version !== artifact.version)) return null;
  return body;
}
