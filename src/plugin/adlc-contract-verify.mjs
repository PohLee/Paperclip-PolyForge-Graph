import { isDeepStrictEqual } from 'node:util';
import { resolveAutomationMode } from '../host/automation-mode.mjs';
import { contractPublicationError, publicationMismatch, publicationRetryCause } from '../host/contract-publication-causes.mjs';
import { canonicalPublicationJson, publicationDigest, readContractReceiptBinding, readPublicationEntry, resolveReferencePublicationProfile } from '../host/contract-publication.mjs';
import { createGitHubAppAdapter } from '../host/github-app.mjs';
import { modelSeatRules } from './trusted-pack-adapters.mjs';
import { resolveCurrentMergeAdmission } from './adlc-merge-discovery.mjs';
import { githubAppConfigErrors, validGitHubApp } from './github-app-config.mjs';
import { createHostGitHubTransport } from './github-http-transport.mjs';
import { createInstallationTokenProvider } from './github-installation-token.mjs';
import { listGraphCompanies, PaperclipStore, table } from './store.mjs';

const kind = 'contract_publication_request';
const differs = () => contractPublicationError('contract-proposal-differs');
const subject = row => [row.company_id, row.run_id, row.node_id, row.attempt_index, row.kind, row.fingerprint];
const identity = 'company_id=$1 AND run_id=$2 AND node_id=$3 AND attempt_index=$4 AND kind=$5 AND fingerprint=$6';
const scope = identity + " AND disposition='admitted'";
const active = " AND (execution_state IS NULL OR execution_state IN ('verified','verification-failed'))";
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const statusPrefix = (project, app) => project.githubRepositoryId + ':' + app.appId + ':';
const contractsRoot = project => project.contracts_root ?? project.contractsRoot ?? 'knowledge/contracts';
const sameEntry = (a, b) => a?.sha === b?.sha && a?.type === b?.type && a?.mode === b?.mode;

export async function assertContractPublication(entries, readFile, plan) {
  const folder = plan.folder.toLowerCase();
  for (const [path, entry] of entries) {
    const folded = path.toLowerCase();
    if (folded !== folder && !folded.startsWith(folder + '/')) continue;
    const expected = entry.type === 'tree'
      ? Array.from(plan.publication.keys()).some(file => file.startsWith(path + '/'))
      : plan.publication.has(path);
    if (!expected) throw differs();
  }
  for (const [path, bytes] of plan.publication) {
    if (path === plan.indexPath) continue;
    const actual = await readFile(path);
    if (!actual || !Buffer.from(bytes).equals(actual)) throw differs();
  }
  const entry = readPublicationEntry(await readFile(plan.indexPath), plan.contractId, { canonical: true });
  if (!entry || !canonicalPublicationJson(entry).equals(canonicalPublicationJson(plan.indexEntry))) throw differs();
}

async function verifyProspectiveMerge(github, main, head, plan) {
  const base = await github.mergeBase(main, head);
  const [paths, before, branch, current] = await Promise.all([
    github.pullChanges(base, head), github.pinnedTree(base), github.pinnedTree(head), github.pinnedTree(main),
  ]);
  if (!paths.length || paths.some(path => !plan.publication.has(path))) throw differs();
  const result = new Map(current);
  let mergedIndex;
  for (const path of paths) {
    const entry = branch.get(path);
    if (!entry || entry.type !== 'blob' || entry.mode !== '100644') throw differs();
    if (path === plan.indexPath) {
      const headBytes = await github.readEntry(entry);
      const target = readPublicationEntry(headBytes, plan.contractId, { canonical: true });
      if (!isDeepStrictEqual(target, plan.indexEntry)) throw differs();
      const beforeBytes = await github.readEntry(before.get(path));
      if (beforeBytes) readPublicationEntry(beforeBytes, plan.contractId);
      const otherEntries = bytes => (bytes ? JSON.parse(bytes) : []).filter(row => row?.contractId !== plan.contractId);
      if (!isDeepStrictEqual(otherEntries(headBytes), otherEntries(beforeBytes))) throw differs();
      mergedIndex = plan.publication.get(path);
    } else if (!sameEntry(current.get(path), before.get(path)) && !sameEntry(current.get(path), entry)) {
      throw differs();
    }
    result.set(path, entry);
  }
  await assertContractPublication(result, path => path === plan.indexPath && mergedIndex
    ? mergedIndex : github.readEntry(result.get(path)), plan);
}

