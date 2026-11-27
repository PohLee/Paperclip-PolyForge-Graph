import { isDeepStrictEqual } from 'node:util';
import { canonical } from '../core/canonical.mjs';
import { mergeContract } from '../host/contract-merge.mjs';
import { contractPublicationError, resolveReferencePublicationProfile } from '../host/contract-publication.mjs';
import { createGitHubAppAdapter } from '../host/github-app.mjs';
import { createGitHubJournalMerge } from '../host/github-journal-merge.mjs';
import { resolveCurrentMergeAdmission } from './adlc-merge-discovery.mjs';
import { validGitHubApp, validGitHubId } from './github-app-config.mjs';
import { createHostGitHubTransport, githubHostTransportReadiness } from './github-http-transport.mjs';
import { createInstallationTokenProvider, githubReadPermissions, githubWritePermissions } from './github-installation-token.mjs';
import { createGitHubMergeJournal } from './github-merge-journal.mjs';
import { PaperclipStore, table } from './store.mjs';

const gates = { contract_publication_request: 'g2', technical_publication_request: 'g4', design_publication_request: 'g3' };
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const projectFor = (config, id) => Object.hasOwn(config?.adlcProjects ?? {}, id)
  ? config.adlcProjects[id] : undefined;
const parseJson = value => typeof value === 'string' ? JSON.parse(value) : value;
const subject = row => [row.company_id, row.run_id, row.node_id, row.attempt_index, row.kind];

export function publicationConfiguration(config, request, kind, readiness, resolveProfile = resolveReferencePublicationProfile) {
  const project = projectFor(config, request.projectId);
  if (!Object.hasOwn(gates, kind) || kind !== 'contract_publication_request') return { reason: 'publication-validator-unavailable' };
  if (project?.contractPublication?.g2 !== true) return { reason: 'publication-gate-disabled' };
  const profile = resolveProfile(project.contractPublication.validatorId, 'product');
  if (!profile) return { reason: 'publication-validator-unavailable' };
  if (!validGitHubApp(config.githubApp)) return { reason: 'github-app-invalid' };
  if (typeof project.repository !== 'string' || !repositoryName.test(project.repository)
      || project.repository.split('/').some(part => part === '.' || part === '..')
      || !validGitHubId(project.githubRepositoryId) || !request.repository
      || (project.id !== undefined && project.id !== request.projectId)
      || project.repository.toLowerCase() !== request.repository) return { reason: 'project-binding-mismatch' };
  if (!readiness(config.githubTransportAttestation).ready) return { reason: 'transport-redirect-unsafe' };
  return { project: { ...project, id: request.projectId }, profile, app: config.githubApp };
}

function createPublicationQueue(db) {
  const queue = table(db.namespace, 'adlc_merge_requests');
  const journal = table(db.namespace, 'github_merge_journal');
  const key = 'company_id=$1 AND run_id=$2 AND node_id=$3 AND attempt_index=$4 AND kind=$5';
  return {
    due: limit => db.query('SELECT * FROM ' + queue + " WHERE disposition='admitted' AND kind IN " +
      "('contract_publication_request','technical_publication_request','design_publication_request')" +
      " AND (execution_state IS NULL OR execution_state IN ('blocked-config','backoff'))" +
      ' AND (next_try_at IS NULL OR next_try_at<=now()) ORDER BY next_try_at NULLS FIRST,updated_at,company_id,run_id,node_id,attempt_index,kind LIMIT $1',
    [limit]),
    async get(row) { return (await db.query('SELECT * FROM ' + queue + ' WHERE ' + key, subject(row)))[0]; },
    async defer(row, state, reason) {
      const seconds = state === 'blocked-config' ? 300 : 30 + Math.floor(Math.random() * 30);
      await db.execute('UPDATE ' + queue + ' AS q SET execution_state=$7,execution_reason=$8,execution_version=execution_version+1,' +
        " next_try_at=now()+$9 * interval '1 second' WHERE " + key +
        " AND execution_version=$6 AND disposition='admitted' AND (execution_state IS NULL OR execution_state IN ('blocked-config','backoff'))" +
        " AND NOT EXISTS (SELECT 1 FROM " + journal + " AS j WHERE j.company_id=q.company_id AND j.run_id=q.run_id" +
        " AND j.node_id=q.node_id AND j.attempt_index=q.attempt_index AND j.kind=q.kind AND j.state<>'claimed' FOR SHARE)",
      [...subject(row), String(row.execution_version), state, reason, seconds]);
    },
    async project(row, state, reason, receipt = null) {
      await db.execute('UPDATE ' + queue + ' AS q SET execution_state=$8,execution_reason=$9,operation_key=$6,receipt_json=$10::jsonb,' +
        ' next_try_at=NULL,execution_version=execution_version+1 WHERE ' + key +
        " AND execution_state IS DISTINCT FROM 'recorded' AND EXISTS (SELECT 1 FROM " + journal + ' AS j' +
        ' WHERE j.repository_node_id=$11 AND j.operation_key=$6 AND j.fence=$7 AND j.state=$12' +
        ' AND j.company_id=q.company_id AND j.run_id=q.run_id AND j.node_id=q.node_id' +
        ' AND j.attempt_index=q.attempt_index AND j.kind=q.kind FOR SHARE)',
      [...subject(row), row.operation_key, row.fence, state, reason, JSON.stringify(receipt), row.repository_node_id, row.state]);
    },
  };
}

