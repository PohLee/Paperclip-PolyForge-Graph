const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function identity(experiment) {
  if (!experiment || !experiment.model || !experiment.toolsVersion || !experiment.repoSha || !experiment.packDigest) {
    throw new Error('Experiment must pin model, toolsVersion, repoSha and packDigest');
  }
  if (!experiment.changedVariable || !Object.hasOwn(experiment.baseline ?? {}, experiment.changedVariable) ||
      !Object.hasOwn(experiment.candidate ?? {}, experiment.changedVariable)) {
    throw new Error('Exactly one named changedVariable is required');
  }
  const without = variant => Object.fromEntries(Object.entries(variant).filter(([key]) => key !== experiment.changedVariable));
  if (stable(without(experiment.baseline)) !== stable(without(experiment.candidate)) ||
      stable(experiment.baseline[experiment.changedVariable]) === stable(experiment.candidate[experiment.changedVariable])) {
    throw new Error('Baseline and candidate must differ in exactly the changed variable');
  }
  if (!Array.isArray(experiment.scenarios) || !experiment.scenarios.length ||
      new Set(experiment.scenarios.map(item => item.id)).size !== experiment.scenarios.length ||
      experiment.scenarios.some(item => !item.id || !item.requirement)) throw new Error('Unique scenarios with requirements are required');
  if (!Number.isInteger(experiment.repetitions) || experiment.repetitions < 2 || experiment.repetitions > 20) {
    throw new Error('Use 2–20 repetitions per scenario');
  }
}

// runCase invokes the real agent; assess is an independent, host-controlled
// scorer. Missing provider metrics remain null instead of becoming zero.
export async function compareBehavior(experiment, { runCase, assess }) {
  identity(experiment);
  if (typeof runCase !== 'function' || typeof assess !== 'function' || runCase === assess) {
    throw new Error('Separate runCase and assess adapters are required');
  }
  const results = [];
  for (const scenario of experiment.scenarios) {
    for (let repetition = 1; repetition <= experiment.repetitions; repetition++) {
      for (const variant of ['baseline', 'candidate']) {
        const started = Date.now();
        let observation, score;
        try {
          observation = await runCase({ scenario: structuredClone(scenario), variant,
            settings: structuredClone(experiment[variant]), repetition,
            pinned: { model: experiment.model, toolsVersion: experiment.toolsVersion,
              repoSha: experiment.repoSha, packDigest: experiment.packDigest } });
          score = await assess({ scenario: structuredClone(scenario), observation: structuredClone(observation), variant });
        } catch (error) {
          results.push({ scenarioId: scenario.id, repetition, variant, pass: null,
            criticalFailure: null, invalidReason: error instanceof Error ? error.message : String(error),
            evidence: [], trajectoryRef: observation?.trajectoryRef ?? null,
            metrics: { requests: null, inputTokens: null, outputTokens: null, cacheHits: null,
              wallMs: Date.now() - started } });
          continue;
        }
        if (typeof score?.pass !== 'boolean' || typeof score?.criticalFailure !== 'boolean' ||
            !Array.isArray(score?.evidence)) throw new Error('Independent scorer must return pass, criticalFailure and evidence');
        const metrics = observation?.metrics ?? {};
        results.push({ scenarioId: scenario.id, repetition, variant, pass: score.pass,
          criticalFailure: score.criticalFailure, evidence: score.evidence,
          trajectoryRef: observation?.trajectoryRef ?? null,
          metrics: { requests: metrics.requests ?? null, inputTokens: metrics.inputTokens ?? null,
            outputTokens: metrics.outputTokens ?? null, cacheHits: metrics.cacheHits ?? null,
            wallMs: metrics.wallMs ?? Date.now() - started } });
      }
    }
  }
  const perScenario = experiment.scenarios.map(scenario => {
    const rows = results.filter(row => row.scenarioId === scenario.id);
    const baseline = rows.filter(row => row.variant === 'baseline');
    const candidate = rows.filter(row => row.variant === 'candidate');
    return { id: scenario.id, baselinePasses: baseline.filter(row => row.pass).length,
      candidatePasses: candidate.filter(row => row.pass).length, trials: experiment.repetitions,
      invalidTrials: rows.filter(row => row.pass === null).length,
      criticalRegressions: candidate.filter((row, index) => row.criticalFailure === true && baseline[index].criticalFailure === false).length,
      passToFail: candidate.filter((row, index) => row.pass === false && baseline[index].pass === true).length,
      failToPass: candidate.filter((row, index) => row.pass === true && baseline[index].pass === false).length };
  });
  return { pinned: { model: experiment.model, toolsVersion: experiment.toolsVersion,
    repoSha: experiment.repoSha, packDigest: experiment.packDigest },
    changedVariable: experiment.changedVariable, repetitions: experiment.repetitions,
    perScenario, results,
    eligible: perScenario.every(item => item.invalidTrials === 0 && item.criticalRegressions === 0 && item.passToFail === 0) };
}

export function trajectoryReview(events) {
  if (!Array.isArray(events)) throw new Error('Trace events are required');
  return events.map((event, index) => ({ index, at: event.at ?? null,
    action: event.action ?? event.kind ?? 'unknown',
    inputRef: event.inputRef ?? null, resultRef: event.resultRef ?? null,
    failure: event.error ?? null }))
    .filter(event => event.action !== 'unknown' || event.failure);
}
