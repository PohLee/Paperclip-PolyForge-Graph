import { isDeepStrictEqual } from 'node:util';
import { resolveAutomationMode } from '../host/automation-mode.mjs';
import { contractPublicationError, publicationMismatch } from '../host/contract-publication-causes.mjs';
import { publicationDigest, resolveReferencePublicationProfile } from '../host/contract-publication.mjs';
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
const scope = "company_id=$1 AND run_id=$2 AND node_id=$3 AND attempt_index=$4 AND kind=$5 AND fingerprint=$6 AND disposition='admitted'";
const active = " AND (execution_state IS NULL OR execution_state IN ('verified','verification-failed'))";
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const contractsRoot = project => project.contracts_root ?? project.contractsRoot ?? 'knowledge/contracts';
const sameEntry = (a, b) => a?.sha === b?.sha && a?.type === b?.type && a?.mode === b?.mode;

function treeChanges(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter(path => {
    const a = before.get(path), b = after.get(path);
    return !sameEntry(a?.type === 'tree' ? undefined : a, b?.type === 'tree' ? undefined : b);
  }).sort();
}

async function assertPublicationFiles(github, commit, plan) {
  const prefix = plan.folder.toLowerCase() + '/';
  const entries = await github.pinnedTree(commit);
  for (const [path, entry] of entries) {
    const folded = path.toLowerCase();
    if ((folded.startsWith(prefix) || folded === plan.folder.toLowerCase())
        && entry.type !== 'tree' && !plan.publication.has(path)) throw differs();
  }
  for (const [path, bytes] of plan.publication) {
    const actual = await github.readOptionalFile(path, commit);
    if (!actual || !Buffer.from(bytes).equals(actual)) throw differs();
  }
}

// A multi-commit rebase can put part of the proposal on the first parent.
// Recover the pre-proposal tree only after matching the original and landed deltas.
async function rebasedBase(github, pr, mergeCommit) {
  if (mergeCommit.parents.length !== 1 || !Number.isSafeInteger(pr.commits) || pr.commits < 2) return null;
  let original = await github.getCommit(pr.head.sha);
  let landed = mergeCommit;
  const sharedBase = await github.mergeBase(original.sha, landed.sha);
  for (let i = 0; i < pr.commits; i++) {
    if (original.parents.length !== 1 || landed.parents.length !== 1 || original.sha === sharedBase || landed.sha === sharedBase) return null;
    const [before, after, rewrittenBefore, rewrittenAfter] = await Promise.all([
      github.pinnedTree(original.parents[0].sha), github.pinnedTree(original.sha),
      github.pinnedTree(landed.parents[0].sha), github.pinnedTree(landed.sha),
    ]);
    const paths = treeChanges(before, after);
    if (!isDeepStrictEqual(paths, treeChanges(rewrittenBefore, rewrittenAfter))
        || paths.some(path => !sameEntry(before.get(path), rewrittenBefore.get(path)) ||
          !sameEntry(after.get(path), rewrittenAfter.get(path)))) return null;
    [original, landed] = await Promise.all([github.getCommit(original.parents[0].sha), github.getCommit(landed.parents[0].sha)]);
  }
  return original.sha === sharedBase && await github.contains(sharedBase, landed.sha) ? landed.sha : null;
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
  const history = snapshot.audit.filter(event => event.projectId === project.id && event.contractId === pins[0].contractId);
  const frozen = history.findLast(event => ['contract.frozen', 'contract.unfrozen'].includes(event.kind));
  const active = history.findLast(event => event.kind === 'contract.merged' && event.section === 'product');
  const approvedAt = snapshot.audit.findIndex(event => event.kind === 'decision.recorded' && event.decisionId === decision.id);
  if (active?.mergeCommitSha !== supersedes || active.repository?.toLowerCase() !== project.repository.toLowerCase()
      || approvedAt < 0 || snapshot.audit.indexOf(active) >= approvedAt || frozen?.kind === 'contract.frozen') throw stale();
  if (!active.lockDigest) throw contractPublicationError('contract-drift');
  return active;
}