function currentProductReceipt(snapshot, project, run, admission) {
  const { supersedes } = JSON.parse(admission.manifest.bytes);
  if (supersedes === null) return null;
  const pins = run.contract_pins?.filter(pin => pin.section === 'product' && pin.commit === supersedes) ?? [];
  if (pins.length !== 1 || !isDeepStrictEqual(run.contract_pins, run.input.contract_pins)) {
    throw contractPublicationError('contract-supersedes-stale');
  }
  const { contractId } = pins[0];
  const scope = snapshot.audit.filter(event => event.projectId === project.id && event.contractId === contractId);
  const frozen = scope.findLast(event => ['contract.frozen', 'contract.unfrozen'].includes(event.kind));
  const publications = scope.filter(event => event.kind === 'contract.merged' && event.section === 'product');
  const replaced = new Set(publications.map(event => event.supersedes));
  const active = publications.filter(event => !replaced.has(event.mergeCommitSha));
  const approved = snapshot.audit.findIndex(event => event.kind === 'decision.recorded' && event.decisionId === admission.decision.id);
  if (active.length !== 1 || active[0].mergeCommitSha !== supersedes || active[0].repository !== project.repository
      || approved < 0 || snapshot.audit.indexOf(active[0]) >= approved || frozen?.kind === 'contract.frozen') {
    throw contractPublicationError('contract-supersedes-stale');
  }
  return active[0];
}