function currentReceipt(project, approved) {
  const { supersedes } = JSON.parse(approved.manifest.bytes);
  const { run, decision, snapshot } = approved;
  const stale = () => contractPublicationError('contract-supersedes-stale');
  if (supersedes === null) {
    if (run.contract_pins?.length || run.input.contract_pins?.length) throw stale();
    return null;
  }
  const pins = run.contract_pins?.filter(pin => pin.section === 'product' && pin.commit === supersedes) ?? [];
  if (pins.length !== 1 || !isDeepStrictEqual(run.contract_pins, run.input.contract_pins)) throw stale();
  const publications = snapshot.audit.filter(event => event.kind === 'contract.merged' && event.projectId === project.id &&
    event.repository?.toLowerCase() === project.repository.toLowerCase());
  const history = publications.filter(event => event.contractId === pins[0].contractId);
  const active = history.findLast(event => event.section === 'product');
  const approvedAt = snapshot.audit.findIndex(event => event.kind === 'decision.recorded' && event.decisionId === decision.id);
  if (active?.mergeCommitSha !== supersedes || approvedAt < 0 || snapshot.audit.indexOf(active) >= approvedAt ||
      publications.some(event => event.section === 'product' && event.supersedes === supersedes)) throw stale();
  return { currentReceipt: active, latestReceipt: history.at(-1) };
}

