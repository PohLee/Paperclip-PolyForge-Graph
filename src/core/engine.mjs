import { randomUUID } from 'node:crypto';
import { MemoryStore, RevisionConflict } from './store.mjs';

const copy = (value) => structuredClone(value);
const required = (value, name) => { if (value === undefined || value === null || value === '') throw new Error(`${name} is required`); return value; };
const keyOf = (packId, packVersion) => `${packId}@${packVersion}`;
const nodesOf = (graph) => Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
const contains = (items, value) => Array.isArray(items) && items.includes(value);
// PostgreSQL JSONB may reorder object keys. Arrays retain their order because it is semantic.
const fingerprint = (value) => JSON.stringify(value, function (_key, entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]));
  }
  return entry;
});
const latestArtifacts = (items) => [...new Map(items.map((item) => [item.id, item])).values()];

function trustedActor(actor) {
  if (!actor || !['human', 'agent', 'system'].includes(actor.kind) || typeof actor.id !== 'string' || !actor.id || !Array.isArray(actor.roles)) {
    throw new Error('Trusted actor context with id, kind and roles is required');
  }
  return { id: actor.id, kind: actor.kind, roles: [...actor.roles], executionId: actor.executionId ?? null };
}

function hasRole(actor, role) { return !role || contains(actor.roles, role); }
function assertRole(actor, role) { if (!hasRole(actor, role)) throw new Error(`Actor lacks required role: ${role}`); }
function assertAgentExecution(actor) { if (actor.kind === 'agent' && !actor.executionId) throw new Error('Agent executionId is required'); }

function validatePack(pack) {
  required(pack?.id, 'pack.id'); required(pack?.version, 'pack.version');
  if (!Array.isArray(pack.graphs) || pack.graphs.length === 0) throw new Error('Pack needs graphs');
  for (const graph of pack.graphs) {
    required(graph.id, 'graph.id'); required(graph.version, 'graph.version'); required(graph.start, 'graph.start');
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Graph needs nodes and edges arrays');
    const nodes = nodesOf(graph);
    if (Object.keys(nodes).length !== graph.nodes.length || !nodes[graph.start]) throw new Error(`Invalid node ids/start in ${graph.id}`);
    for (const node of graph.nodes) {
      if (!['task', 'decision', 'join', 'end'].includes(node.type)) throw new Error(`Unsupported node type: ${node.type}`);
      if (node.type === 'join' && node.mode !== 'all') throw new Error('Only ALL joins are supported');
      if (node.review && (node.type !== 'task' || !node.review.supervisorRole || (node.review.maxSelfReviews ?? 5) > 5 || (node.review.maxSelfReviews ?? 5) < 1)) throw new Error('Invalid review configuration');
      if (node.review && !pack.decisionRules?.some((rule) => rule.type === (node.review.decisionType ?? 'review'))) throw new Error(`Missing review decision rule for ${node.id}`);
      if (node.type === 'decision' && !pack.decisionRules?.some((rule) => rule.type === (node.decisionType ?? node.id))) throw new Error(`Missing decision rule for ${node.id}`);
      if (node.maxReworks !== undefined && (!Number.isInteger(node.maxReworks) || node.maxReworks < 1)) throw new Error('Invalid maxReworks');
      for (const ref of node.independentOf ?? []) if (!nodes[ref]) throw new Error(`Unknown independentOf node: ${ref}`);
      for (const ref of node.candidateNodes ?? []) if (!nodes[ref]) throw new Error(`Unknown candidate node: ${ref}`);
      if (node.candidateKinds && (!Array.isArray(node.candidateKinds) || node.candidateKinds.length === 0 || node.candidateKinds.some((kind) => typeof kind !== 'string' || !kind))) throw new Error('Invalid candidateKinds');
      if (node.reworkTarget && !nodes[node.reworkTarget]) throw new Error(`Unknown rework target: ${node.reworkTarget}`);
      if (node.requiredInputAny && (!Array.isArray(node.requiredInputAny) || node.requiredInputAny.some((group) => !Array.isArray(group) || group.length === 0 || group.some((kind) => typeof kind !== 'string')))) throw new Error('Invalid requiredInputAny');
    }
    for (const edge of graph.edges) if (!nodes[edge.from] || !nodes[edge.to]) throw new Error('Edge references unknown node');
    const visiting = new Set(), visited = new Set();
    const visit = (id) => {
      if (visiting.has(id)) throw new Error(`Graph ${graph.id} has a cycle`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const edge of graph.edges.filter((item) => item.from === id)) visit(edge.to);
      visiting.delete(id); visited.add(id);
    };
    visit(graph.start);
    if (visited.size !== graph.nodes.length) throw new Error(`Graph ${graph.id} has unreachable nodes`);
  }
}

function selected(edge, execution) {
  if (edge.when === undefined) return true;
  const outcome = execution?.outcome ?? execution?.output?.route;
  return contains(Array.isArray(edge.when) ? edge.when : [edge.when], outcome);
}

function activeNodes(run) {
  const graph = run.graph, nodes = nodesOf(graph), active = new Set([graph.start]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (!active.has(edge.from)) continue;
      const state = run.nodeStates[edge.from];
      if (state.status === 'completed' && !selected(edge, state)) continue;
      if (!active.has(edge.to)) { active.add(edge.to); changed = true; }
    }
  }
  return { active, nodes };
}

function ancestors(graph, targetId) {
  const found = new Set(), pending = [targetId];
  while (pending.length) {
    const id = pending.pop();
    for (const edge of graph.edges) if (edge.to === id && !found.has(edge.from)) { found.add(edge.from); pending.push(edge.from); }
  }
  return found;
}

function affectedNodes(run, initialIds) {
  const ids = new Set(initialIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of run.graph.edges) if (ids.has(edge.from) && !ids.has(edge.to)) { ids.add(edge.to); changed = true; }
    for (const node of run.graph.nodes) if (node.independentOf?.some((ref) => ids.has(ref)) && !ids.has(node.id)) { ids.add(node.id); changed = true; }
  }
  return ids;
}

