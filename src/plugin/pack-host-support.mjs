import { canonical } from '../core/canonical.mjs';
import { createHash } from 'node:crypto';
import { workflowChildInput } from '../core/workflow-child-input.mjs';


const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const contractKinds = pack => new Set((Array.isArray(pack?.productMethodContracts) ? pack.productMethodContracts : [])
  .map(item => item?.artifactKind).filter(kind => typeof kind === 'string'));

export function governedPackGraph(pack, graphId) {
  const graph = pack?.graphs?.find(item => item.id === graphId);
  if (!graph) return false;
  if (pack.id === 'adlc') return true;
  if ((Array.isArray(pack.runtimeRequirements?.trustedHostServices) && pack.runtimeRequirements.trustedHostServices.length) ||
      (pack.runtimeRequirements?.artifactValidation !== undefined && pack.runtimeRequirements.artifactValidation !== null && pack.runtimeRequirements.artifactValidation !== false) ||
      (pack.policies?.artifactValidation !== undefined && pack.policies.artifactValidation !== null && pack.policies.artifactValidation !== false) ||
      (Array.isArray(pack.trustedHostServices) && pack.trustedHostServices.length) ||
      (Array.isArray(pack.productMethodContracts) && pack.productMethodContracts.length)) return true;
  const declaredKinds = contractKinds(pack);
  if (graph.nodes?.some(node => node.artifactValidation || node.productMethodContract || node.productMethodContracts ||
      (node.produces ?? []).some(kind => declaredKinds.has(kind)))) return true;
  return (pack.productMethodDecisionContracts ?? []).some(item => item.graphId === graphId);
}

const unsupportedError = (pack, graphId, detail = 'no matching trusted local adapter is installed') =>
  new Error(`Unsupported Pack host contract for ${pack?.id ?? 'unknown'}@${pack?.version ?? 'unknown'}/${graphId ?? 'unknown'}: ${detail}`);

function actorKey(actor) {
  if (!actor || !['human', 'agent', 'system'].includes(actor.kind) || typeof actor.id !== 'string' || !actor.id ||
      !Array.isArray(actor.roles) || (actor.executionId !== null && typeof actor.executionId !== 'string') ||
      (actor.kind === 'agent' && !actor.executionId) ||
      (actor.kind === 'system' && (actor.roles.length !== 0 || actor.executionId !== null))) {
    throw new Error('Authenticated host actor is invalid');
  }
  return canonical({ id: actor.id, kind: actor.kind, roles: [...new Set(actor.roles)].sort(),
    executionId: actor.executionId ?? null });
}

function adapterIdentity(descriptor, adapterBundleDigest) {
  return { packId: descriptor.packId, packVersion: descriptor.packVersion, packDigest: descriptor.packDigest,
    adapterId: descriptor.adapterId, adapterVersion: descriptor.adapterVersion, adapterBundleDigest };
}

const routedMethods = new Set(['submitNode', 'decideNode', 'resolveHumanGate', 'recordSelfReview']);
const runMutations = new Set([...routedMethods, 'recordWorkDecision', 'reviewWork', 'escalateNode', 'retryNode',
  'resolveReworkLimit', 'resolveConflict', 'openConflict', 'recordConflictPosition', 'resumeRun', 'recordProductDecision']);

