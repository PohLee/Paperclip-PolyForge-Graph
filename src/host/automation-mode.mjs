export async function resolveAutomationMode(engine, project, runId, decisionId) {
  const requested = project.automationMode ?? 'manual';
  if (requested === 'assisted') return requested;
  if (requested === 'full-auto') {
    if (project.allowFullAuto === true) return requested;
    await engine.recordAutomationDowngrade(runId, decisionId);
  }
  return 'manual';
}
