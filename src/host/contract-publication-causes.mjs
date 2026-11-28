const mismatches = new Set([
  'contract-type-slug-missing', 'contract-id-collision', 'contract-index-invalid', 'contract-lock-invalid',
  'contract-not-english', 'contract-criteria-invalid', 'contract-manifest-invalid', 'contract-drift',
  'contract-supersedes-stale', 'contract-deliverable-invalid', 'contract-proposal-differs',
  'publication-unauthorized', 'contract-product-missing', 'publication-approval-stale', 'publication-run-on-hold', 'github-contract-tree-truncated',
  'github-main-ancestry-unproven', 'github-pull-already-recorded',
]);

export function contractPublicationError(code) {
  return Object.assign(new Error(code), { code, publicationCause: code });
}

export function publicationMismatch(error) {
  return mismatches.has(error?.publicationCause) ? error.publicationCause : null;
}

const retryCauses = new Set([
  'github-main-ancestry-unproven', 'github-contract-tree-truncated', 'github-request-unavailable',
  'github-invalid-tree', 'github-invalid-commit', 'github-invalid-comparison', 'github-invalid-pull',
  'github-invalid-status', 'github-repository-identity-mismatch', 'github-transport-redirect', 'github-transport-request-failed',
  'github-token-transport-failed', 'github-token-mint-failed', 'github-token-mint-rejected',
  'github-token-invalidated', 'github-token-invalid-response', 'github-token-invalid-permissions',
  'github-blob-too-large', 'github-blob-invalid-json', 'github-blob-invalid-metadata', 'github-blob-invalid-base64',
  'untrusted-runtime-binding', 'untrusted-ancestor-binding', 'publication-revision-changed',
]);

export function publicationRetryCause(error) {
  const transportCause = error?.code === 'github-token-transport-failed' ? error.cause?.code : null;
  if (retryCauses.has(transportCause)) return transportCause;
  const code = error?.publicationCause ?? error?.code;
  return retryCauses.has(code) ? code : 'publication-retry';
}
