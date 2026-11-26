export async function resolveAutomationMode(engine, project, runId, decisionId) {
  const requested = project.automationMode ?? 'manual';
  if (requested === 'assisted') return requested;
  if (requested === 'full-auto') {
    if (project.allowFullAuto === true) return requested;
    await engine.recordAutomationDowngrade(runId, decisionId);
  }
  return 'manual';
}

export function assertAutomationModeCeiling(mode, project) {
  const modes = ['manual', 'assisted', 'autonomous'];
  const ceiling = project.automationMode === 'full-auto' ? 'autonomous' : project.automationMode ?? 'manual';
  if (modes.indexOf(mode) > modes.indexOf(ceiling) || (mode === 'autonomous' && project.allowFullAuto !== true)) {
    throw new Error('Requested mode exceeds the project automation ceiling');
  }
}