export function createAdlcContractVerify({ host, engineFor, resolveAdapter, runtimeBindingError }) {
  const queue = table(host.db.namespace, 'adlc_merge_requests');
  const fetch = createHostGitHubTransport(host);
  const reportedMain = new Map();
  let running;

  const save = (row, state, cause, result) => host.db.execute(
    'UPDATE ' + queue + ' SET execution_state=$7, execution_reason=$8,' +
      ' verification_status=COALESCE(verification_status, \'{}\'::jsonb) || $9::jsonb, updated_at=now() WHERE ' + scope + active,
    [...subject(row), state, cause, JSON.stringify(result ?? {})]);

  async function admit(row, project) {
    const snapshot = await new PaperclipStore(host.db, row.company_id).read();
    const run = snapshot?.runs[row.run_id];
    if (!run) return null;
    if (['paused', 'stopped'].includes(run.status)) throw new Error('publication-run-on-hold');
    const decisions = new Map(snapshot.decisions.map(decision => [decision.id, decision]));
    const approved = await resolveCurrentMergeAdmission({ companyId: row.company_id, run, runs: snapshot.runs,
      decisions, project, occurrence: row, resolveAdapter, runtimeBindingError });
    if (approved?.reason) throw new Error(approved.reason);
    return approved ? { ...approved, run, snapshot } : null;
  }

  async function processRow(row, project, profile, app, github) {
    const payload = json(row.request_json).payload;
    const pr = await github.getPull(payload.pullNumber);
    if (!pr.merged && pr.state !== 'open') return;
    const baseSha = await github.mainSha();
    const approved = await admit(row, project);

    const headSha = pr.head.sha;
    const mergeSha = pr.merge_commit_sha;
    async function stillCurrent(compareReceipt = false) {
      const [rowIsActive] = await host.db.query('SELECT fingerprint FROM ' + queue + ' WHERE ' + scope + active, subject(row));
      const config = await host.config.get(row.company_id);
      const { id } = project;
      const latestProject = config?.adlcProjects?.[id];
      if (!rowIsActive || !isDeepStrictEqual(config?.githubApp, app) || !latestProject
          || (latestProject.id !== undefined && latestProject.id !== id)
          || !isDeepStrictEqual({ ...latestProject, id }, project)) return false;
      const current = await admit(row, project);
      if (!approved || !current) return approved === current;
      return !compareReceipt || isDeepStrictEqual(currentReceipt(project, current), currentReceipt(project, approved));
    }

    let parent, plan, cause;
    try {
      if (!approved) throw contractPublicationError('publication-approval-stale');
      if (pr.base.ref !== 'main' || (!pr.merged && pr.draft)) throw differs();
      const receipt = currentReceipt(project, approved);
      const derive = (pinnedMain, revision) => profile({
        binding: { ...approved, currentReceipt: receipt, containsCommit: github.contains },
        project, run: approved.run, section: 'product', pinnedMain,
        readMain: github.readOptionalFile, readApprovedDeliverable: ({ path }) => github.readOptionalFile(path, revision),
      });
      async function expected(pinnedMain, revision) {
        const result = await derive(pinnedMain, revision);
        if (pr.head.ref !== result.branch) throw differs();
        await assertPublicationFiles(github, revision, result);
        return result;
      }
      if (pr.merged) {
        if (!/^[a-f0-9]{40}$/.test(mergeSha) || !await github.contains(mergeSha, baseSha)) {
          throw contractPublicationError('github-main-ancestry-unproven');
        }
        const existing = approved.run.contractMerges?.find(item =>
          item.repository.toLowerCase() === project.repository.toLowerCase() && item.pullNumber === payload.pullNumber);
        if (existing?.lockDigest && existing.mergeCommitSha === mergeSha && existing.decisionId === approved.decision.id) {
          await save(row, 'recorded', null);
          return;
        }
        const commit = await github.getCommit(mergeSha);
        parent = commit.parents[0]?.sha;
        if (!parent) throw differs();
        try {
          plan = await expected(parent, mergeSha);
        } catch (error) {
          if (!publicationMismatch(error)) throw error;
          const originalBase = await rebasedBase(github, pr, commit);
          if (!originalBase) throw error;
          plan = await expected(originalBase, mergeSha);
        }
      } else {
        plan = await expected(baseSha, headSha);
        const mergeBase = await github.mergeBase(baseSha, headSha);
        const changes = treeChanges(await github.pinnedTree(mergeBase), await github.pinnedTree(headSha));
        if (!changes.length || changes.length !== plan.changes.size || changes.some(path => !plan.changes.has(path))) throw differs();
      }
    } catch (error) {
      cause = publicationMismatch(error);
      if (!cause) throw error;
    }

    if (pr.merged) {
      if (!await stillCurrent(!cause)) return;
      if (!cause) {
        const { engine } = await engineFor(row.company_id);
        const { manifest, decision } = approved;
        const mode = await resolveAutomationMode(engine, project, row.run_id, decision.id);
        try {
          await engine.recordContractMerge(row.run_id, {
            repository: project.repository.toLowerCase(), pullNumber: payload.pullNumber, section: 'product',
            mode, decisionId: decision.id, manifestId: manifest.id, revisionId: manifest.revisionId,
            manifestDigest: publicationDigest(manifest.bytes), baseSha: parent, headSha, mergeCommitSha: mergeSha,
            contractId: plan.contractId, supersedes: plan.supersedes, lockDigest: publicationDigest(plan.publication.get(plan.lockPath)),
          });
        } catch (error) {
          cause = publicationMismatch(error);
          if (!cause) throw error;
        }
      }
      const result = await save(row, cause ? 'merged-unverified' : 'recorded', cause ?? null);
      if (cause && result.rowCount === 1) host.logger?.warn('Merged G2 contract could not be verified', { runId: row.run_id, cause });
      return;
    }

    const state = cause ? 'failure' : 'success';
    const description = cause ?? 'Contract verified';
    const key = project.githubRepositoryId + ':' + app.appId + ':' + headSha;
    const result = { state, description };
    const prior = json(row.verification_status)?.[key];
    if (isDeepStrictEqual(prior, result) && row.execution_state === (cause ? 'verification-failed' : 'verified')
        && row.execution_reason === (cause ?? null)) return;
    const latest = await github.getPull(payload.pullNumber);
    if (latest.state !== 'open' || latest.merged || latest.head.sha !== headSha || latest.head.ref !== pr.head.ref
        || latest.base.ref !== pr.base.ref || latest.draft !== pr.draft || await github.mainSha() !== baseSha) return;
    if (!await stillCurrent(!cause)) return;
    if (!isDeepStrictEqual(prior, result)) await github.writeStatus(headSha, state, description);
    await save(row, cause ? 'verification-failed' : 'verified', cause ?? null, { [key]: result });
  }

  async function reportUnapproved(companyId, project, github, main) {
    const snapshot = await new PaperclipStore(host.db, companyId).read();
    const covered = new Set(snapshot?.audit.filter(event => event.kind === 'contract.merged' && event.projectId === project.id &&
      event.repository?.toLowerCase() === project.repository.toLowerCase()).map(event => event.contractId));
    const prefix = contractsRoot(project) + '/';
    const unapproved = [];
    for (const [path, entry] of await github.pinnedTree(main)) {
      if (entry.type !== 'tree' || !path.startsWith(prefix) || path.split('/').length !== prefix.split('/').length + 2) continue;
      let contractId;
      try { ({ contractId } = modelSeatRules.parseContractFolder(path.slice(prefix.length))); }
      catch { continue; }
      if (!covered.has(contractId)) unapproved.push(path);
    }
    const key = JSON.stringify([companyId, project.id, project.githubRepositoryId]);
    const observed = JSON.stringify(unapproved.sort());
    if (reportedMain.get(key) === observed) return;
    for (const folder of unapproved) host.logger?.warn('Unapproved contract folder', { cause: 'contract-unapproved', folder });
    reportedMain.set(key, observed);
  }

  async function scan() {
    const rowsByCompany = Map.groupBy(await host.db.query('SELECT * FROM ' + queue +
      " WHERE kind=$1 AND disposition='admitted'" + active + ' ORDER BY run_id,node_id,attempt_index', [kind]),
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
          githubRepositoryId: project.githubRepositoryId });
        try {
          for (const row of rowsByCompany.get(companyId) ?? []) {
            const request = json(row.request_json);
            if (request.projectId !== id || request.repository !== project.repository.toLowerCase()) continue;
            try { await processRow(row, project, profile, app, github); }
            catch { host.logger?.warn('G2 contract verification will retry', { runId: row.run_id, cause: 'publication-retry' }); }
          }
          await reportUnapproved(companyId, project, github, await github.mainSha());
        } catch {
          host.logger?.warn('G2 repository scan will retry', { cause: 'publication-retry' });
        }
      }
    }
  }

  function tick() {
    running ??= scan().finally(() => { running = undefined; });
    return running;
  }
  return { tick };
}
