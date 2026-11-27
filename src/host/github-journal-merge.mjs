import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { contractPublicationError } from './contract-publication-causes.mjs';
import { canonical } from '../core/canonical.mjs';

const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const tempRefPattern = /^refs\/heads\/polyforge-merge-[0-9a-f-]{36}$/;
const sections = { product: 'contract_publication_request', design: 'design_publication_request',
  technical: 'technical_publication_request' };
const proven = new Set(['patched', 'recorded', 'acked']);
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const fault = contractPublicationError;

function approvedRequest(input, scope) {
  const { repository, runId, pullNumber, section, decisionId, manifestId, revisionId, manifestDigest, auditDigest } = input;
  if (repository !== scope.repository || runId !== scope.runId || !positiveId(pullNumber) || pullNumber > 2147483647
    || !Object.hasOwn(sections, section) || sections[section] !== scope.kind
    || ![decisionId, manifestId, revisionId].every(textId) || !digest.test(manifestDigest)
    || (auditDigest !== undefined && (!digest.test(auditDigest) || !scope.audit))
    || (scope.audit && !auditDigest)) throw fault('github-merge-invalid-request');
  return { repository, pullNumber, section, decisionId, manifestId, revisionId, manifestDigest,
    ...(auditDigest !== undefined && { auditDigest }) };
}

function publicationFor(input, request) {
  const { baseSha, headSha, contractId, supersedes, mode } = input;
  if (![baseSha, headSha].every(value => sha.test(value)) || !textId(contractId)
    || (supersedes !== null && !sha.test(supersedes))
    || !['manual', 'assisted', 'full-auto'].includes(mode)) throw fault('github-merge-invalid-publication');
  return { ...request, baseSha, headSha, contractId, supersedes, mode };
}

function validateScope(scope) {
  if (![scope.companyId, scope.projectId, scope.runId, scope.nodeId].every(textId)
    || ![scope.repositoryId, scope.appId, scope.installationId, scope.attemptIndex].every(positiveId)
    || scope.attemptIndex > 2147483647 || !digest.test(scope.fingerprint)
    || !/^[\w.-]+\/[\w.-]+$/.test(scope.repository)
    || scope.repository.split('/').some(value => value === '.' || value === '..')
    || !Object.values(sections).includes(scope.kind)
    || (scope.audit && ![scope.audit.id, scope.audit.revisionId].every(textId))) {
    throw fault('github-merge-invalid-scope');
  }
  return { ...scope, audit: scope.audit && { id: scope.audit.id, revisionId: scope.audit.revisionId } };
}

function matchesBinding(row, repo, scope) {
  return row?.repository_node_id === repo.nodeId && row.repository_id === String(scope.repositoryId)
    && row.app_id === String(scope.appId) && row.installation_id === String(scope.installationId);
}

const matchesFence = (row, previous) => row?.repository_node_id === previous.repository_node_id
  && row.fence === previous.fence && row.operation_key === previous.operation_key;
const expectedReceipt = row => ({ ...row.publication_json, mergeCommitSha: row.merge_sha });

export async function cleanupJournalTempRef(github, repository, { temp_ref: ref, receipt_json: receipt }) {
  if (!tempRefPattern.test(ref)) throw fault('github-merge-invalid-temp-ref');
  const readTemp = async () => {
    try { return await github.getRef({ repository, ref }); }
    catch (error) { if (error.status !== 404) throw error; }
  };
  let target = await readTemp();
  if (target === receipt.mergeCommitSha) {
    try {
      await github.deleteTempRef(repository, ref);
      target = undefined;
    } catch {
      target = await readTemp();
    }
  }
  if (target === receipt.mergeCommitSha) return 'pending';
  return target === undefined ? 'complete' : 'ref-changed';
}

