const mismatches = new Set([
  'contract-type-slug-missing', 'contract-id-collision', 'contract-index-invalid', 'contract-lock-invalid',
  'contract-not-english', 'contract-criteria-invalid', 'contract-manifest-invalid', 'contract-drift',
  'contract-supersedes-stale', 'contract-deliverable-invalid', 'contract-proposal-differs',
  'publication-approval-stale', 'github-main-ancestry-unproven', 'github-pull-already-recorded',
]);

export function contractPublicationError(code) {
  return Object.assign(new Error(code), { code, publicationCause: code });
}

export function publicationMismatch(error) {
  return mismatches.has(error?.publicationCause) ? error.publicationCause : null;
}
