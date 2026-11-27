import { createHash } from 'node:crypto';
import { canonical } from '../core/canonical.mjs';
import { bindCandidateArtifact, currentCandidates } from '../core/engine.mjs';
import { mergeProducers } from './trusted-pack-adapters.mjs';
import { PaperclipStore, advanceMergeDiscovery, markMergeDiscoveryAttempt, pendingMergeDiscovery,
  rejectSupersededMergeRequests, revokeUntrustedMergeRequests, saveMergeRequest } from './store.mjs';

const sameRef = (binding, ref) => Boolean(binding && binding.artifactId === ref?.id && binding.version === ref?.revisionId);
const repositoryName = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) ? value.toLowerCase() : null;

function normalizedPins(pins) {
  if (!Array.isArray(pins) || !pins.length || pins.some(pin =>
    typeof pin?.contractId !== 'string' || !pin.contractId.trim() ||
    !['product', 'design', 'technical'].includes(pin.section) ||
    typeof pin.commit !== 'string' || !/^[a-f0-9]{40}$/.test(pin.commit))) return null;
  const keys = new Set(pins.map(({ contractId, section }) => canonical([contractId, section])));
  if (keys.size !== pins.length) return null;
  return pins.map(({ contractId, section, commit }) => canonical([contractId, section, commit])).sort();
}

function checkAdmission({ run, row, descriptor, payload, decisions, project, companyId, repository }) {
  if (!descriptor || descriptor.packId !== run.packId || descriptor.packVersion !== run.packVersion ||
      !run.pack.graphs.some(graph => graph.id === run.graph.id && graph.version === run.graph.version &&
        canonical(graph) === canonical(run.graph))) return 'untrusted-pack-snapshot';
  if (!payload) return 'missing-validated-request';
  if (!repository || run.input.paperclipCompanyId !== companyId ||
      (project.id !== undefined && project.id !== run.input.projectId) ||
      (payload.projectId !== undefined && payload.projectId !== run.input.projectId)) return 'project-binding-mismatch';
  const pin = run.input.pr_head;
  if (payload.runId !== run.id || payload.section !== row.section || !Number.isSafeInteger(payload.pullNumber) ||
      payload.pullNumber < 1 || (payload.repository !== undefined && repositoryName(payload.repository) !== repository) ||
      (!row.section && (repositoryName(pin?.repository) !== repository || payload.pullNumber !== pin.pullNumber ||
        payload.headSha !== pin.headSha || repositoryName(payload.repository) !== repository))) return 'request-scope-mismatch';

  const gate = run.nodeStates[row.gateNodeId];
  const decision = decisions.get(gate?.attempts.at(-1)?.decisionId);
  const outcome = row.section === 'design' ? 'approve' : 'accept';
  if (gate?.status !== 'completed' || gate.outcome !== outcome || decision?.status !== 'decided' ||
      decision.outcome !== outcome || decision.id !== payload.decisionId || decision.nodeId !== row.gateNodeId ||
      decision.runId !== run.id || decision.projectId !== run.input.projectId || !decision.candidateBinding) {
    return 'missing-current-approval';
  }
  const node = run.graph.nodes.find(node => node.id === row.gateNodeId);
  let candidates;
  try {
    candidates = currentCandidates(run, node).map(ref => bindCandidateArtifact(run, ref, descriptor.candidatePayload));
  } catch {
    return 'candidate-binding-mismatch';
  }
  const { candidateBinding } = decision;
  const manifest = candidates.find(ref => ref?.kind === row.candidateKind && sameRef(ref, payload.manifest));
  if (!manifest || candidates.some(ref => !ref) || canonical(candidates) !== canonical(candidateBinding.candidates)) {
    return 'candidate-binding-mismatch';
  }
  if (row.auditKind) {
    const audit = run.nodeStates[row.auditNodeId];
    const ref = audit?.status === 'completed' && audit.artifacts.findLast(item => item.kind === row.auditKind);
    const binding = ref && bindCandidateArtifact(run, { ...ref, nodeId: row.auditNodeId }, descriptor.candidatePayload);
    if (!sameRef(binding, payload.audit) || canonical(binding) !== canonical(candidateBinding.audit)) return 'audit-binding-mismatch';
  }
  const firstPublication = row.section === 'product' && JSON.parse(Buffer.from(manifest.bytes, 'base64')).supersedes === null;
  if (firstPublication && (payload.contract_pins?.length ?? 0) !== 0) return 'first-publication-has-pins';
  if ((row.section === 'product' && !firstPublication) ||
      ['technical_publication_request', 'implementation_merge_request'].includes(row.kind)) {
    const pins = normalizedPins(payload.contract_pins);
    if (!pins || canonical(pins) !== canonical(normalizedPins(run.input.contract_pins))) return 'contract-pins-mismatch';
  }
  return null;
}

