import { createHash } from 'node:crypto';
import { canonical } from '../core/canonical.mjs';
import { bindCandidateArtifact, currentCandidates } from '../core/engine.mjs';
import { mergeProducers } from './trusted-pack-adapters.mjs';
import { PaperclipStore, advanceMergeDiscovery, pendingMergeDiscovery, saveMergeRequest } from './store.mjs';

const sameRef = (binding, ref) => Boolean(binding && binding.artifactId === ref?.id && binding.version === ref?.revisionId);
const repositoryName = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) ? value.toLowerCase() : null;

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
  if (row.section === 'product') {
    const approved = JSON.parse(Buffer.from(manifest.bytes, 'base64'));
    if (approved.supersedes === null && (payload.contract_pins?.length ?? 0) !== 0) return 'first-publication-has-pins';
  }
  return null;
}

export async function discoverAdlcMerges({ host, resolveAdapter, limit = 20 }) {
  const { db } = host;
  for (const { companyId, lastRevision } of await pendingMergeDiscovery(db, limit)) {
    try {
      const snapshot = await new PaperclipStore(db, companyId).read();
      if (!snapshot || snapshot.revision <= Number(lastRevision)) continue;
      const projects = (await host.config?.get(companyId))?.adlcProjects ?? {};
      const decisions = new Map(snapshot.decisions.map(decision => [decision.id, decision]));
      for (const run of Object.values(snapshot.runs)) {
        const producers = mergeProducers.filter(row => row.packId === run.packId &&
          row.graphId === run.graph.id && row.versions.includes(run.graph.version));
        for (const row of producers) {
          const { nodeId, kind } = row;
          const node = run.nodeStates[nodeId];
          if (node?.status !== 'completed' || !node.attempts.length) continue;
          const artifactRef = node.attempts.at(-1).artifacts?.findLast(ref => ref.kind === kind) ?? null;
          const descriptor = resolveAdapter(run.pack)?.descriptor;
          const payload = artifactRef ? descriptor?.candidatePayload(run, { ...artifactRef, nodeId }) ?? null : null;
          const projectId = run.input.projectId;
          const project = typeof projectId === 'string' && projectId && Object.hasOwn(projects, projectId) ? projects[projectId] : null;
          const repository = repositoryName(project?.repository);
          const reason = checkAdmission({ run, row, descriptor, payload, decisions, project, companyId, repository });
          const request = { kind, payload, artifactRef };
          const fingerprint = createHash('sha256').update(canonical(request)).digest('hex');
          await saveMergeRequest(db, companyId, snapshot.revision, {
            runId: run.id, nodeId, attemptIndex: node.attempts.length, kind, fingerprint,
            request: { ...request, projectId: projectId ?? null, repository },
            disposition: reason ? 'rejected-admission' : 'admitted', reason,
          });
        }
      }
      if (!await advanceMergeDiscovery(db, companyId, lastRevision, snapshot.revision)) {
        host.logger.info('ADLC merge discovery checkpoint changed', { companyId });
      }
    } catch {
      host.logger.warn('ADLC merge discovery failed for company', { companyId });
    }
  }
}
