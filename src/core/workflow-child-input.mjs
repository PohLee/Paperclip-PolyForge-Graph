import { resolveWorkflowMapping } from './workflow-contracts.mjs';

// Shared preparation for Core's atomic child start and trusted Host validation.
// Business mappings never overwrite company, delivery, or authorization context.
export function workflowChildInput(parent, node) {
  const input = {};
  for (const key of ['paperclipCompanyId', 'projectId', 'paperclipIssueId', 'taskId', 'feature',
    'product_decision_refs', 'productDecisionRefs', 'changesBehavior', 'approvedChangeDecisionId', 'changeScope']) {
    if (parent.input[key] !== undefined) input[key] = structuredClone(parent.input[key]);
  }
  input.parentRunId = parent.id;
  input.deliveryId = parent.input.deliveryId ?? parent.input.paperclipIssueId ?? parent.id;
  input.workflowInput = resolveWorkflowMapping(node.inputMapping, parent);
  return input;
}