async function hasUntrustedBinding({ companyId, run, runs, resolution, resolveAdapter, runtimeBindingError }) {
  const ancestors = new Set();
  for (;;) {
    if (ancestors.has(run.id) || await runtimeBindingError(companyId, run, resolution)) return true;
    if (!run.parentWorkflow) return false;
    ancestors.add(run.id);
    const parent = Object.hasOwn(runs, run.parentWorkflow.runId) && runs[run.parentWorkflow.runId];
    if (!parent || parent.input?.paperclipCompanyId !== companyId ||
        run.input?.paperclipCompanyId !== companyId || parent.input?.paperclipIssueId !== run.input?.paperclipIssueId) return true;
    run = parent;
    resolution = resolveAdapter(parent.pack);
  }
}

function redactedMessage(error) {
  if (typeof error?.message !== 'string') return null;
  return error.message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[^\s,)"'<>]+/gi, '$1 [redacted]')
    .replace(/\b((?:[\w-]*token|api[ _-]?key|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"'<>]+)/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
    .slice(0, 200);
}

async function discoverRun({ host, companyId, revision, run, runs, projects, decisions, resolveAdapter, runtimeBindingError }) {
  let operation = 'runtime-binding';
  try {
    const producers = mergeProducers.filter(row => row.packId === run.packId &&
      row.graphId === run.graph.id && row.versions.includes(run.graph.version));
    if (!producers.length) return true;
    const resolution = resolveAdapter(run.pack);
    const untrusted = await hasUntrustedBinding({ companyId, run, runs, resolution, resolveAdapter, runtimeBindingError });
    const descriptor = resolution?.descriptor;
    for (const row of producers) {
      const { nodeId, kind } = row;
      const node = run.nodeStates[nodeId];
      const currentAttempt = node?.status === 'completed' ? node.attempts.length : null;
      const scope = { runId: run.id, nodeId, kind };
      operation = 'runtime-binding';
      if (untrusted) await revokeUntrustedMergeRequests(host.db, companyId, revision, scope);
      operation = 'supersede';
      await rejectSupersededMergeRequests(host.db, companyId, revision, { ...scope, currentAttempt });
      if (!currentAttempt) continue;
      operation = 'candidate-payload';
      const artifactRef = node.attempts.at(-1).artifacts?.findLast(ref => ref.kind === kind) ?? null;
      const payload = artifactRef ? descriptor?.candidatePayload(run, { ...artifactRef, nodeId }) ?? null : null;
      const projectId = run.input.projectId;
      const project = typeof projectId === 'string' && projectId && Object.hasOwn(projects, projectId) ? projects[projectId] : null;
      const repository = repositoryName(project?.repository);
      const reason = untrusted ? 'untrusted-runtime-binding' :
        checkAdmission({ run, row, descriptor, payload, decisions, project, companyId, repository });
      const request = { kind, payload, artifactRef, projectId: projectId ?? null, repository };
      operation = 'save-request';
      await saveMergeRequest(host.db, companyId, revision, {
        ...scope, attemptIndex: currentAttempt,
        fingerprint: payload ? createHash('sha256').update(canonical(request)).digest('hex') : null,
        request, disposition: reason ? 'rejected-admission' : 'admitted', reason,
      });
    }
    return true;
  } catch (error) {
    host.logger.warn('ADLC merge discovery failed while scanning run', {
      companyId, runId: run?.id ?? null, operation, error: redactedMessage(error),
    });
    return false;
  }
}

export async function discoverAdlcMerges({ host, resolveAdapter, runtimeBindingError, limit = 20 }) {
  const { db } = host;
  for (const { companyId, lastRevision } of await pendingMergeDiscovery(db, limit)) {
    try {
      const snapshot = await new PaperclipStore(db, companyId).read();
      if (!snapshot || snapshot.revision <= Number(lastRevision)) continue;
      const projects = (await host.config?.get(companyId))?.adlcProjects ?? {};
      const decisions = new Map(snapshot.decisions.map(decision => [decision.id, decision]));
      let failed = false;
      for (const run of Object.values(snapshot.runs)) {
        if (!await discoverRun({ host, companyId, revision: snapshot.revision, run, runs: snapshot.runs,
          projects, decisions, resolveAdapter, runtimeBindingError })) failed = true;
      }
      if (failed) {
        await markMergeDiscoveryAttempt(db, companyId);
      } else if (!await advanceMergeDiscovery(db, companyId, lastRevision, snapshot.revision)) {
        host.logger.info('ADLC merge discovery checkpoint changed', { companyId });
      }
    } catch (error) {
      host.logger.warn('ADLC merge discovery failed for company', {
        companyId, runId: null, operation: 'company-scan', error: redactedMessage(error),
      });
      try {
        await markMergeDiscoveryAttempt(db, companyId);
      } catch (error) {
        host.logger.warn('ADLC merge discovery failed to record attempt', {
          companyId, runId: null, operation: 'company-scan', error: redactedMessage(error),
        });
      }
    }
  }
}
