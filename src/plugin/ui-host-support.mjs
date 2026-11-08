/** Presentation policy only. The authenticated server remains the authority. */
export function graphHostIssue(pack, graphId) {
  const support = pack?.hostSupport;
  const issue = support?.unsupportedGraphs?.find(item => item.id === graphId);
  if (issue) return issue.reason || 'This Graph needs a trusted host service that is not configured.';
  if (support?.available === false && !support.unsupportedGraphs?.length) {
    return support.reason || 'This Pack needs a trusted host adapter before it can run.';
  }
  return null;
}

export function runHostActions(support, viewer) {
  const blocked = support?.available === false;
  return {
    blocked,
    canValidate: blocked && support.recoverable === true && viewer?.kind === 'human' &&
      viewer.roles?.includes('human-owner') === true,
  };
}