export function createAdlcContractVerify({ host, engineFor, resolveAdapter, runtimeBindingError }) {
  const queue = table(host.db.namespace, 'adlc_merge_requests');
  const fetch = createHostGitHubTransport(host);
  const reportedMain = new Map();
  let running;

  const save = (row, state, cause, result, reconcile = false) => host.db.execute(
    'UPDATE ' + queue + ' SET execution_state=$7, execution_reason=$8,' +
      ' verification_status=COALESCE(verification_status, \'{}\'::jsonb) || $9::jsonb, updated_at=now() WHERE ' + (reconcile ? identity : scope) + active,
    [...subject(row), state, cause, JSON.stringify(result ?? {})]);

  async function admit(row, project, snapshot) {
    const run = snapshot?.runs[row.run_id];
    if (!run || row.disposition !== 'admitted') throw contractPublicationError('publication-approval-stale');
    if (['paused', 'stopped'].includes(run.status)) throw contractPublicationError('publication-run-on-hold');
    if (run.contract_pins?.some(pin => snapshot.audit.findLast(event => event.projectId === project.id
        && event.contractId === pin.contractId && ['contract.frozen', 'contract.unfrozen'].includes(event.kind))
        ?.kind === 'contract.frozen')) throw contractPublicationError('publication-run-on-hold');
    const decisions = new Map(snapshot.decisions.map(decision => [decision.id, decision]));
    const approved = await resolveCurrentMergeAdmission({ companyId: row.company_id, run, runs: snapshot.runs,
      decisions, project, occurrence: row, resolveAdapter, runtimeBindingError });
    if (approved?.reason) throw contractPublicationError(approved.reason);
    if (!approved) throw contractPublicationError('publication-approval-stale');
    return { ...approved, run, snapshot };
  }

  async function processRow(row, project, profile, app, github, statuses) {
    const { pullNumber, decisionId } = json(row.request_json).payload;
    const history = json(row.verification_status) ?? {};
    const prefix = statusPrefix(project, app);
    const recordStatus = (sha, cause, eligible = true) => {
      const key = prefix + sha;
      const target = { row, github, sha, key, pullKey: prefix + pullNumber, eligible, prior: history[key]?.posted ?? history[key],
        result: { state: cause ? 'failure' : 'success', description: cause ?? 'Contract verified' } };
      if (!statuses.has(key)) statuses.set(key, []);
      statuses.get(key).push(target);
    };
    const withdraw = (cause, exceptSha) => {
      for (const [key, prior] of Object.entries(history)) {
        if (key.startsWith(prefix) && prior.state === 'success' && key !== prefix + exceptSha) {
          recordStatus(key.slice(prefix.length), cause, false);
        }
      }
    };

    const store = new PaperclipStore(host.db, row.company_id);
    let snapshot = await store.read();
    const existing = snapshot?.audit.find(event => event.kind === 'contract.merged'
      && event.repository?.toLowerCase() === project.repository.toLowerCase() && event.pullNumber === pullNumber);
    const recordedDecision = existing?.decisionId === decisionId && Boolean(existing?.lockDigest);
    if (row.disposition !== 'admitted' && !recordedDecision) {
      withdraw('publication-approval-stale');
      return;
    }
    const pr = await github.getPull(pullNumber);
    const { sha: headSha } = pr.head;
    const mergeSha = pr.merge_commit_sha;
    if (pr.merged && recordedDecision && existing.mergeCommitSha === mergeSha) {
      const binding = await readContractReceiptBinding({ ...existing, contractsRoot: contractsRoot(project) }, github.readOptionalFile);
      if (binding.lockDigest === existing.lockDigest && (!existing.folder || binding.folder === existing.folder)) {
        await save(row, 'recorded', null, null, true);
        return;
      }
    }
    if (row.disposition !== 'admitted') {
      withdraw('publication-approval-stale');
      return;
    }
    if (!pr.merged && pr.state !== 'open') {
      try { await admit(row, project, snapshot); }
      catch (error) {
        const cause = publicationMismatch(error);
        if (!cause) throw error;
        withdraw(cause);
      }
      return;
    }

    let approved, baseSha, plan, cause, mode, engine;
    try {
      if (pr.merged) {
        if (existing) throw contractPublicationError('github-pull-already-recorded');
        ({ engine } = await engineFor(row.company_id));
        snapshot = await store.read();
      }
      approved = await admit(row, project, snapshot);
      if (pr.base.ref !== 'main' || (!pr.merged && pr.draft)) throw differs();
      baseSha = await github.mainSha();
      if (pr.merged && (!/^[a-f0-9]{40}$/.test(mergeSha) || !await github.contains(mergeSha, baseSha))) {
        const key = 'ancestry:' + mergeSha;
        const count = (history[key] ?? 0) + 1;
        if (count <= 10) await save(row, row.execution_state, 'github-main-ancestry-unproven', { [key]: count });
        throw contractPublicationError('github-main-ancestry-unproven');
      }
      const receipts = currentReceipt(project, approved);
      const revision = pr.merged ? mergeSha : headSha;
      // The previous receipt supplies the preserved sections. First publications
      // have no predecessor, so neither case needs the landed commit's parent.
      const baseline = pr.merged ? receipts?.latestReceipt.mergeCommitSha : baseSha;
      const readMain = baseline ? github.readOptionalFile
        : path => path === contractsRoot(project) + '/INDEX.json' ? canonicalPublicationJson([]) : null;
      if (pr.merged && receipts && !await github.contains(baseline, mergeSha)) {
        throw contractPublicationError('contract-supersedes-stale');
      }
      plan = await profile({
        binding: { ...approved, ...receipts, containsCommit: github.contains },
        project, run: approved.run, section: 'product', pinnedMain: baseline, readMain,
        readApprovedDeliverable: ({ path }) => github.readOptionalFile(path, revision),
      });
      if (pr.head.ref !== plan.branch) throw differs();
      if (pr.merged) {
        await assertContractPublication(await github.pinnedTree(mergeSha),
          path => github.readOptionalFile(path, mergeSha), plan);
        mode = await resolveAutomationMode(engine, project, row.run_id, decisionId);
      } else {
        await verifyProspectiveMerge(github, baseSha, headSha, plan);
      }
    } catch (error) {
      cause = publicationMismatch(error);
      if (!cause || (cause === 'github-main-ancestry-unproven' && (history['ancestry:' + mergeSha] ?? 0) < 10)) throw error;
    }

    if (!pr.merged) {
      const latest = await github.getPull(pullNumber);
      if (latest.state !== 'open' || latest.merged || latest.head.sha !== headSha || latest.head.ref !== pr.head.ref
          || latest.base.ref !== pr.base.ref || latest.draft !== pr.draft || (baseSha && await github.mainSha() !== baseSha)) return;
    }

    const [rowIsActive] = await host.db.query('SELECT fingerprint FROM ' + queue + ' WHERE ' + scope + active, subject(row));
    const config = await host.config.get(row.company_id);
    const { id } = project;
    const latestProject = config?.adlcProjects?.[id];
    if (!rowIsActive || !isDeepStrictEqual(config?.githubApp, app) || !latestProject
        || (latestProject.id !== undefined && latestProject.id !== id)
        || !isDeepStrictEqual({ ...latestProject, id }, project)) return;
    const current = await store.read();
    if (snapshot?.revision !== current?.revision) throw contractPublicationError('publication-revision-changed');
    if (approved && !cause) await admit(row, project, current);

    if (pr.merged) {
      // Held runs can resume and complete verification. A stale approval is terminal.
      if (cause === 'publication-run-on-hold') {
        withdraw(cause, headSha);
        if (history[prefix + headSha]?.state === 'success') recordStatus(headSha, cause);
        return;
      }
      if (!cause) {
        const { manifest } = approved;
        await engine.recordContractMerge(row.run_id, {
          repository: project.repository.toLowerCase(), pullNumber, section: 'product', mode, decisionId,
          manifestId: manifest.id, revisionId: manifest.revisionId, manifestDigest: publicationDigest(manifest.bytes),
          baseSha, headSha, mergeCommitSha: mergeSha, contractId: plan.contractId, supersedes: plan.supersedes,
          folder: plan.folder, lockDigest: publicationDigest(plan.publication.get(plan.lockPath)),
        }, snapshot.revision);
      }
      const result = await save(row, cause ? 'merged-unverified' : 'recorded', cause ?? null);
      if (cause && result.rowCount === 1) host.logger?.warn('Merged G2 contract could not be verified', { runId: row.run_id, cause });
      return;
    }

    recordStatus(headSha, cause);
    if (['publication-run-on-hold', 'publication-approval-stale'].includes(cause)) withdraw(cause, headSha);
  }

  async function writeStatuses(statuses, deferred) {
    for (const [key, targets] of statuses) {
      const active = targets.filter(target => target.eligible);
      const options = active.length ? active : targets;
      const { github, sha, result } = options.find(target => target.result.state === 'failure') ?? options[0];
      if (result.state === 'success' && (deferred.has(key) || targets.some(target => deferred.has(target.pullKey)))) continue;
      try {
        const posted = targets.map(target => target.prior).filter(Boolean);
        if (!posted.length || posted.some(prior => !isDeepStrictEqual(prior, result))) {
          await github.writeStatus(sha, result.state, result.description);
        }
        for (const target of targets) {
          const { row, key, eligible, result: individual } = target;
          const entry = { ...individual, posted: result };
          const status = { [key]: entry };
          const initial = json(row.verification_status)?.[key];
          const failed = individual.state === 'failure';
          if (isDeepStrictEqual(initial, entry) && (!eligible ||
              (row.execution_state === (failed ? 'verification-failed' : 'verified') &&
              row.execution_reason === (failed ? individual.description : null)))) continue;
          if (eligible) {
            await save(row, failed ? 'verification-failed' : 'verified', failed ? individual.description : null, status);
          } else {
            await host.db.execute('UPDATE ' + queue +
              " SET verification_status=COALESCE(verification_status, '{}'::jsonb) || $7::jsonb WHERE " +
              identity,
            [...subject(row), JSON.stringify(status)]);
          }
        }
      } catch (error) {
        host.logger?.warn('G2 commit status will retry', { runId: options[0].row.run_id, cause: publicationRetryCause(error) });
      }
    }
  }

  async function reportUnapproved(companyId, project, github, main) {
    const snapshot = await new PaperclipStore(host.db, companyId).read();
    const receipts = new Map(snapshot?.audit.filter(event => event.kind === 'contract.merged' && event.projectId === project.id &&
      event.repository?.toLowerCase() === project.repository.toLowerCase()).map(event => [event.contractId, event]));
    const index = await github.readOptionalFile(contractsRoot(project) + '/INDEX.json', main);
    const covered = new Set();
    for (const receipt of receipts.values()) {
      try {
        const { folder } = receipt.folder ? receipt
          : await readContractReceiptBinding({ ...receipt, contractsRoot: contractsRoot(project) }, github.readOptionalFile);
        const entry = readPublicationEntry(index, receipt.contractId);
        if (entry && folder === contractsRoot(project) + '/' + entry.folder) covered.add(folder);
      } catch (error) {
        if (!['contract-index-invalid', 'contract-drift'].includes(error.publicationCause)) throw error;
      }
    }
    const prefix = contractsRoot(project) + '/';
    const unapproved = [];
    for (const [path, entry] of await github.pinnedTree(main)) {
      if (entry.type !== 'tree' || !path.startsWith(prefix) || path.split('/').length !== prefix.split('/').length + 2) continue;
      try { modelSeatRules.parseContractFolder(path.slice(prefix.length)); }
      catch { continue; }
      if (!covered.has(path)) unapproved.push(path);
    }
    const key = JSON.stringify([companyId, project.id, project.githubRepositoryId]);
    const observed = JSON.stringify(unapproved.sort());
    if (reportedMain.get(key) === observed) return;
    for (const folder of unapproved) host.logger?.warn('Unapproved contract folder', { cause: 'contract-unapproved', folder });
    reportedMain.set(key, observed);
  }

  async function scan() {
    const statuses = new Map();
    const deferred = new Set();
    const rowsByCompany = Map.groupBy(await host.db.query('SELECT * FROM ' + queue +
      " WHERE kind=$1 AND (disposition IN ('admitted','rejected-admission') OR verification_status IS NOT NULL)" + active + ' ORDER BY run_id,node_id,attempt_index', [kind]),
    row => row.company_id);
    for (const companyId of await listGraphCompanies(host.db)) {
      let config;
      try { config = await host.config.get(companyId); }
      catch {
        host.logger?.warn('G2 project configuration will retry', { cause: 'publication-retry' });
        continue;
      }
      const app = config?.githubApp;
      if (!validGitHubApp(app)) continue;
      const installationTokenProvider = createInstallationTokenProvider({ host, companyId, app, fetch });
      for (const [id, value] of Object.entries(config.adlcProjects ?? {})) {
        if (value?.contractPublication?.g2 !== true || (value.id !== undefined && value.id !== id)
            || githubAppConfigErrors({ githubApp: app, adlcProjects: { [id]: value } }).length) continue;
        const project = { ...value, id };
        const profile = resolveReferencePublicationProfile(project.contractPublication.validatorId, 'product');
        if (!profile || !modelSeatRules.isContractsRoot(contractsRoot(project))) continue;
        const github = createGitHubAppAdapter({ fetch, installationTokenProvider, repository: project.repository,
          githubRepositoryId: project.githubRepositoryId, contractsRoot: contractsRoot(project) });
        try {
          for (const row of rowsByCompany.get(companyId) ?? []) {
            const request = json(row.request_json);
            if (request.projectId !== id || request.repository !== project.repository.toLowerCase()) continue;
            try { await processRow(row, project, profile, app, github, statuses); }
            catch (error) {
              const prefix = statusPrefix(project, app);
              deferred.add(prefix + request.payload.pullNumber);
              for (const key of Object.keys(json(row.verification_status) ?? {})) if (key.startsWith(prefix)) deferred.add(key);
              host.logger?.warn('G2 contract verification will retry', { runId: row.run_id, cause: publicationRetryCause(error) });
            }
          }
          await reportUnapproved(companyId, project, github, await github.mainSha());
        } catch (error) {
          host.logger?.warn('G2 repository scan will retry', { cause: publicationRetryCause(error) });
        }
      }
    }
    await writeStatuses(statuses, deferred);
  }

  function tick() {
    running ??= scan().finally(() => { running = undefined; });
    return running;
  }
  return { tick };
}
