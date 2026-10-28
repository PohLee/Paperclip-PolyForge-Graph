// Synthetic fixture inputs only; real applications supply their reviewed criteria/baseline.
export function fixtureContractInputs(graphId, requirementId) {
  if (graphId === 'implementation') return { architecture_context: { disposition: 'not-applicable',
    rationale: 'Deterministic orchestration fixture has no deployed system or changed architecture' } };
  if (graphId === 'verification') return { acceptance_criteria: [{ id: 'AC-FIXTURE-1',
    description: 'Exercise the versioned orchestration handoff', requirementIds: [requirementId] }] };
  return {};
}