function present(value, name) {
  if (value === null || value === undefined || value === '') return false;
  if (name === 'product_decision_refs') return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item);
  if (name.startsWith('versioned_') || name.endsWith('_identity') || name === 'implementation_candidate') {
    if (typeof value !== 'object') return false;
    if ((value.id || value.artifactId) && value.version) return true;
    if (name === 'implementation_candidate' && Array.isArray(value.artifacts) && value.artifacts.length > 0) {
      return value.artifacts.every((item) => (item.id || item.artifactId) && item.version);
    }
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function missingInputs(run, node, active) {
  const prior = ancestors(run.graph, node.id);
  const available = new Set();
  for (const [name, value] of Object.entries(run.input ?? {})) if (present(value, name)) available.add(name);
  for (const id of prior) {
    if (!active.has(id) || run.nodeStates[id].status !== 'completed') continue;
    for (const artifact of run.nodeStates[id].artifacts ?? []) if (artifact.kind && artifact.id && artifact.version) available.add(artifact.kind);
  }
  const missing = (node.requiredInputs ?? []).filter((kind) => !available.has(kind));
  for (const group of node.requiredInputAny ?? []) if (!group.some((kind) => available.has(kind))) missing.push(`one of ${group.join(', ')}`);
  return missing;
}

function structurallyReadyNodes(run) {
  if (run.status !== 'running') return [];
  const { active, nodes } = activeNodes(run);
  return [...active].filter((id) => {
    const node = nodes[id], state = run.nodeStates[id];
    if (state.status !== 'pending') return false;
    if (id === run.graph.start) return true;
    const incoming = run.graph.edges.filter((edge) => edge.to === id && active.has(edge.from));
    const completed = incoming.filter((edge) => run.nodeStates[edge.from].status === 'completed' && selected(edge, run.nodeStates[edge.from]));
    if (completed.length === 0) return false;
    if (node.type === 'join' && !incoming.every((edge) => run.nodeStates[edge.from].status === 'completed')) return false;
    return true;
  }).map((id) => ({ id, node: nodes[id], active }));
}

function readyNodes(run) {
  return structurallyReadyNodes(run)
    .filter(({ node, active }) => missingInputs(run, node, active).length === 0)
    .map(({ node }) => ({ ...copy(node), status: 'ready' }));
}

function ruleFor(run, type) {
  return run.pack.decisionRules?.find((entry) => entry.type === type && entry.mode === run.mode);
}

function decisionOutcomes(run, node) {
  return node.outcomes ?? [...new Set([
    ...run.graph.edges.filter((edge) => edge.from === node.id).flatMap((edge) =>
      Array.isArray(edge.when) ? edge.when : edge.when ? [edge.when] : []),
    ...(node.reworkTarget ? [node.reworkOutcome ?? 'rework'] : []),
  ])];
}

function policyWork(run, node, phase) {
  const review = phase === 'supervisor';
  const role = review ? node.review.supervisorRole : node.role;
  const type = review ? node.review.decisionType ?? 'review' : node.decisionType ?? node.id;
  const rule = ruleFor(run, type);
  const common = { nodeId: node.id, phase, operation: review ? 'review' : 'decide', role,
    outcomes: review ? ['accept', 'rework'] : decisionOutcomes(run, node) };
  if (!rule) return { ...common, kind: 'blocked', reason: `No decision rule for ${type} in ${run.mode} mode` };
  const allows = (kind) => !rule.allowedKinds || rule.allowedKinds.includes(kind);
  const agentRoleAllowed = role && (!rule.allowedRoles || rule.allowedRoles.includes(role));
  if (!rule.requiresHuman && allows('agent') && agentRoleAllowed) return { ...common, kind: 'agent' };
  if (allows('human')) return { ...common, kind: 'human' };
  return { ...common, kind: 'blocked', reason: `No eligible actor for ${type} in ${run.mode} mode` };
}

function workItems(run) {
  if (run.status === 'paused') {
    if (run.pendingHuman?.kind === 'decision') {
      const node = run.graph.nodes.find((item) => item.id === run.pendingHuman.nodeId);
      return [{ nodeId: node.id, phase: 'decision', kind: 'human', operation: 'resolve-human-gate',
        outcomes: decisionOutcomes(run, node) }];
    }
    if (run.pendingHuman?.kind === 'rework_limit') return [{ nodeId: run.pendingHuman.nodeId,
      phase: 'decision', kind: 'human', operation: 'resolve-rework-limit', outcomes: ['continue', 'stop'] }];
    const conflict = run.conflicts?.find((item) => item.status === 'waiting_human');
    return conflict ? [{ nodeId: conflict.nodeId ?? null, conflictId: conflict.id,
      phase: 'decision', kind: 'human', operation: 'resolve-conflict', outcomes: ['resolved'] }] : [];
  }
  if (run.status !== 'running') return [];
  const items = readyNodes(run).map((node) => {
    if (['join', 'end'].includes(node.type)) return { nodeId: node.id, phase: 'work', kind: 'automatic', operation: 'submit' };
    if (node.type === 'decision') return policyWork(run, node, 'work');
    return { nodeId: node.id, phase: 'work', kind: 'agent', operation: 'submit', role: node.role ?? null };
  });
  for (const node of run.graph.nodes) {
    if (node.review && run.nodeStates[node.id].status === 'awaiting_supervisor_review') {
      items.push(policyWork(run, node, 'supervisor'));
    }
  }
  return items;
}

function audit(state, kind, details, now) {
  const event = { id: randomUUID(), at: now(), kind, ...copy(details) };
  state.audit.push(event);
  return event;
}

function decisionRecord(state, run, actor, details, now) {
  const record = {
    id: randomUUID(), at: now(), actor: copy(actor),
    type: required(details.type, 'decision type'), status: required(details.status, 'decision status'),
    question: details.question ?? null, options: copy(details.options ?? []), outcome: details.outcome ?? null,
    reason: required(details.reason, 'decision reason'), evidence: copy(details.evidence ?? []),
    artifacts: copy(details.artifacts ?? []), knownRisks: copy(details.knownRisks ?? []),
    unresolved: copy(details.unresolved ?? []), supersedes: details.supersedes ?? null,
    mode: run?.mode ?? details.mode ?? null, rule: copy(details.rule ?? null),
    packId: run?.packId ?? details.packId ?? null, packVersion: run?.packVersion ?? details.packVersion ?? null,
    graphId: run?.graph.id ?? null, graphVersion: run?.graph.version ?? null,
    runId: run?.id ?? null, nodeId: details.nodeId ?? null, feature: details.feature ?? null,
    projectId: details.projectId ?? run?.input?.projectId ?? null,
    taskId: details.taskId ?? run?.input?.taskId ?? null,
    issueId: details.issueId ?? run?.input?.paperclipIssueId ?? null,
    affectedRefs: copy(details.affectedRefs ?? []),
  };
  state.decisions.push(record);
  audit(state, 'decision.recorded', { decisionId: record.id, runId: run?.id ?? null, nodeId: record.nodeId }, now);
  return record;
}

function decisionRule(run, type, actor, evidence) {
  const rule = ruleFor(run, type);
  if (!rule) throw new Error(`No decision rule for ${type} in ${run.mode} mode`);
  if (rule.requiresHuman && actor.kind !== 'human') throw new Error('Human decision required');
  if (rule.allowedKinds && !contains(rule.allowedKinds, actor.kind)) throw new Error('Actor kind not allowed');
  if (rule.allowedRoles && !rule.allowedRoles.some((role) => hasRole(actor, role))) throw new Error('Decision role not allowed');
  for (const kind of rule.requiredEvidence ?? []) if (!evidence.some((item) => item.kind === kind)) throw new Error(`Missing required evidence: ${kind}`);
  return rule;
}

function assertEvidenceSubjects(evidence, requiredKinds, artifacts) {
  if (artifacts.length === 0) throw new Error('Current candidate artifact is missing');
  const refs = artifacts.map((item) => ({ artifactId: item.id, version: item.version }));
  for (const kind of requiredKinds ?? []) {
    const item = evidence.find((entry) => entry.kind === kind);
    if (!item) continue; // decisionRule reports the missing kind.
    for (const ref of refs) {
      if (!item.subjectRefs?.some((subject) => subject.artifactId === ref.artifactId && subject.version === ref.version)) {
        throw new Error(`Evidence ${kind} does not reference current candidate ${ref.artifactId}@${ref.version}`);
      }
    }
  }
}

function currentCandidates(run, node) {
  const artifacts = node.candidateNodes.flatMap((id) => {
    const ns = run.nodeStates[id];
    if (!ns || ns.status !== 'completed') throw new Error(`Candidate node ${id} is not completed`);
    return latestArtifacts(ns.artifacts ?? []);
  }).filter((artifact) => !node.candidateKinds || node.candidateKinds.includes(artifact.kind));
  for (const kind of node.candidateKinds ?? []) if (!artifacts.some((artifact) => artifact.kind === kind)) throw new Error(`Current candidate kind ${kind} is missing`);
  return artifacts;
}

function productMemoryFrom(state, feature) {
  const records = state.decisions.filter((item) => item.type === 'product' && item.feature === feature);
  const replaced = new Set(records.filter((item) => item.status === 'approved').map((item) => item.supersedes).filter(Boolean));
  return { feature, history: records, active: records.filter((item) => item.status === 'approved' && !replaced.has(item.id)) };
}

function assertProductContext(state, { feature, productDecisionRefs = [], changesBehavior = false, approvedChangeDecisionId, changeScope }) {
  if (typeof feature !== 'string' || !feature.trim()) throw new Error('Product feature is required');
  if (!Array.isArray(productDecisionRefs) || productDecisionRefs.some((id) => typeof id !== 'string' || !id)) throw new Error('Product decision references must be decision IDs');
  const memory = productMemoryFrom(state, feature);
  if (memory.active.length === 0) throw new Error(`Product context unresolved for ${feature}`);
  const activeIds = new Set(memory.active.map((item) => item.id));
  for (const id of productDecisionRefs) if (!activeIds.has(id)) throw new Error(`Product decision ${id} is not approved and active for ${feature}`);
  for (const item of memory.active) if (!productDecisionRefs.includes(item.id)) throw new Error(`Active product decision ${item.id} must be referenced`);
  if (changesBehavior) {
    const approved = memory.active.find((item) => item.id === approvedChangeDecisionId);
    if (!approved || !approved.supersedes || !changeScope || !approved.changeScope?.includes(changeScope)) {
      throw new Error('Behavior change requires an approved superseding decision for the requested scope');
    }
  }
  return memory;
}

export class GraphEngine {
  constructor({ store = new MemoryStore(), now = () => new Date().toISOString() } = {}) {
    this.store = store; this.now = now; this.queue = Promise.resolve();
  }
  async #read() { return (await this.store.read()) ?? { revision: 0, packs: {}, runs: {}, decisions: [], audit: [], idempotency: {} }; }
  async #change(key, fn, request = null) {
    const operation = this.queue.then(async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const state = await this.#read();
        const requestFingerprint = key ? fingerprint(request) : null;
        if (key && Object.hasOwn(state.idempotency, key)) {
          const saved = state.idempotency[key];
          // Accept old insertion-order fingerprints written before canonicalization.
          if (fingerprint(JSON.parse(saved.fingerprint)) !== requestFingerprint) throw new Error('Idempotency key reused with different request or actor');
          return copy(saved.result);
        }
        const result = fn(state);
        if (key) state.idempotency[key] = { fingerprint: requestFingerprint, result: copy(result) };
        const revision = state.revision;
        state.revision++;
        try { await this.store.write(state, revision); return copy(result); }
        catch (error) {
          if (!(error instanceof RevisionConflict) && error.name !== 'RevisionConflict') throw error;
          if (attempt === 7) throw error;
        }
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async registerPack(pack) {
    validatePack(pack);
    return this.#change(null, (state) => {
      const key = keyOf(pack.id, pack.version);
      const value = fingerprint(pack);
      if (state.packs[key] && fingerprint(state.packs[key]) !== value) throw new Error('Published pack version is immutable');
      state.packs[key] = copy(pack);
      audit(state, 'pack.registered', { packId: pack.id, packVersion: pack.version }, this.now);
      return { id: pack.id, version: pack.version };
    });
  }
  async startRun({ packId, packVersion, graphId, input = {}, actor, mode = 'manual', idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `start:${idempotencyKey}`, (state) => {
      const pack = state.packs[keyOf(packId, packVersion)];
      if (!pack) throw new Error('Pack version not registered');
      const graph = pack.graphs.find((item) => item.id === graphId);
      if (!graph) throw new Error('Graph not found in pinned pack version');
      if (graph.nodes.some((node) => node.requiredInputs?.includes('product_decision_refs'))) {
        if (typeof input.feature !== 'string' || !input.feature.trim()) throw new Error('Product feature is required for product_decision_refs');
        if (input.productDecisionRefs && fingerprint(input.productDecisionRefs) !== fingerprint(input.product_decision_refs)) {
          throw new Error('Product decision reference aliases disagree');
        }
        assertProductContext(state, { feature: input.feature, productDecisionRefs: input.product_decision_refs });
      }
      const run = {
        id: randomUUID(), status: 'running', packId, packVersion, graph: copy(graph), pack: copy(pack), mode,
        input: copy(input), startedBy: identity, startedAt: this.now(), updatedAt: this.now(),
        nodeStates: Object.fromEntries(graph.nodes.map((node) => [node.id, { status: 'pending', attempts: [] }])),
        conflicts: [],
      };
      const missing = missingInputs(run, graph.nodes.find((node) => node.id === graph.start), new Set([graph.start]));
      if (missing.length) throw new Error(`Start node missing required inputs: ${missing.join('; ')}`);
      state.runs[run.id] = run;
      audit(state, 'run.started', { runId: run.id, packId, packVersion, graphId, graphVersion: graph.version, actor: identity }, this.now);
      return run;
    }, { packId, packVersion, graphId, input, actor: identity, mode });
  }
  async getRun(runId) { const state = await this.#read(); return copy(state.runs[runId] ?? null); }
  async getReadyNodes(runId) { const run = await this.getRun(runId); if (!run) throw new Error('Run not found'); return readyNodes(run); }
  async getWorkItems(runId) { const run = await this.getRun(runId); if (!run) throw new Error('Run not found'); return workItems(run); }
  async getBlockedNodes(runId) {
    const run = await this.getRun(runId); if (!run) throw new Error('Run not found');
    return structurallyReadyNodes(run)
      .map(({ node, active }) => ({ ...copy(node), status: 'blocked', missingInputs: missingInputs(run, node, active) }))
      .filter((node) => node.missingInputs.length > 0);
  }
  async listDecisions({ runId, feature } = {}) {
    const state = await this.#read(); return copy(state.decisions.filter((d) => (!runId || d.runId === runId) && (!feature || d.feature === feature)));
  }
  async getAudit({ runId } = {}) { const state = await this.#read(); return copy(state.audit.filter((event) => !runId || event.runId === runId)); }
  async recordDecision({ type, status, outcome = null, reason, actor, question = null, options = [], evidence = [], artifacts = [], knownRisks = [], unresolved = [], supersedes = null, runId = null, nodeId = null, projectId = null, taskId = null, issueId = null, affectedRefs = [], idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `decision:${idempotencyKey}`, (state) => {
      const run = runId ? state.runs[runId] : null;
      if (runId && !run) throw new Error('Run not found');
      return decisionRecord(state, run, identity, { type, status, outcome, reason, question, options, evidence, artifacts, knownRisks, unresolved, supersedes, nodeId, projectId, taskId, issueId, affectedRefs }, this.now);
    }, { type, status, outcome, reason, actor: identity, question, options, evidence, artifacts, knownRisks, unresolved, supersedes, runId, nodeId, projectId, taskId, issueId, affectedRefs });
  }

  #node(state, runId, nodeId, actor) {
    const run = state.runs[runId]; if (!run) throw new Error('Run not found');
    if (run.status !== 'running') throw new Error(`Run is ${run.status}`);
    const node = run.graph.nodes.find((item) => item.id === nodeId); if (!node) throw new Error('Node not found');
    if (!readyNodes(run).some((item) => item.id === nodeId)) throw new Error('Node is not ready');
    assertRole(actor, node.role); assertAgentExecution(actor);
    for (const ref of node.independentOf ?? []) {
      for (const prior of run.nodeStates[ref].attempts) {
        if ((actor.executionId && prior.actor?.executionId === actor.executionId) ||
          ((!actor.executionId || !prior.actor?.executionId) && prior.actor?.id === actor.id)) throw new Error('Independent review cannot use the producing execution');
      }
    }
    return { run, node, nodeState: run.nodeStates[nodeId] };
  }
  #finish(state, run, nodeId, now) {
    run.nodeStates[nodeId].status = 'completed'; run.updatedAt = now();
    audit(state, 'node.completed', { runId: run.id, nodeId }, now);
    const { active } = activeNodes(run);
    const live = [...active].filter((id) => run.nodeStates[id].status !== 'completed');
    if (live.length === 0) {
      const terminal = run.graph.nodes.find((item) => item.id === nodeId);
      run.status = terminal?.output === 'human_decision_pending' ? 'paused'
        : terminal?.output === 'rework_required' ? 'rework_required' : 'completed';
      audit(state, `run.${run.status}`, { runId: run.id }, now);
    }
  }
  #rework(state, run, fromNodeId, targetNodeId, decisionId) {
    const ids = new Set([targetNodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of run.graph.edges) if (ids.has(edge.from) && !ids.has(edge.to)) { ids.add(edge.to); changed = true; }
    }
    if (!ids.has(fromNodeId)) throw new Error('Rework target must be upstream of review gate');
    for (const id of ids) {
      const ns = run.nodeStates[id];
      ns.status = 'pending'; ns.invalidatedAt = this.now();
      delete ns.output; delete ns.outcome; delete ns.artifacts; delete ns.evidence;
    }
    run.status = 'running'; run.updatedAt = this.now();
    audit(state, 'rework.started', { runId: run.id, fromNodeId, targetNodeId, invalidatedNodeIds: [...ids], decisionId }, this.now);
  }
  async submitNode({ runId, nodeId, actor, output = {}, artifacts = [], evidence = [], productDecisionRefs, approvedChangeDecisionId, changeScope, idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `node:${runId}:${nodeId}:${idempotencyKey}`, (state) => {
      const { run, node, nodeState } = this.#node(state, runId, nodeId, identity);
      if (node.type === 'decision') throw new Error('Use decideNode for decisions');
      if (node.type === 'task' && run.input?.feature) {
        assertProductContext(state, { feature: run.input.feature, productDecisionRefs: productDecisionRefs ?? run.input.product_decision_refs ?? run.input.productDecisionRefs,
          changesBehavior: run.input.changesBehavior, approvedChangeDecisionId: approvedChangeDecisionId ?? run.input.approvedChangeDecisionId,
          changeScope: changeScope ?? run.input.changeScope });
      }
      if (node.type === 'join' && node.mode !== 'all') throw new Error('Invalid join');
      for (const artifact of artifacts) { required(artifact.id, 'artifact.id'); required(artifact.version, 'artifact.version'); }
      for (const kind of node.produces ?? []) if (!artifacts.some((artifact) => artifact.kind === kind)) throw new Error(`Missing versioned output artifact kind: ${kind}`);
      const attempt = { at: this.now(), actor: identity, output: copy(output), artifacts: copy(artifacts), evidence: copy(evidence), selfReviews: [], supervisorReview: null };
      nodeState.attempts.push(attempt);
      nodeState.output = copy(output); nodeState.artifacts = copy(artifacts); nodeState.evidence = copy(evidence);
      if (node.review) {
        if (artifacts.length === 0) throw new Error('Reviewed work requires a versioned artifact');
        for (const artifact of artifacts) required(artifact.version, 'artifact.version');
        nodeState.status = 'awaiting_self_review';
        audit(state, 'work.submitted', { runId, nodeId, actor: identity, artifacts }, this.now);
      } else this.#finish(state, run, nodeId, this.now);
      return copy(nodeState);
    }, { runId, nodeId, actor: identity, output, artifacts, evidence, productDecisionRefs, approvedChangeDecisionId, changeScope });
  }
  async recordSelfReview({ runId, nodeId, actor, findings = [], fixes = [], artifactVersion, revisedArtifact = null, evidence = [], idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `self:${runId}:${nodeId}:${idempotencyKey}`, (state) => {
      const run = state.runs[runId], node = run?.graph.nodes.find((item) => item.id === nodeId), ns = run?.nodeStates[nodeId];
      if (!node?.review || ns.status !== 'awaiting_self_review') throw new Error('Work is not awaiting self review');
      if (run.status !== 'running') throw new Error(`Run is ${run.status}`);
      const attempt = ns.attempts.at(-1);
      if (attempt.actor.id !== identity.id || attempt.actor.executionId !== identity.executionId) throw new Error('Self review must use the producing execution');
      const previous = attempt.selfReviews.at(-1);
      const priorSevere = previous?.findings.some((item) => ['P0', 'P1'].includes(item.severity) && item.status !== 'resolved');
      if (revisedArtifact) {
        required(revisedArtifact.id, 'revisedArtifact.id'); required(revisedArtifact.version, 'revisedArtifact.version');
        if (attempt.artifacts.some((item) => item.id === revisedArtifact.id && item.version === revisedArtifact.version)) throw new Error('Revised artifact needs a new version');
        if (!revisedArtifact.kind) revisedArtifact = { ...revisedArtifact, kind: attempt.artifacts.find((item) => item.id === revisedArtifact.id)?.kind };
        attempt.artifacts.push(copy(revisedArtifact));
        ns.artifacts = copy(latestArtifacts(attempt.artifacts));
      }
      if (attempt.artifacts.at(-1).version !== artifactVersion) throw new Error('Self review must reference the current artifact version');
      const round = attempt.selfReviews.length + 1, max = node.review.maxSelfReviews ?? 5;
      if (round > max) throw new Error('Self review round limit reached');
      const severe = findings.some((item) => ['P0', 'P1'].includes(item.severity) && item.status !== 'resolved');
      if (priorSevere && !severe && !revisedArtifact) throw new Error('Clearing prior P0/P1 requires a revised artifact version');
      const review = { round, at: this.now(), actor: identity, artifactVersion, findings: copy(findings), fixes: copy(fixes), evidence: copy(evidence) };
      attempt.selfReviews.push(review);
      if (!severe || round === max) ns.status = 'awaiting_supervisor_review';
      audit(state, 'self_review.recorded', { runId, nodeId, round, severe, exhausted: round === max }, this.now);
      return copy(ns);
    }, { runId, nodeId, actor: identity, findings, fixes, artifactVersion, revisedArtifact, evidence });
  }
  async reviewWork({ runId, nodeId, actor, outcome, reason, evidence = [], knownRisks = [], idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `review:${runId}:${nodeId}:${idempotencyKey}`, (state) => {
      const run = state.runs[runId], node = run?.graph.nodes.find((item) => item.id === nodeId), ns = run?.nodeStates[nodeId];
      if (!node?.review || ns.status !== 'awaiting_supervisor_review') throw new Error('Work is not awaiting supervisor review');
      if (run.status !== 'running') throw new Error(`Run is ${run.status}`);
      if (!['accept', 'rework'].includes(outcome)) throw new Error('Invalid review outcome');
      assertRole(identity, node.review.supervisorRole); assertAgentExecution(identity);
      const attempt = ns.attempts.at(-1);
      if ((identity.executionId && attempt.actor.executionId === identity.executionId) ||
        ((!identity.executionId || !attempt.actor.executionId) && attempt.actor.id === identity.id)) throw new Error('Supervisor must be independent of producer');
      const rule = decisionRule(run, node.review.decisionType ?? 'review', identity, evidence);
      if (rule.requiredEvidence?.length) assertEvidenceSubjects(evidence, rule.requiredEvidence, latestArtifacts(attempt.artifacts));
      const record = decisionRecord(state, run, identity, { type: node.review.decisionType ?? 'review', status: outcome, outcome, reason, evidence, artifacts: latestArtifacts(attempt.artifacts), knownRisks, nodeId, rule }, this.now);
      attempt.supervisorReview = { decisionId: record.id, outcome, actor: identity };
      if (outcome === 'accept') {
        const last = attempt.selfReviews.at(-1);
        const severe = last.findings.some((item) => ['P0', 'P1'].includes(item.severity) && item.status !== 'resolved');
        if (severe && (knownRisks.length === 0 || rule.allowUnresolvedSevere !== true)) throw new Error('Accepting unresolved P0/P1 requires explicit authority and known risk handling');
        this.#finish(state, run, nodeId, this.now);
      } else {
        ns.status = 'pending';
        audit(state, 'work.rework_requested', { runId, nodeId, decisionId: record.id, reason }, this.now);
      }
      return { node: copy(ns), decision: copy(record) };
    }, { runId, nodeId, actor: identity, outcome, reason, evidence, knownRisks });
  }
  async decideNode({ runId, nodeId, actor, outcome, reason, evidence = [], artifacts = [], options = [], idempotencyKey }) {
    if (outcome === 'human') return this.escalateNode({ runId, nodeId, actor, reason, evidence, options, idempotencyKey });
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `decide:${runId}:${nodeId}:${idempotencyKey}`, (state) => {
      const { run, node, nodeState } = this.#node(state, runId, nodeId, identity);
      if (node.type !== 'decision') throw new Error('Node is not a decision');
      const rule = decisionRule(run, node.decisionType ?? nodeId, identity, evidence);
      if (node.candidateNodes?.length) {
        const candidates = currentCandidates(run, node);
        assertEvidenceSubjects(evidence, rule.requiredEvidence, candidates);
      }
      const outgoing = run.graph.edges.filter((edge) => edge.from === nodeId);
      const isRework = node.reworkTarget && outcome === (node.reworkOutcome ?? 'rework');
      if (!isRework && !outgoing.some((edge) => selected(edge, { outcome }))) throw new Error('Decision outcome has no route');
      const record = decisionRecord(state, run, identity, { type: node.decisionType ?? nodeId, status: 'decided', outcome, reason, evidence, artifacts, options, nodeId, rule }, this.now);
      nodeState.attempts.push({ at: this.now(), actor: identity, outcome, decisionId: record.id, artifacts: copy(artifacts), evidence: copy(evidence) });
      nodeState.outcome = outcome;
      if (isRework) {
        nodeState.reworkCount = (nodeState.reworkCount ?? 0) + 1;
        if (nodeState.reworkCount > (node.maxReworks ?? 3)) {
          run.status = 'paused';
          run.pendingHuman = { kind: 'rework_limit', nodeId, targetNodeId: node.reworkTarget, decisionId: record.id };
          audit(state, 'rework.waiting_human', { runId, nodeId, decisionId: record.id }, this.now);
        } else this.#rework(state, run, nodeId, node.reworkTarget, record.id);
      } else this.#finish(state, run, nodeId, this.now);
      return { node: copy(nodeState), decision: copy(record) };
    }, { runId, nodeId, actor: identity, outcome, reason, evidence, artifacts, options });
  }
  async escalateNode({ runId, nodeId, actor, reason, evidence = [], options = [], idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `escalate:${runId}:${nodeId}:${idempotencyKey}`, (state) => {
      const { run, node } = this.#node(state, runId, nodeId, identity);
      if (node.type !== 'decision') throw new Error('Only a decision node can escalate');
      const record = decisionRecord(state, run, identity, { type: node.decisionType ?? nodeId, status: 'escalated', reason, evidence, options, nodeId }, this.now);
      run.pendingHuman = { kind: 'decision', nodeId, escalationDecisionId: record.id };
      run.status = 'paused'; run.updatedAt = this.now();
      audit(state, 'decision.waiting_human', { runId, nodeId, decisionId: record.id }, this.now);
      return { run: copy(run), decision: copy(record) };
    }, { runId, nodeId, actor: identity, reason, evidence, options });
  }
  async resolveHumanGate({ runId, nodeId, actor, outcome, reason, evidence = [], artifacts = [], options = [], idempotencyKey }) {
    const identity = trustedActor(actor);
    if (identity.kind !== 'human' || !identity.roles.includes('human-owner')) throw new Error('Human owner decision required');
    return this.#change(idempotencyKey && `human-gate:${runId}:${nodeId}:${idempotencyKey}`, (state) => {
      const run = state.runs[runId], pending = run?.pendingHuman;
      if (run?.status !== 'paused' || pending?.kind !== 'decision' || pending.nodeId !== nodeId) throw new Error('Decision is not waiting for human');
      const node = run.graph.nodes.find((item) => item.id === nodeId), ns = run.nodeStates[nodeId];
      const rule = ruleFor(run, node.decisionType ?? nodeId);
      if (!rule) throw new Error('Decision rule missing');
      for (const kind of rule.requiredEvidence ?? []) if (!evidence.some((item) => item.kind === kind)) throw new Error(`Missing required evidence: ${kind}`);
      if (node.candidateNodes?.length) {
        const candidates = currentCandidates(run, node);
        assertEvidenceSubjects(evidence, rule.requiredEvidence, candidates);
      }
      const isRework = node.reworkTarget && outcome === (node.reworkOutcome ?? 'rework');
      if (!isRework && !run.graph.edges.some((edge) => edge.from === nodeId && selected(edge, { outcome }))) throw new Error('Decision outcome has no route');
      const record = decisionRecord(state, run, identity, { type: node.decisionType ?? nodeId, status: 'decided', outcome, reason, evidence, artifacts, options, nodeId, rule: { ...rule, humanEscalation: true }, supersedes: pending.escalationDecisionId }, this.now);
      ns.attempts.push({ at: this.now(), actor: identity, outcome, decisionId: record.id, artifacts: copy(artifacts), evidence: copy(evidence) });
      ns.outcome = outcome; delete run.pendingHuman; run.status = 'running';
      if (isRework) {
        ns.reworkCount = (ns.reworkCount ?? 0) + 1;
        if (ns.reworkCount > (node.maxReworks ?? 3)) {
          run.status = 'paused'; run.pendingHuman = { kind: 'rework_limit', nodeId, targetNodeId: node.reworkTarget, decisionId: record.id };
          audit(state, 'rework.waiting_human', { runId, nodeId, decisionId: record.id }, this.now);
        } else this.#rework(state, run, nodeId, node.reworkTarget, record.id);
      } else this.#finish(state, run, nodeId, this.now);
      return { run: copy(run), decision: copy(record) };
    }, { runId, nodeId, actor: identity, outcome, reason, evidence, artifacts, options });
  }
  async pauseRun({ runId, actor, reason, idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `pause:${runId}:${idempotencyKey}`, (state) => {
      const run = state.runs[runId]; if (!run || run.status !== 'running') throw new Error('Run is not running');
      run.status = 'paused'; run.updatedAt = this.now();
      const record = decisionRecord(state, run, identity, { type: 'run-control', status: 'paused', reason: required(reason, 'reason') }, this.now);
      audit(state, 'run.paused', { runId, actor: identity, reason, decisionId: record.id }, this.now);
      return run;
    }, { runId, actor: identity, reason });
  }
  async resumeRun({ runId, actor, reason, idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `resume:${runId}:${idempotencyKey}`, (state) => {
      const run = state.runs[runId]; if (!run || run.status !== 'paused') throw new Error('Run is not paused');
      if (run.conflicts.some((item) => item.status === 'waiting_human')) throw new Error('Unresolved conflict requires human decision');
      if (run.pendingHuman) throw new Error('Pending human decision must be resolved');
      run.status = 'running'; run.updatedAt = this.now();
      const record = decisionRecord(state, run, identity, { type: 'run-control', status: 'resumed', reason: required(reason, 'reason') }, this.now);
      audit(state, 'run.resumed', { runId, actor: identity, reason, decisionId: record.id }, this.now);
      return run;
    }, { runId, actor: identity, reason });
  }
  async resolveReworkLimit({ runId, actor, outcome, reason, idempotencyKey }) {
    const identity = trustedActor(actor);
    if (identity.kind !== 'human' || !identity.roles.includes('human-owner')) throw new Error('Rework limit requires a human owner');
    return this.#change(idempotencyKey && `rework-limit:${runId}:${idempotencyKey}`, (state) => {
      const run = state.runs[runId], pending = run?.pendingHuman;
      if (pending?.kind !== 'rework_limit' || run.status !== 'paused') throw new Error('No rework limit awaiting human');
      if (!['continue', 'stop'].includes(outcome)) throw new Error('Invalid rework limit outcome');
      const record = decisionRecord(state, run, identity, { type: 'rework_limit', status: 'decided', outcome, reason, nodeId: pending.nodeId, supersedes: pending.decisionId }, this.now);
      delete run.pendingHuman;
      if (outcome === 'continue') this.#rework(state, run, pending.nodeId, pending.targetNodeId, record.id);
      else { run.status = 'stopped'; audit(state, 'run.stopped', { runId, decisionId: record.id }, this.now); }
      return { run: copy(run), decision: copy(record) };
    }, { runId, actor: identity, outcome, reason });
  }
  async openConflict({ runId, nodeId, actor, positions, options = [], unresolved, reason, idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `conflict:${runId}:${idempotencyKey}`, (state) => {
      const run = state.runs[runId]; if (!run || run.status !== 'running') throw new Error('Run is not running');
      if (!positions?.cpo || !positions?.cto || !Array.isArray(unresolved) || unresolved.length === 0) throw new Error('CPO and CTO positions and unresolved issues required');
      const conflict = { id: randomUUID(), at: this.now(), nodeId: nodeId ?? null, openedBy: identity, positions: copy(positions), options: copy(options), unresolved: copy(unresolved), status: 'waiting_human' };
      run.conflicts.push(conflict); run.status = 'paused';
      const record = decisionRecord(state, run, identity, { type: 'cpo_cto_conflict', status: 'escalated', reason, options, unresolved, nodeId }, this.now);
      conflict.escalationDecisionId = record.id;
      audit(state, 'conflict.waiting_human', { runId, conflictId: conflict.id, decisionId: record.id }, this.now);
      return copy(conflict);
    }, { runId, nodeId, actor: identity, positions, options, unresolved, reason });
  }
  async resolveConflict({ runId, conflictId, actor, outcome, reason, evidence = [], idempotencyKey }) {
    const identity = trustedActor(actor);
    if (identity.kind !== 'human' || !identity.roles.includes('human-owner')) throw new Error('CPO/CTO unresolved conflict requires a human owner');
    return this.#change(idempotencyKey && `resolve:${runId}:${conflictId}:${idempotencyKey}`, (state) => {
      const run = state.runs[runId], conflict = run?.conflicts.find((item) => item.id === conflictId);
      if (!conflict || conflict.status !== 'waiting_human') throw new Error('Conflict is not waiting for human');
      const record = decisionRecord(state, run, identity, { type: 'cpo_cto_conflict', status: 'decided', outcome, reason, evidence, options: conflict.options, unresolved: conflict.unresolved, nodeId: conflict.nodeId, supersedes: conflict.escalationDecisionId }, this.now);
      conflict.status = 'resolved'; conflict.resolutionDecisionId = record.id; conflict.outcome = outcome;
      if (!run.conflicts.some((item) => item.status === 'waiting_human')) run.status = 'running';
      run.updatedAt = this.now();
      audit(state, 'conflict.resolved', { runId, conflictId, decisionId: record.id }, this.now);
      return { conflict: copy(conflict), decision: copy(record) };
    }, { runId, conflictId, actor: identity, outcome, reason, evidence });
  }
  async recordProductDecision({ feature, actor, status = 'approved', outcome, reason, evidence = [], supersedes = null, changeScope = [], runId = null, idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `product:${idempotencyKey}`, (state) => {
      const run = runId ? state.runs[runId] : null;
      if (runId && !run) throw new Error('Run not found');
      if (!['approved', 'rejected', 'proposed', 'deferred'].includes(status)) throw new Error('Invalid product decision status');
      if (!Array.isArray(changeScope) || changeScope.some((item) => typeof item !== 'string' || !item)) throw new Error('Invalid product decision change scope');
      if (!run && status === 'approved' && identity.kind !== 'human') throw new Error('Agent product approval requires a run decision policy');
      if (supersedes) {
        const old = state.decisions.find((item) => item.id === supersedes);
        if (!old || old.type !== 'product' || old.feature !== feature || old.status !== 'approved') throw new Error('Superseded approved product decision not found for feature');
        if (status === 'approved' && !productMemoryFrom(state, feature).active.some((item) => item.id === supersedes)) throw new Error('Only an active product decision can be superseded');
      }
      const rule = run ? decisionRule(run, 'product-decision-replacement', identity, evidence) : null;
      const record = decisionRecord(state, run, identity, { type: 'product', status, outcome, reason, evidence, supersedes, feature: required(feature, 'feature'), rule }, this.now);
      record.changeScope = copy(changeScope);
      return record;
    }, { feature, actor: identity, status, outcome, reason, evidence, supersedes, changeScope, runId });
  }
  async getProductMemory(feature) {
    const state = await this.#read(); return copy(productMemoryFrom(state, feature));
  }
  async assertProductChangeAllowed({ feature, referencedDecisionIds = [], approvedDecisionId, changesBehavior = false, changeScope }) {
    const state = await this.#read();
    return copy(assertProductContext(state, { feature, productDecisionRefs: referencedDecisionIds, approvedChangeDecisionId: approvedDecisionId, changesBehavior, changeScope }));
  }
  async invalidateEvidence({ runId, nodeId, actor, reason, affectedNodeIds, idempotencyKey }) {
    const identity = trustedActor(actor);
    return this.#change(idempotencyKey && `invalidate:${runId}:${idempotencyKey}`, (state) => {
      const run = state.runs[runId]; if (!run) throw new Error('Run not found');
      if (!run.nodeStates[nodeId]) throw new Error('Node not found');
      // Conservative MVP policy: every downstream report or acceptance is stale.
      const ids = affectedNodes(run, affectedNodeIds ?? [nodeId]);
      for (const id of ids) {
        const ns = run.nodeStates[id]; if (!ns) throw new Error(`Unknown affected node: ${id}`);
        ns.status = 'pending'; ns.invalidatedAt = this.now();
        delete ns.output; delete ns.outcome; delete ns.artifacts; delete ns.evidence;
      }
      if (run.status !== 'paused' && run.status !== 'stopped') run.status = 'running';
      run.updatedAt = this.now();
      const record = decisionRecord(state, run, identity, { type: 'evidence_invalidation', status: 'rework', reason, nodeId, artifacts: [], unresolved: [...ids] }, this.now);
      audit(state, 'evidence.invalidated', { runId, nodeId, affectedNodeIds: [...ids], decisionId: record.id }, this.now);
      return { run: copy(run), decision: copy(record) };
    }, { runId, nodeId, actor: identity, reason, affectedNodeIds });
  }

  async retryNode({ runId, nodeId, actor, reason, idempotencyKey }) {
    const identity = trustedActor(actor);
    if (identity.kind !== 'human' || !identity.roles.includes('human-owner')) throw new Error('Node retry requires a human owner');
    return this.#change(idempotencyKey && `retry:${runId}:${nodeId}:${idempotencyKey}`, (state) => {
      const run = state.runs[runId];
      if (!run || run.status !== 'running' || run.pendingHuman || run.conflicts.some((item) => item.status === 'waiting_human')) {
        throw new Error('Node retry requires a running run without unresolved human decisions');
      }
      const node = run.graph.nodes.find((item) => item.id === nodeId);
      if (!node || !['task', 'decision'].includes(node.type)) throw new Error('Only task or decision nodes can be retried');
      const ns = run.nodeStates[nodeId];
      const previousStatus = ns.status;
      const rationale = required(reason, 'reason');
      const at = this.now();
      if (previousStatus === 'pending') {
        // A failed dispatch with no callback has no attempt yet. Reserve its number so
        // the host creates a new issue and wakeup key instead of reusing the dead one.
        ns.attempts.push({ at, actor: null, status: 'abandoned_before_submission', retryRequestedBy: identity, reason: rationale });
      } else if (ns.attempts.length) {
        ns.attempts.at(-1).supersededByRetry = { at, actor: identity, reason: rationale };
      }
      const ids = affectedNodes(run, [nodeId]);
      for (const id of ids) {
        const affected = run.nodeStates[id];
        affected.status = 'pending'; affected.invalidatedAt = at;
        delete affected.output; delete affected.outcome; delete affected.artifacts; delete affected.evidence;
      }
      run.updatedAt = at;
      const record = decisionRecord(state, run, identity, { type: 'node_retry', status: 'approved', outcome: 'retry', reason: rationale,
        nodeId, unresolved: [...ids], affectedRefs: [{ kind: 'graph_node_attempt', nodeId, nextAttempt: ns.attempts.length + 1 }] }, this.now);
      audit(state, 'node.retry_requested', { runId, nodeId, previousStatus, nextAttempt: ns.attempts.length + 1,
        invalidatedNodeIds: [...ids], decisionId: record.id }, this.now);
      return { run: copy(run), decision: copy(record), nextAttempt: ns.attempts.length + 1 };
    }, { runId, nodeId, actor: identity, reason });
  }
}