/** A writer is scoped to one admitted queue occurrence and its original App installation. */
export function createGitHubJournalMerge({ journal, scope: inputScope, leaseSeconds = 60 }) {
  const scope = validateScope(inputScope);
  if (!positiveId(leaseSeconds)) throw fault('github-merge-invalid-lease');

  return function bindGitHub(github) {
    let prepared;
    async function identity() {
      const repo = await github.repositoryIdentity(scope.repository, scope.repositoryId);
      const registered = await journal.byRepositoryId(String(scope.repositoryId));
      if (registered && !matchesBinding(registered, repo, scope)) throw fault('github-merge-repository-binding-conflict');
      return repo;
    }

    function occurrence(repo, request) {
      const operationKey = createHash('sha256').update(canonical({
        version: 1, repositoryNodeId: repo.nodeId, companyId: scope.companyId, projectId: scope.projectId,
        runId: scope.runId, nodeId: scope.nodeId, attemptIndex: scope.attemptIndex, kind: scope.kind,
        fingerprint: scope.fingerprint, section: request.section, pullNumber: request.pullNumber,
        decisionId: request.decisionId,
        manifest: { id: request.manifestId, revisionId: request.revisionId, digest: request.manifestDigest },
        audit: scope.audit ? { ...scope.audit, digest: request.auditDigest } : null,
      })).digest('hex');
      return {
        repository_node_id: repo.nodeId, repository_id: String(scope.repositoryId),
        app_id: String(scope.appId), installation_id: String(scope.installationId),
        company_id: scope.companyId, run_id: scope.runId, node_id: scope.nodeId,
        attempt_index: scope.attemptIndex, kind: scope.kind, pull_number: request.pullNumber,
        operation_key: operationKey,
      };
    }

    async function observe(row) {
      const current = await journal.byRepository(row.repository_node_id);
      return matchesFence(current, row) ? current : undefined;
    }

    async function transition(row, change) {
      try { await change(); } catch { /* Observe the durable outcome of a lost acknowledgment. */ }
      return observe(row);
    }

    async function reconcile(row, immediate = false) {
      row = await observe(row);
      if (!row || !['intent', 'unresolved'].includes(row.state)) return row;
      if (row.state === 'intent' && !immediate && !await journal.observationDue(row)) return row;
      let fact = 'merge-sha-not-persisted';
      if (row.merge_sha) {
        try {
          if (await github.mainContains(scope.repository, row.merge_sha)) return transition(row, () => journal.patched(row));
          fact = 'main-ancestry-unproven';
        } catch {
          fact = 'github-observation-unavailable';
        }
      }
      return transition(row, () => row.state === 'intent'
        ? journal.unresolved(row, fact)
        : journal.observedUnresolved(row));
    }

    async function prior(repo, row) {
      const saved = await journal.receipt(repo.nodeId, row.pull_number);
      if (saved) {
        if (saved.operation_key !== row.operation_key) throw fault('github-merge-pull-already-recorded');
        return saved.receipt_json;
      }
      const current = await journal.byRepository(repo.nodeId);
      if (current && !matchesBinding(current, repo, scope)) throw fault('github-merge-repository-binding-conflict');
      if (current?.operation_key !== row.operation_key || current.state === 'claimed') return undefined;
      if (current.state === 'abandoned') throw fault('github-merge-abandoned');
      const result = await reconcile(current);
      if (proven.has(result?.state)) return expectedReceipt(result);
      throw fault(result?.state === 'unresolved' ? 'github-merge-unresolved' : 'github-merge-reconciling');
    }

    async function claim(repo, row) {
      const old = await journal.byRepository(repo.nodeId);
      if (old && !matchesBinding(old, repo, scope)) throw fault('github-merge-repository-binding-conflict');
      row.claim_id = randomUUID();
      row.fence = old ? String(BigInt(old.fence) + 1n) : '1';
      let acquired;
      try {
        acquired = old ? await journal.takeover(row, old, leaseSeconds) : await journal.claim(row, leaseSeconds);
      } catch (error) {
        await journal.byRepository(repo.nodeId);
        throw error;
      }
      if (!acquired) {
        await journal.byRepository(repo.nodeId);
        throw fault(old?.state === 'unresolved' ? 'repository-blocked' : 'github-merge-repository-busy');
      }
    }

    async function exactPull(publication) {
      if (await github.getRef({ repository: scope.repository, ref: 'refs/heads/main' }) !== publication.baseSha) {
        throw fault('github-merge-main-changed');
      }
      await github.assertOpenPull(publication, scope.repositoryId);
    }

    async function getMergeReceipt(input) {
      const request = approvedRequest(input, scope);
      const repo = await identity();
      const receipt = await prior(repo, occurrence(repo, request));
      if (receipt && Object.entries(request).some(([key, value]) => receipt[key] !== value)) {
        throw fault('github-merge-request-changed');
      }
      return receipt;
    }

    async function prepareMerge(input) {
      const request = approvedRequest(input, scope);
      const repo = await identity();
      const row = occurrence(repo, request);
      if (await prior(repo, row)) return;
      await claim(repo, row);
      prepared = row;
    }

    async function releaseMergePreparation() {
      if (!prepared) return;
      const row = prepared;
      prepared = undefined;
      try { await journal.abandon(row); } catch { /* The read-only lease expires independently. */ }
    }

    async function merge(input, authorize) {
      const request = approvedRequest(input, scope);
      const publication = publicationFor(input, request);
      if (typeof authorize !== 'function') throw fault('github-merge-authorization-required');
      const repo = await identity();
      const row = prepared ?? occurrence(repo, request);
      if (row.operation_key !== occurrence(repo, request).operation_key) throw fault('github-merge-request-changed');
      const saved = await prior(repo, row);
      if (saved) {
        if (!isDeepStrictEqual(saved, { ...publication, mergeCommitSha: saved.mergeCommitSha })) {
          throw fault('github-merge-request-changed');
        }
        return saved.mergeCommitSha;
      }
      if (!prepared) await claim(repo, row);
      const tempRef = 'refs/heads/polyforge-merge-' + randomUUID();
      try {
        await exactPull(publication);
        const authorization = await authorize('intent');
        const revision = authorization?.revision ?? 0;
        const fingerprint = authorization?.fingerprint;
        if (fingerprint !== undefined && fingerprint !== scope.fingerprint) throw fault('github-merge-invalid-authorization');
        if (!/^(0|[1-9][0-9]*)$/.test(String(revision))) throw fault('github-merge-invalid-authorization');
        if (!await journal.intent(row, publication, revision, tempRef, fingerprint)) throw fault('github-merge-intent-lost');
      } catch (error) {
        const current = await observe(row);
        if (current?.state === 'claimed') {
          await transition(row, () => journal.abandon(row));
          if (error.publicationCause && error.publicationCause !== 'github-merge-intent-lost') {
            throw fault(error.publicationCause, 'github-merge-intent-unavailable');
          }
        }
        const unavailable = fault('github-merge-intent-unavailable');
        if (Number.isSafeInteger(error.retryAfterSeconds)) unavailable.retryAfterSeconds = error.retryAfterSeconds;
        throw unavailable;
      }

      // This capability exists only in the call that got an exact intent acknowledgment.
      let sendPatch = sha => github.patchMain(scope.repository, sha);
      try {
        if ((await observe(row))?.state !== 'intent') throw fault('github-merge-intent-lost');
        await github.createTempRef(scope.repository, tempRef, publication.baseSha);
        if ((await observe(row))?.state !== 'intent') throw fault('github-merge-intent-lost');
        const mergeSha = await github.mergeTempRef(scope.repository, tempRef, publication.baseSha, publication.headSha);
        if (!await journal.mergeSha(row, mergeSha)) throw fault('github-merge-sha-unavailable');
        await exactPull(publication);
        const authorization = await authorize('patch');
        const current = await observe(row);
        if (current?.state !== 'intent' || current.merge_sha !== mergeSha) throw fault('github-merge-intent-lost');
        if (current.patch_send_started === false && !await journal.beginPatchSend(current, authorization)) {
          throw fault('github-merge-intent-lost');
        }
        const send = sendPatch;
        sendPatch = undefined;
        await send(mergeSha);
        const result = await transition(current, () => journal.patched(current));
        if (proven.has(result?.state)) return result.merge_sha;
      } catch {
        // Read-only recovery is safe even if the transport or a CAS completed without a reply.
      }
      const result = await reconcile(row, true);
      if (proven.has(result?.state)) return result.merge_sha;
      throw fault('github-merge-unresolved');
    }

    async function record(input, receipt) {
      const request = approvedRequest(input, scope);
      const current = await journal.byRepositoryId(String(scope.repositoryId));
      const repo = { nodeId: current?.repository_node_id };
      if (!current || !matchesBinding(current, repo, scope)) throw fault('github-merge-repository-binding-conflict');
      const row = occurrence(repo, request);
      if (current.operation_key !== row.operation_key || !proven.has(current.state)
        || !isDeepStrictEqual(receipt, expectedReceipt(current))) throw fault('github-merge-receipt-conflict');
      if (current.state === 'patched') {
        await transition(current, () => journal.insertReceipt(current, expectedReceipt(current)));
      }
      const saved = await journal.receipt(repo.nodeId, row.pull_number);
      if (saved?.operation_key !== row.operation_key || saved.company_id !== row.company_id || saved.run_id !== row.run_id
        || saved.temp_ref !== current.temp_ref || !isDeepStrictEqual(saved.receipt_json, receipt)) {
        throw fault('github-merge-receipt-conflict');
      }
      const result = current.state === 'patched'
        ? await transition(current, () => journal.recorded(current, saved.receipt_json)) : current;
      if (!['recorded', 'acked'].includes(result?.state)) throw fault('github-merge-recording-pending');
      return result;
    }

    async function cleanup(input) {
      const request = approvedRequest(input, scope);
      const repo = await identity();
      const row = occurrence(repo, request);
      const saved = await journal.receipt(repo.nodeId, row.pull_number);
      if (saved?.operation_key !== row.operation_key || !tempRefPattern.test(saved.temp_ref)) return;
      if (saved.cleanup_state !== 'pending') return saved.cleanup_state;
      const result = await cleanupJournalTempRef(github, scope.repository, saved);
      if (result === 'pending') return result;
      await journal.cleanup(saved, result);
      return (await journal.receiptByOperation(row.operation_key))?.cleanup_state;
    }

    return { getMergeReceipt, prepareMerge, releaseMergePreparation, merge, record, cleanup };
  };
}