export function createAdlcContractPublication({
  host, engineFor, resolveAdapter, runtimeBindingError, resolveInstalledValidator = resolveReferencePublicationProfile,
  transportReadiness = githubHostTransportReadiness,
}) {
  const journal = createGitHubMergeJournal(host.db);
  const fetch = createHostGitHubTransport(host);
  const queue = createPublicationQueue(host.db);

  async function configured(row, request) {
    const config = await host.config.get(row.company_id);
    return publicationConfiguration(config, request, row.kind, transportReadiness, resolveInstalledValidator);
  }

  async function admission(row, project) {
    const snapshot = await new PaperclipStore(host.db, row.company_id).read();
    const run = Object.hasOwn(snapshot?.runs ?? {}, row.run_id) && snapshot.runs[row.run_id];
    if (!run || ['paused', 'stopped'].includes(run.status)) throw contractPublicationError('publication-approval-stale');
    const decisions = new Map(snapshot.decisions.map(decision => [decision.id, decision]));
    const approved = await resolveCurrentMergeAdmission({ companyId: row.company_id, run, runs: snapshot.runs,
      decisions, project, occurrence: row, resolveAdapter, runtimeBindingError });
    if (!approved || approved.payload.pullNumber > 2147483647) throw contractPublicationError('publication-approval-stale');
    return { ...approved, run, snapshot, currentReceipt: currentProductReceipt(snapshot, project, run, approved) };
  }

  function adapter(row, project, app, installedValidator, durableWriter, permissions = githubWritePermissions) {
    const installationTokenProvider = createInstallationTokenProvider({ host, companyId: row.company_id, app, fetch });
    return createGitHubAppAdapter({ fetch, installationTokenProvider, githubRepositoryId: project.githubRepositoryId,
      permissions, installedValidator, durableWriter });
  }

  async function projectDurable(row) {
    if (row.state === 'abandoned') {
      await queue.project(row, 'needs-new-approval', 'publication-abandoned');
      await journal.archiveRecovery(row);
    }
    if (row.state === 'intent') await queue.project(row, 'reconciling', null);
    if (row.state === 'unresolved') await queue.project(row, 'unresolved', row.missing_fact);
    if (row.state === 'patched') await queue.project(row, 'recording', null);
    if (row.state === 'recorded') {
      const saved = await journal.receiptByOperation(row.operation_key);
      if (!saved) throw new Error('publication-receipt-missing');
      await queue.project(row, 'recorded', null, saved.receipt_json);
      if (row.recovery_json) await journal.archiveRecovery(row);
      await journal.acked(row, saved.receipt_json);
    }
  }

  async function publish(row) {
    const request = parseJson(row.request_json);
    const configuration = await configured(row, request);
    if (configuration.reason) {
      await queue.defer(row, 'blocked-config', configuration.reason);
      return;
    }
    const { project, app, profile } = configuration;
    const approved = await admission(row, project);
    const { engine } = await engineFor(row.company_id);
    await engine.assertCurrentContractPins(row.run_id, approved.decision.id);
    const installedValidator = profile({ binding: approved, project, run: approved.run });
    const durableWriter = createGitHubJournalMerge({ journal, scope: {
      companyId: row.company_id, projectId: project.id, runId: row.run_id, nodeId: row.node_id,
      attemptIndex: row.attempt_index, kind: row.kind, fingerprint: row.fingerprint, repository: project.repository,
      repositoryId: project.githubRepositoryId, appId: app.appId, installationId: app.installationId,
    } });
    const github = adapter(row, project, app, installedValidator, durableWriter);
    const receipt = await mergeContract({ engine, github, project, runId: row.run_id, section: 'product',
      pullNumber: approved.payload.pullNumber, decisionId: approved.decision.id, manifest: approved.manifest,
      async authorize() {
        const current = await queue.get(row);
        if (current?.disposition !== 'admitted' || current.fingerprint !== row.fingerprint) {
          throw contractPublicationError('publication-approval-stale');
        }
        const checked = await admission(row, project);
        await engine.assertCurrentContractPins(row.run_id, approved.decision.id);
        if (!isDeepStrictEqual(checked.currentReceipt, approved.currentReceipt)) {
          throw contractPublicationError('contract-supersedes-stale');
        }
        const latest = await configured(row, request);
        if (latest.reason || canonical(latest.project) !== canonical(project) || app.appId !== latest.app.appId
            || app.installationId !== latest.app.installationId || !isDeepStrictEqual(app.privateKeyRef, latest.app.privateKeyRef)) {
          throw contractPublicationError('publication-policy-changed');
        }
        return { revision: checked.snapshot.revision, fingerprint: row.fingerprint };
      },
    });
    const recorded = await github.record({ ...receipt, runId: row.run_id }, receipt);
    await projectDurable(recorded);
  }

  async function recoveryAdapter(row, repository, permissions) {
    const config = await host.config.get(row.company_id);
    const app = config?.githubApp;
    if (!validGitHubApp(app) || String(app.appId) !== row.app_id || String(app.installationId) !== row.installation_id
        || !transportReadiness(config.githubTransportAttestation).ready) throw new Error('publication-observation-unavailable');
    const repositoryId = Number(row.repository_id);
    const github = adapter(row, { githubRepositoryId: repositoryId }, app, undefined,
      methods => ({ ...methods }), permissions);
    if ((await github.repositoryIdentity(repository, repositoryId)).nodeId !== row.repository_node_id) {
      throw new Error('publication-observation-unavailable');
    }
    return github;
  }

  async function recordProven(row) {
    const { engine } = await engineFor(row.company_id);
    const expected = { ...row.publication_json, mergeCommitSha: row.merge_sha };
    const queueRow = await queue.get(row);
    const request = parseJson(queueRow?.request_json);
    const run = await engine.getRun(row.run_id);
    if (!run || run.input.projectId !== request?.projectId || run.input.paperclipCompanyId !== row.company_id
        || request.payload?.pullNumber !== row.pull_number) throw new Error('publication-receipt-conflict');
    const receipt = await engine.recordContractMerge(row.run_id, expected);
    if (!isDeepStrictEqual(receipt, expected)) throw new Error('publication-receipt-conflict');
    await journal.insertReceipt(row, receipt);
    if (!await journal.recorded(row, receipt)) return;
    await projectDurable({ ...row, state: 'recorded' });
    return receipt;
  }

  async function reconcile(row) {
    if (row.state === 'recorded' || row.state === 'abandoned') return projectDurable(row);
    if (row.state === 'patched') {
      await projectDurable(row);
      return recordProven(row);
    }
    let fact = 'merge-sha-not-persisted';
    if (row.merge_sha) {
      let proven = false;
      try {
        const repository = row.publication_json.repository;
        const github = await recoveryAdapter(row, repository, githubReadPermissions);
        proven = await github.mainContains(repository, row.merge_sha);
        fact = 'main-ancestry-unproven';
      } catch {
        fact = 'github-observation-unavailable';
      }
      if (proven) {
        if (await journal.patched(row)) return reconcile({ ...row, state: 'patched' });
        return;
      }
    }
    if (row.state === 'intent') {
      if (await journal.unresolved(row, fact)) await projectDurable({ ...row, state: 'unresolved', missing_fact: fact });
    } else {
      await projectDurable(row);
    }
  }

  async function cleanupReceipt(saved) {
    const binding = await journal.byRepository(saved.repository_node_id);
    const repository = saved.receipt_json.repository;
    const github = await recoveryAdapter({ ...binding, company_id: saved.company_id }, repository, githubWritePermissions);
    async function readTemp() {
      try { return await github.getRef({ repository, ref: saved.temp_ref }); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    let target = await readTemp();
    if (target === saved.receipt_json.mergeCommitSha) {
      try {
        await github.deleteTempRef(repository, saved.temp_ref);
        target = undefined;
      } catch {
        target = await readTemp();
      }
    }
    if (target === undefined) await journal.cleanup(saved, 'complete');
    else if (target !== saved.receipt_json.mergeCommitSha) await journal.cleanup(saved, 'ref-changed');
  }

  async function scan(limit) {
    for (const state of ['intent', 'patched', 'recorded', 'unresolved', 'abandoned']) {
      for (const row of await journal.due(state, limit)) {
        try { if (await journal.rotateDue(row)) await reconcile(row); }
        catch { host.logger?.warn('ADLC publication journal reconciliation failed', { state }); }
      }
    }
    for (const row of await journal.pendingCleanup(limit)) {
      try { if (await journal.rotateCleanup(row)) await cleanupReceipt(row); }
      catch { host.logger?.warn('ADLC publication temporary ref cleanup failed'); }
    }
  }

  async function tick(limit = 20) {
    await scan(limit);
    const results = [];
    for (const row of await queue.due(limit)) {
      try {
        await publish(row);
        results.push({ state: 'processed' });
      } catch (error) {
        const current = (await journal.bySubject(row)).find(item => item.state !== 'claimed');
        if (current) {
          await projectDurable(current);
          results.push({ state: current.state });
          continue;
        }
        const reason = error.publicationCause ?? 'publication-retry';
        const state = reason === 'contract-type-slug-missing' ? 'blocked-config'
          : reason === 'publication-retry' ? 'backoff' : 'needs-new-approval';
        await queue.defer(row, state, reason);
        results.push({ state, reason });
      }
    }
    return results;
  }

  async function recoverUnresolved(row, actorId) {
    const repository = row.publication_json.repository;
    const github = await recoveryAdapter(row, repository, githubWritePermissions);
    const readMain = () => github.getRef({ repository, ref: 'refs/heads/main' });
    const contains = (main, commit) => github.commitContains(repository, main, commit);
    const readTemp = async () => {
      try { return await github.getRef({ repository, ref: row.temp_ref }); }
      catch (error) { if (error.status !== 404) throw error; return null; }
    };
    const mainSha = await readMain();
    if (row.merge_sha && await contains(mainSha, row.merge_sha)) {
      const proof = { outcome: 'ancestry', actorId, mainSha };
      if (!await journal.patched(row, proof)) throw new Error('publication-recovery-state-changed');
      await recordProven({ ...row, state: 'patched', recovery_json: proof });
      return { outcome: 'ancestry' };
    }
    const refuse = () => new Error('publication-recovery-proof-unavailable');
    if ((row.merge_sha && row.patch_send_started !== false) || mainSha === row.base_sha
        || !/^refs\/heads\/polyforge-merge-[0-9a-f-]{36}$/.test(row.temp_ref)
        || !await contains(mainSha, row.base_sha)) throw refuse();

    const target = await readTemp();
    if (target && target !== row.recovery_delete_sha) {
      const expected = row.merge_sha ? target === row.merge_sha : target === row.base_sha
        || await github.hasMergeParents(repository, target, row.base_sha, row.head_sha);
      if (!expected || !await journal.authorizeRecoveryDelete(row, target)) throw refuse();
    }
    const tempSha = target ?? row.recovery_delete_sha;
    if (!tempSha) throw refuse();
    if (target) {
      if (await readTemp() !== target) throw refuse();
      try { await github.deleteTempRef(repository, row.temp_ref); }
      catch { /* The SDK may throw on a successful empty response. Verify below. */ }
    }
    if (await readTemp() !== null || await readMain() !== mainSha) throw refuse();
    const proof = { outcome: 'abandoned', actorId, mainSha, tempSha };
    if (!await journal.abandonUnresolved(row, proof)) throw new Error('publication-recovery-state-changed');
    await projectDurable({ ...row, state: 'abandoned', recovery_json: proof });
    return { outcome: 'abandoned' };
  }

  async function recover({ companyId, issueId, actor, runId, nodeId, attemptIndex, kind, recoveryAction }) {
    if (actor?.kind !== 'human' || !['view', 'reschedule'].includes(recoveryAction) || !Object.hasOwn(gates, kind)
        || typeof nodeId !== 'string' || !nodeId || !Number.isInteger(attemptIndex) || attemptIndex < 1
        || attemptIndex > 2147483647 || typeof runId !== 'string' || !runId) {
      throw new Error('publication-recovery-invalid-owner-request');
    }
    const { engine } = await engineFor(companyId);
    const run = await engine.getRun(runId);
    const projectId = run?.input?.projectId;
    const config = await host.config.get(companyId);
    if (!run || run.input.paperclipIssueId !== issueId || run.input.paperclipCompanyId !== companyId
        || !actor.id || projectFor(config, projectId)?.ownerId !== actor.id) {
      throw new Error('publication-recovery-requires-project-owner');
    }
    const scope = { company_id: companyId, run_id: runId, node_id: nodeId, attempt_index: attemptIndex, kind };
    const request = await queue.get(scope);
    if (parseJson(request?.request_json)?.projectId !== projectId) throw new Error('publication-recovery-request-missing');
    const archived = await journal.recoveryBySubject(scope);
    const rows = (await journal.bySubject(scope)).filter(row => row.state !== 'claimed'
      && (!request.operation_key || row.operation_key === request.operation_key));
    if (rows.length > 1) throw new Error('publication-recovery-request-ambiguous');
    const [row] = rows;
    if (recoveryAction === 'view') {
      return { state: row?.state ?? request.execution_state, operationKey: row?.operation_key ?? request.operation_key,
        missingFact: row?.missing_fact ?? null, tempRef: row?.temp_ref ?? archived?.temp_ref ?? null,
        outcome: archived?.proof_json.outcome ?? row?.recovery_json?.outcome ?? null };
    }
    if (archived) return { outcome: archived.proof_json.outcome };
    if (!row) throw new Error('publication-recovery-request-missing');
    if (row.state === 'unresolved') return recoverUnresolved(row, actor.id);
    if (row.state !== 'intent' || await journal.observationDue(row)) await reconcile(row);
    return row.recovery_json ? { outcome: row.recovery_json.outcome } : { state: row.state };
  }

  return { tick, scan, recover };
}