/** Host-owned adapter registry. Pack data describes requirements but never authorizes executable code. */
export function createPackHostAdapterRegistry({ trustedAdapters, adapterBundleDigest, runtimeStore, runValidationDigest,
  systemActorId, hostServices = {} }) {
  if (!Array.isArray(trustedAdapters) || typeof adapterBundleDigest !== 'string' || !runtimeStore?.get || !runtimeStore?.record) {
    throw new Error('Trusted Pack adapter registry dependencies missing');
  }
  if (typeof runValidationDigest !== 'function') throw new Error('Core run validation digest is required');
  function resolve(pack) {
    if (!pack) return null;
    const packDigest = digest(canonical(pack));
    const descriptor = trustedAdapters.find(item => item.packId === pack.id && item.packVersion === pack.version &&
      item.packDigest === packDigest && typeof item.createHostApi === 'function');
    return descriptor ? { descriptor, identity: adapterIdentity(descriptor, adapterBundleDigest) } : null;
  }
  function graphStatus(pack, graphId, resolution = resolve(pack), forStart = true, companyId = null) {
    if (!requiresAdapter(pack, graphId)) return { available: true };
    if (!resolution) return { available: false, reason: unsupportedError(pack, graphId).message };
    const scopedServices = forStart && pack.graphs.find(graph => graph.id === graphId)?.hostAdmission
      ? (typeof hostServices.forRun === 'function' ? hostServices.forRun({ companyId, run: null, actor: null }) : hostServices.services)
      : null;
    if (forStart && pack.graphs.find(graph => graph.id === graphId)?.hostAdmission &&
        typeof scopedServices?.inspectSmallChange !== 'function') {
      return { available: false, reason: unsupportedError(pack, graphId,
        'the scoped Git inspection service is unavailable').message };
    }
    if (resolution.descriptor.adapterId === 'adlc-host-api') return { available: true };
    const requirements = resolution.descriptor.graphRequirements?.[graphId];
    if (!requirements) return { available: false, reason: unsupportedError(pack, graphId,
      'the trusted adapter has not enabled this Graph on the configured host').message };
    const missing = (requirements.services ?? []).filter(name => !hostServices.capabilities?.includes(name));
    if (requirements.imageDecoder === true && hostServices.imageDecoderAvailable !== true) missing.push('imageDecoder');
    if (requirements.imageProvider === true && !(hostServices.imageProviderIds?.length)) missing.push('authorized image provider');
    if (missing.length) return { available: false, reason: unsupportedError(pack, graphId,
      `required trusted Creative host services are unavailable: ${missing.join(', ')}${hostServices.reason ? ` (${hostServices.reason})` : ''}`).message };
    return { available: true, adapterId: resolution.identity.adapterId, adapterVersion: resolution.identity.adapterVersion };
  }
  function requiresAdapter(pack, graphId) { return governedPackGraph(pack, graphId); }
  function statusPack(pack, companyId) {
    const resolution = resolve(pack);
    const perGraph = (pack?.graphs ?? []).filter(graph => requiresAdapter(pack, graph.id)).map(graph => {
      const status = graphStatus(pack, graph.id, resolution, true, companyId);
      return { id: graph.id, ...status };
    });
    const unsupportedGraphs = perGraph.filter(item => !item.available).map(({ id, reason }) => ({ id, reason }));
    const supported = perGraph.filter(item => item.available);
    return { available: unsupportedGraphs.length === 0, ...(resolution ? { adapterId: resolution.identity.adapterId,
      adapterVersion: resolution.identity.adapterVersion, packDigest: resolution.identity.packDigest,
      adapterBundleDigest: resolution.identity.adapterBundleDigest } : {}), graphs: perGraph,
      unsupportedGraphs, ...(supported.length ? {} : { reason: unsupportedGraphs[0]?.reason }) };
  }
  function assertActor(authedActor, claimedActor) {
    if (actorKey(authedActor) !== actorKey(claimedActor)) throw new Error('Pack adapter actor differs from authenticated Paperclip actor');
    return authedActor;
  }
  function hostApi(resolution, engine, authedActor, companyId, run = null) {
    const trustedResolveActor = async ({ claimedActor, context }) => {
      if (authedActor?.kind === 'system') {
        if (authedActor.id === systemActorId && authedActor.roles?.length === 0 && authedActor.executionId === null &&
            context?.operation === 'submitNode') {
        const node = context.run?.graph?.nodes?.find(item => item.id === context.nodeId);
        if (node && ['join', 'end'].includes(node.type) && actorKey(authedActor) === actorKey(claimedActor)) return authedActor;
        throw new Error('Host system actor is limited to automatic ADLC join/end transitions');
        }
        throw new Error('Authenticated host system actor is not authorized for this Pack operation');
      }
      return assertActor(authedActor, claimedActor);
    };
    const scopedServices = typeof hostServices.forRun === 'function' ? hostServices.forRun({ companyId, run, actor: authedActor }) : hostServices.services;
    return resolution.descriptor.createHostApi({ engine, resolveActor: trustedResolveActor, runValidationDigest,
      ...(scopedServices ? { services: scopedServices } : {}) });
  }
  async function runResolution(engine, companyId, run, ancestors = new Set()) {
    if (ancestors.has(run.id)) throw new Error('Recursive workflow adapter lineage');
    ancestors.add(run.id);
    if (run.parentWorkflow) {
      const parent = await engine.getRun(run.parentWorkflow.runId);
      if (!parent || parent.input?.paperclipCompanyId !== companyId ||
          run.input?.paperclipCompanyId !== companyId || parent.input?.paperclipIssueId !== run.input?.paperclipIssueId) {
        throw new Error('Workflow adapter ancestor scope mismatch');
      }
      await runResolution(engine, companyId, parent, ancestors);
    }
    const pack = run?.pack;
    if (!pack || pack.id !== run.packId || pack.version !== run.packVersion) {
      throw unsupportedError(pack, run?.graph?.id, 'run has no valid immutable Pack snapshot; recover the run before continuing');
    }
    const resolution = resolve(pack);
    if (!resolution) {
      if (requiresAdapter(pack, run?.graph?.id)) throw unsupportedError(pack, run?.graph?.id);
      return null;
    }
    const support = graphStatus(pack, run?.graph?.id, resolution, false);
    if (!support.available) throw new Error(support.reason);
    const latestValidation = await runtimeStore.getLatestValidation?.(companyId, run.id);
    if (latestValidation?.status === 'invalid' || latestValidation?.valid === false) {
      throw unsupportedError(pack, run.graph?.id, `latest host revalidation is invalid: ${latestValidation.reason || 'review the recorded validation issues'}`);
    }
    if (latestValidation && run.hostValidationId !== latestValidation.validationToken) {
      throw unsupportedError(pack, run.graph?.id, 'run host-validation binding is stale; revalidate the pinned run before continuing');
    }
    const recorded = await runtimeStore.get(companyId, run.id);
    if (!recorded) throw unsupportedError(pack, run.graph?.id, 'pinned host adapter identity is missing; recover the run before continuing');
    if (canonical(recorded) !== canonical(resolution.identity)) {
      throw unsupportedError(pack, run.graph?.id, 'pinned host adapter identity does not match this runtime');
    }
    if (run.packId !== resolution.identity.packId || run.packVersion !== resolution.identity.packVersion) {
      throw unsupportedError(pack, run.graph?.id, 'run Pack identity differs from its pinned host adapter');
    }
    return resolution;
  }
  async function runStatus(engine, companyId, run) {
    if (!run) return { available: true };
    let validation = null, recoverable = false;
    try {
      if (run.parentWorkflow) await runResolution(engine, companyId, run);
      const resolution = resolve(run.pack);
      if (!run.pack || run.pack.id !== run.packId || run.pack.version !== run.packVersion) {
        throw unsupportedError(run.pack, run.graph?.id, 'run has no valid immutable Pack snapshot; recover the run before continuing');
      }
      if (resolution) {
        try { recoverable = typeof hostApi(resolution, engine, null, companyId, run).validateRun === 'function'; }
        catch { recoverable = false; }
      }
      validation = await runtimeStore.getLatestValidation?.(companyId, run.id) ?? null;
      if (!resolution) {
        if (requiresAdapter(run.pack, run.graph?.id)) throw unsupportedError(run.pack, run.graph?.id);
        return { available: true, recoverable, validation };
      }
      const support = graphStatus(run.pack, run.graph?.id, resolution, false);
      if (!support.available) throw new Error(support.reason);
      if (validation?.status === 'invalid' || validation?.valid === false) throw new Error(
        `Latest host revalidation is invalid: ${validation.reason || 'review the recorded validation issues'}`);
      if (validation && run.hostValidationId !== validation.validationToken) throw new Error(
        'Run host-validation binding is stale; revalidate the pinned run before continuing');
      const recorded = await runtimeStore.get(companyId, run.id);
      if (!recorded) throw unsupportedError(run.pack, run.graph?.id, 'pinned host adapter identity is missing; recover the run before continuing');
      if (canonical(recorded) !== canonical(resolution.identity)) throw unsupportedError(run.pack, run.graph?.id,
        'pinned host adapter identity does not match this runtime');
      return { available: true, adapterId: resolution.identity.adapterId,
        adapterVersion: resolution.identity.adapterVersion, recoverable, validation };
    } catch (error) { return { available: false, reason: error.message, recoverable, validation }; }
  }
  function withEngine(engine, companyId, catalog) {
    async function assertRunSupported(runId) {
      const run = await engine.getRun(runId);
      if (!run) return null;
      return { run, resolution: await runResolution(engine, companyId, run) };
    }
    async function callRunAdapter(methodName, args) {
      const run = await engine.getRun(args.runId);
      if (!run) return Reflect.apply(engine[methodName], engine, [args]);
      const resolution = await runResolution(engine, companyId, run);
      if (!resolution) return Reflect.apply(engine[methodName], engine, [args]);
      const actor = args.actor;
      // Wrapper validation must be bound to the same immutable snapshot whose
      // Pack identity was resolved above. Writes still reach the real engine,
      // whose expectedRunDigest precondition rejects a concurrent change.
      const capturedRun = structuredClone(run);
      const preserveDigest = methodName === 'resolveHumanGate' ||
        (methodName === 'decideNode' && args.expectedRunDigest !== undefined);
      const expectedRunDigest = preserveDigest ? args.expectedRunDigest : runValidationDigest(run);
      const validationEngine = new Proxy(engine, { get(target, property) {
        if (property === 'getRun') return async id => id === capturedRun.id ? structuredClone(capturedRun) : target.getRun(id);
        // Adapters compute their own validation digest. Preserve the owner's displayed
        // snapshot through that boundary; Core performs the final atomic check.
        if (['decideNode', 'resolveHumanGate'].includes(methodName) && property === methodName)
          return checked => target[property]({ ...checked, expectedRunDigest });
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const api = hostApi(resolution, validationEngine, actor, companyId, capturedRun);
      const method = api[methodName];
      if (typeof method !== 'function') throw unsupportedError(run.pack, run.graph?.id,
        `trusted adapter does not implement ${methodName}`);
      const result = await method.call(api, { ...args, expectedRunDigest });
      if (methodName === 'submitNode' && result?.standardRoute?.targetRunId) {
        await runtimeStore.record(companyId, result.standardRoute.targetRunId, resolution.identity);
      }
      return result;
    }
    return new Proxy(engine, { get(target, property) {
      const method = target[property];
      if (typeof method !== 'function') return method;
      if (property === 'startChildWorkflow') return async args => {
        const parent = await target.getRun(args.runId);
        if (!parent || parent.input?.paperclipCompanyId !== companyId) throw new Error('Child workflow parent company mismatch');
        await runResolution(target, companyId, parent);
        const node = parent.graph.nodes.find(item => item.id === args.nodeId);
        if (node?.type !== 'workflow') throw new Error('Node is not a workflow');
        const ref = node.workflow;
        const pack = catalog.find(item => item.id === ref.packId && item.version === ref.packVersion);
        assertPackStart(pack, ref.graphId, companyId);
        const resolution = resolve(pack);
        if (!resolution) return Reflect.apply(method, target, [args]);
        let root = parent;
        const seen = new Set();
        while (root.parentWorkflow) {
          if (seen.has(root.id)) throw new Error('Recursive child lineage');
          seen.add(root.id);
          root = await target.getRun(root.parentWorkflow.runId);
          if (!root || root.input?.paperclipCompanyId !== companyId) throw new Error('Child workflow root company mismatch');
        }
        // Validate using the immutable original initiator, never elevate the
        // orchestration system actor to a domain actor.
        const request = { ...ref, input: workflowChildInput(parent, node), actor: root.startedBy,
          mode: parent.mode, deliveryLimits: parent.deliveryLimits };
        const expectedRunDigest = runValidationDigest(parent);
        let created = null;
        const childEngine = new Proxy(target, { get(inner, name) {
          if (name === 'startRun') return async checked => {
            if (canonical(checked) !== canonical(request)) throw new Error('Child adapter changed the pinned start context; enrichment is unsupported');
            created = await inner.startChildWorkflow({ ...args, expectedRunDigest });
            return created;
          };
          const value = inner[name];
          return typeof value === 'function' ? value.bind(inner) : value;
        } });
        const api = hostApi(resolution, childEngine, root.startedBy, companyId, parent);
        if (typeof api.startRun !== 'function') throw unsupportedError(pack, ref.graphId, 'trusted adapter does not implement startRun');
        const run = await api.startRun(request);
        if (!created || run?.id !== created.id) throw new Error('Child adapter did not use atomic child creation');
        // If this write fails the child remains undispatchable. Retrying the
        // same parent link repairs this binding without creating another run.
        await runtimeStore.record(companyId, run.id, resolution.identity);
        return run;
      };
      if (property === 'startRun') return async args => {
        const pack = catalog.find(item => item.id === args.packId && item.version === args.packVersion);
        const resolution = resolve(pack);
        if (!resolution) {
          if (requiresAdapter(pack, args.graphId)) throw unsupportedError(pack, args.graphId);
          return Reflect.apply(method, target, [args]);
        }
        const support = graphStatus(pack, args.graphId, resolution, true, companyId);
        if (!support.available) throw new Error(support.reason);
        const api = hostApi(resolution, target, args.actor, companyId);
        if (typeof api.startRun !== 'function') throw unsupportedError(pack, args.graphId,
          'trusted adapter does not implement startRun');
        const run = await api.startRun(args);
        await runtimeStore.record(companyId, run.id, resolution.identity);
        return run;
      };
      if (property === 'getReadyNodes' || property === 'getWorkItems') return async runId => {
        const run = await target.getRun(runId);
        if (run) {
          try { await runResolution(target, companyId, run); }
          catch { return []; }
        }
        return Reflect.apply(method, target, [runId]);
      };
      if (routedMethods.has(property)) return args => callRunAdapter(property, args);
      if (runMutations.has(property)) return async args => {
        const checked = await assertRunSupported(args.runId);
        if (!checked?.resolution) return Reflect.apply(method, target, [args]);
        if (property === 'resolveReworkLimit' && !args.expectedRunDigest) throw new Error('Missing rework decision run digest');
        return Reflect.apply(method, target, [{ ...args, expectedRunDigest: args.expectedRunDigest ?? runValidationDigest(checked.run) }]);
      };
      return method.bind(target);
    } });
  }
  function assertPackStart(pack, graphId, companyId) {
    if (!requiresAdapter(pack, graphId)) return;
    const resolution = resolve(pack);
    const support = graphStatus(pack, graphId, resolution, true, companyId);
    if (!support.available) throw new Error(support.reason);
  }
  return { resolve, requiresAdapter, graphStatus, statusPack, runStatus, withEngine, assertPackStart,
    assertChildStart: assertPackStart };
}
