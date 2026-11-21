// A Graph command can commit even when Paperclip cannot confirm a downstream effect.
export function dispatchReceiptNotice(actions = []) {
  const messages = new Set();
  for (const action of actions) {
    let message;
    switch (action.status) {
      case 'effect_unknown':
      case 'claimed_elsewhere':
        message = 'Issue creation is awaiting confirmation. Check the existing issue in Paperclip before retrying.';
        break;
      case 'assignment_pending':
        message = 'Assignment is awaiting confirmation. Check the existing issue and agent activity in Paperclip.';
        break;
      case 'ownership_conflict':
        message = 'The issue is assigned to a human. Resolve ownership in Paperclip before retrying.';
        break;
      case 'effect_ambiguous':
      case 'effect_mismatched':
      case 'effect_orphaned':
        message = 'The issue could not be linked safely. Check its origin and parent in Paperclip before retrying.';
        break;
      case 'effect_confirmed_failure':
        message = 'Issue creation failed or was cancelled. Inspect the dispatch record before retrying.';
        break;
      default:
        continue;
    }
    messages.add(`${action.nodeId}: ${message}`);
  }
  return [...messages].join(' ');
}
