// Synthetic fixture inputs only; real applications supply their reviewed criteria/baseline.
export function fixtureContractInputs(graphId, requirementId) {
  const acceptance = { acceptance_criteria: [{ id: 'AC-FIXTURE-1',
    description: 'Exercise the versioned orchestration handoff', requirementIds: [requirementId] }] };
  if (graphId === 'implementation') return { ...acceptance, architecture_context: { disposition: 'not-applicable',
    rationale: 'Deterministic orchestration fixture has no deployed system or changed architecture' } };
  if (graphId === 'verification') return { ...acceptance,
    verification_plan: { id: 'E2E-ORCHESTRATION-VERIFICATION', version: 'v1',
      scope: 'Synthetic host orchestration checks; no production application validation claim' } };
  return {};
}
