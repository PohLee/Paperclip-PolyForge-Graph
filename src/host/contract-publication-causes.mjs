const causes = new Map([
  ['publication-validator-unavailable', 'blocked-config'],
  ['publication-gate-disabled', 'blocked-config'],
  ['contract-type-slug-missing', 'blocked-config'],
  ['contract-id-collision', 'blocked-config'],
  ['contract-index-invalid', 'blocked-config'],
  ['github-app-invalid', 'blocked-config'],
  ['github-repository-identity-mismatch', 'blocked-config'],
  ['github-merge-repository-binding-conflict', 'blocked-config'],
  ['transport-redirect-unsafe', 'blocked-config'],
  ['publication-approval-stale', 'needs-new-approval'],
  ['publication-policy-changed', 'needs-new-approval'],
  ['project-binding-mismatch', 'needs-new-approval'],
  ['contract-not-english', 'needs-new-approval'],
  ['contract-criteria-invalid', 'needs-new-approval'],
  ['contract-manifest-invalid', 'needs-new-approval'],
  ['contract-supersedes-stale', 'needs-new-approval'],
  ['contract-lock-invalid', 'needs-new-approval'],
  ['contract-deliverable-invalid', 'needs-new-approval'],
  ['contract-proposal-differs', 'needs-new-approval'],
  ['github-merge-main-changed', 'needs-new-approval'],
  ['github-merge-pull-already-recorded', 'needs-new-approval'],
  ['github-merge-request-changed', 'needs-new-approval'],
  ['github-merge-abandoned', 'needs-new-approval'],
  ['github-merge-repository-busy', 'backoff'],
  ['repository-blocked', 'backoff'],
  ['github-merge-intent-unavailable', 'backoff'],
  ['publication-retry', 'backoff'],
]);

export function contractPublicationError(code, message = code) {
  return Object.assign(new Error(message), { publicationCause: code });
}

export function contractPublicationDisposition(error) {
  const reason = causes.has(error?.publicationCause) ? error.publicationCause : 'publication-retry';
  return { state: causes.get(reason), reason };
}
