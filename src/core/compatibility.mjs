import semver from 'semver';

export const CORE_RUNTIME = Object.freeze({
  version: '0.8.1',
  schemaVersion: 1,
  contracts: Object.freeze({ graph: 1, decision: 1, evidence: 1 }),
  capabilities: Object.freeze({
    'company-control': '1.0.0', 'cross-pack-plans': '1.0.0', 'goal-pinning': '1.0.0',
    'shadow-provenance': '1.0.0', 'outcome-reviews': '1.0.0', 'cross-pack-handoff': '1.0.0',
  }),
});

export function satisfies(version, range) {
  if (!semver.valid(version) || !semver.validRange(range ?? '*')) throw new Error(`Invalid semantic version or range: ${version} ${range}`);
  return semver.satisfies(version, range ?? '*', { includePrerelease: false });
}

function capabilityMap(value) {
  if (Array.isArray(value)) return Object.fromEntries(value.map(id => [id, '*']));
  return value ?? {};
}

export function capabilityAvailable(pack, graph, name, { runtime = CORE_RUNTIME, availableCapabilities = {} } = {}) {
  const version = { ...runtime.capabilities, ...availableCapabilities }[name];
  if (!version || !semver.valid(version)) return false;
  const ranges = [pack?.compatibility, graph?.compatibility].flatMap(spec => [
    capabilityMap(spec?.requiredCapabilities)[name], capabilityMap(spec?.optionalCapabilities)[name],
  ]).filter(Boolean);
  return ranges.every(range => satisfies(version, range));
}

export function compatibilityIssues(pack, graph, { runtime = CORE_RUNTIME, availableCapabilities = {} } = {}) {
  const issues = [];
  const available = { ...runtime.capabilities, ...availableCapabilities };
  if (pack?.schemaVersion !== undefined && pack.schemaVersion !== runtime.schemaVersion) issues.push(`pack requires schema version ${pack.schemaVersion}`);
  for (const [scope, spec] of [['pack', pack?.compatibility], ['graph', graph?.compatibility]]) {
    if (!spec) continue;
    if (spec.coreRange && !satisfies(runtime.version, spec.coreRange)) issues.push(`${scope} requires Core ${spec.coreRange}`);
    for (const [name, version] of Object.entries(spec.contracts ?? {})) {
      if (runtime.contracts?.[name] !== version) issues.push(`${scope} requires ${name} contract ${version}`);
    }
    for (const [name, range] of Object.entries(capabilityMap(spec.requiredCapabilities))) {
      if (!available[name] || !satisfies(available[name], range)) issues.push(`${scope} requires capability ${name}@${range}`);
    }
  }
  return issues;
}

export function assertCompatible(pack, graph, options) {
  const issues = compatibilityIssues(pack, graph, options);
  if (issues.length) throw new Error(`Incompatible Pack: ${issues.join('; ')}`);
}

export function preflightPackChange({ catalog = [], enabled = [], candidate, activeRuns = [], runtime = CORE_RUNTIME, availableCapabilities = {} }) {
  const releases = new Map(catalog.map(pack => [`${pack.id}@${pack.version}`, pack]));
  const selected = candidate ? [...enabled.filter(item => item.packId !== candidate.packId), candidate] : enabled;
  const issues = [];
  const unavailableGraphs = [];
  for (const item of selected) {
    const pack = releases.get(`${item.packId}@${item.version}`);
    if (!pack) { issues.push(`Pack ${item.packId}@${item.version} missing from instance catalog`); continue; }
    issues.push(...compatibilityIssues(pack, null, { runtime, availableCapabilities }).map(issue => `${pack.id}@${pack.version}: ${issue}`));
    for (const graph of pack.graphs ?? []) {
      const graphIssues = compatibilityIssues(null, graph, { runtime, availableCapabilities });
      if (graphIssues.length) unavailableGraphs.push({ packId: pack.id, version: pack.version, graphId: graph.id, issues: graphIssues });
    }
  }
  for (const run of activeRuns) {
    if (['completed', 'stopped', 'failed'].includes(run.status)) continue;
    const pinned = releases.get(`${run.packId}@${run.packVersion}`) ?? run.pack;
    if (!pinned) { issues.push(`Active run ${run.id} has no pinned Pack`); continue; }
    issues.push(...compatibilityIssues(pinned, run.graph, { runtime, availableCapabilities }).map(issue => `Active run ${run.id}: ${issue}`));
  }
  return { ok: issues.length === 0, issues, unavailableGraphs };
}
