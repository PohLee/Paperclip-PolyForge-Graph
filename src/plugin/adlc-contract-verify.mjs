import { isDeepStrictEqual } from 'node:util';
import { authorizedDecision } from '../host/contract-publication-authorization.mjs';
import { resolveAutomationMode } from '../host/automation-mode.mjs';
import { contractPublicationError, publicationMismatch, publicationRetryCause } from '../host/contract-publication-causes.mjs';
import { canonicalPublicationJson, publicationDigest, readContractReceiptBinding, readPublicationEntry, resolveReferencePublicationProfile } from '../host/contract-publication.mjs';
import { contractStatusContext, createGitHubAppAdapter } from '../host/github-app.mjs';
import { modelSeatRules } from './trusted-pack-adapters.mjs';
import { normalizedPins, resolveCurrentMergeAdmission } from './adlc-merge-discovery.mjs';
import { githubAppConfigErrors, validGitHubApp } from './github-app-config.mjs';
import { createHostGitHubTransport } from './github-http-transport.mjs';
import { createInstallationTokenProvider } from './github-installation-token.mjs';
import { listGraphCompanies, PaperclipStore, table } from './store.mjs';

const publications = {
  contract_publication_request: { section: 'product', gate: 'g2', context: contractStatusContext },
  design_publication_request: { section: 'design', gate: 'g3', context: 'polyforge/contract-g3' },
  technical_publication_request: { section: 'technical', gate: 'g4', context: 'polyforge/contract-g4' },
};
const differs = () => contractPublicationError('contract-proposal-differs');
const subject = row => [row.company_id, row.run_id, row.node_id, row.attempt_index, row.kind, row.fingerprint];
const identity = 'company_id=$1 AND run_id=$2 AND node_id=$3 AND attempt_index=$4 AND kind=$5 AND fingerprint=$6';
const scope = identity + " AND disposition='admitted'";
const active = " AND (execution_state IS NULL OR execution_state IN ('verified','verification-failed'))";
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const statusPrefix = (project, app) => project.githubRepositoryId + ':' + app.appId + ':';
const contractsRoot = project => project.contracts_root ?? project.contractsRoot ?? 'knowledge/contracts';
const sameEntry = (a, b) => a?.sha === b?.sha && a?.type === b?.type && a?.mode === b?.mode;

export async function assertContractPublication(entries, readFile, plan, section = 'product') {
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
  const entry = readPublicationEntry(await readFile(plan.indexPath), plan.contractId, { canonical: section === 'product' });
  if (!entry || !canonicalPublicationJson(entry).equals(canonicalPublicationJson(plan.indexEntry))) throw differs();
}

async function verifyProspectiveMerge(github, main, head, plan, section) {
  const base = await github.mergeBase(main, head);
  const [paths, before, branch, current] = await Promise.all([
    github.pullChanges(base, head), github.pinnedTree(base), github.pinnedTree(head), github.pinnedTree(main),
  ]);
  const allowed = section === 'product' ? plan.publication : plan.changes;
  if (!paths.length || paths.some(path => !allowed.has(path))) throw differs();
  const result = new Map(current);
  const removed = [];
  let mergedIndex;
  for (const path of paths) {
    const entry = branch.get(path);
    if (plan.changes.get(path) === null) {
      if ((entry && entry.type !== 'tree') || (current.has(path) && !sameEntry(current.get(path), before.get(path)))) {
        throw differs();
      }
      result.delete(path);
      removed.push(path);
      continue;
    }
    if (!entry || entry.type !== 'blob' || entry.mode !== '100644') throw differs();
    if (path === plan.indexPath) {
      const headBytes = await github.readEntry(entry);
      const target = readPublicationEntry(headBytes, plan.contractId, { canonical: true });
      if (!isDeepStrictEqual(target, plan.indexEntry)) throw differs();
      const beforeBytes = await github.readEntry(before.get(path));
      if (beforeBytes) readPublicationEntry(beforeBytes, plan.contractId);
      const otherEntries = bytes => (bytes ? JSON.parse(bytes) : []).filter(row => row?.contractId !== plan.contractId);
      if (!isDeepStrictEqual(otherEntries(headBytes), otherEntries(beforeBytes))) throw differs();
      mergedIndex = plan.supersedes ? headBytes : plan.publication.get(path);
    } else if (!sameEntry(current.get(path), before.get(path)) && !sameEntry(current.get(path), entry)) {
      throw differs();
    }
    result.set(path, entry);
  }
  // A Git directory disappears with its last file.
  for (const path of removed) {
    let parent = path.slice(0, path.lastIndexOf('/'));
    while (result.get(parent)?.type === 'tree' && !Array.from(result.keys()).some(child => child.startsWith(parent + '/'))) {
      result.delete(parent);
      parent = parent.slice(0, parent.lastIndexOf('/'));
    }
  }
  await assertContractPublication(result, path => path === plan.indexPath && mergedIndex
    ? mergedIndex : github.readEntry(result.get(path)), plan, section);
}

async function landedOnMain(github, mergeSha, mainSha) {
  if (!/^[a-f0-9]{40}$/.test(mergeSha)) return false;
  try { return await github.contains(mergeSha, mainSha); }
  catch (error) {
    if (error.code === 'github-request-unavailable' && error.status === 404) return false;
    throw error;
  }
}

function pinnedProduct(pins) {
  const product = normalizedPins(pins) && pins.filter(pin => pin.section === 'product');
  return product?.length === 1 ? product[0] : null;
}

function productPin(run) {
  const pin = pinnedProduct(run.input.contract_pins);
  if (!pin) throw contractPublicationError('contract-product-missing');
  return pin;
}

function queuedContractId({ row, section, payload, project }, snapshot) {
  const run = snapshot?.runs[row.run_id];
  if (!run) return;
  const pins = run.input.contract_pins;
  if (section === 'product' && !pins?.length && typeof payload.decisionId === 'string' && payload.decisionId.trim()) {
    return modelSeatRules.contractIdFromDecision(payload.decisionId, project.contractPublication.contractIdPrefix);
  }
  return pinnedProduct(pins)?.contractId;
}

function projectReceipts(project, snapshot) {
  return snapshot.audit.filter(event => event.kind === 'contract.merged' && event.projectId === project.id &&
    event.repository?.toLowerCase() === project.repository.toLowerCase());
}

function sectionReceipts(project, { run, decision, snapshot }, section) {
  const pin = productPin(run);
  const receipts = projectReceipts(project, snapshot);
  const history = receipts.filter(event => event.contractId === pin.contractId);
  const currentReceipt = history.findLast(event => event.section === 'product');
  const sectionReceipt = history.findLast(event => event.section === section);
  if (!currentReceipt) throw contractPublicationError('contract-product-missing');
  const stale = () => contractPublicationError('contract-supersedes-stale');
  const lastPinUpdate = snapshot.audit.findLastIndex(event => event.kind === 'run.contract_pins_updated' && event.runId === run.id);
  const approvedAt = snapshot.audit.findLastIndex(event => event.kind === 'decision.recorded'
    && event.runId === run.id && event.decisionId === decision.id);
  if (currentReceipt.mergeCommitSha !== pin.commit || lastPinUpdate > approvedAt ||
      (sectionReceipt && snapshot.audit.indexOf(sectionReceipt) > approvedAt) ||
      (run.contract_pins !== undefined &&
        !isDeepStrictEqual(normalizedPins(run.contract_pins), normalizedPins(run.input.contract_pins)))) throw stale();
  for (const { section, contractId, commit } of run.input.contract_pins) {
    const current = receipts.findLast(event => event.contractId === contractId && event.section === section);
    if (current?.mergeCommitSha !== commit ||
        receipts.some(event => event.contractId === contractId && event.section === section && event.supersedes === commit)) {
      throw stale();
    }
  }
  return { currentReceipt, latestReceipt: history.at(-1), sectionReceipt };
}

function currentReceipt(project, approved, section) {
  if (section !== 'product') return sectionReceipts(project, approved, section);
  const { supersedes } = JSON.parse(approved.manifest.bytes);
  const { run, decision, snapshot } = approved;
  const stale = () => contractPublicationError('contract-supersedes-stale');
  if (supersedes === null) {
    if (run.contract_pins?.length || run.input.contract_pins?.length) throw stale();
    return null;
  }
  const pins = run.contract_pins?.filter(pin => pin.section === 'product' && pin.commit === supersedes) ?? [];
  if (pins.length !== 1 || !isDeepStrictEqual(run.contract_pins, run.input.contract_pins)) throw stale();
  const publications = projectReceipts(project, snapshot);
  const history = publications.filter(event => event.contractId === pins[0].contractId);
  const active = history.findLast(event => event.section === 'product');
  const approvedAt = snapshot.audit.findIndex(event => event.kind === 'decision.recorded' && event.decisionId === decision.id);
  if (active?.mergeCommitSha !== supersedes || approvedAt < 0 || snapshot.audit.indexOf(active) >= approvedAt ||
      publications.some(event => event.section === 'product' && event.supersedes === supersedes)) throw stale();
  return { currentReceipt: active, latestReceipt: history.at(-1) };
}

export function createAdlcContractVerify({ host, engineFor, resolveAdapter, runtimeBindingError }) {
  const queue = table(host.db.namespace, 'adlc_merge_requests');
  const postedStatuses = table(host.db.namespace, 'adlc_contract_statuses');
  const fetch = createHostGitHubTransport(host);
  const reportedMain = new Map();
  let running;

  const save = (row, state, cause, result, reconcile = false) => host.db.execute(
    'UPDATE ' + queue + ' SET execution_state=$7, execution_reason=$8,' +
      ' verification_status=COALESCE(verification_status, \'{}\'::jsonb) || $9::jsonb, updated_at=now() WHERE ' + (reconcile ? identity : scope) + active,
    [...subject(row), state, cause, JSON.stringify(result ?? {})]);

  async function admit(row, project, snapshot, section, mode) {
    const run = snapshot?.runs[row.run_id];
    if (!run || row.disposition !== 'admitted') throw contractPublicationError('publication-approval-stale');
    if (['paused', 'stopped'].includes(run.status)) throw contractPublicationError('publication-run-on-hold');
    if (section !== 'product') productPin(run);
    const pins = section === 'product' ? run.contract_pins : run.input.contract_pins;
    if (pins?.some(pin => snapshot.audit.findLast(event => event.projectId === project.id
        && event.contractId === pin.contractId && ['contract.frozen', 'contract.unfrozen'].includes(event.kind))
        ?.kind === 'contract.frozen')) throw contractPublicationError('publication-run-on-hold');
    const decisions = new Map(snapshot.decisions.map(decision => [decision.id, decision]));
    const approved = await resolveCurrentMergeAdmission({ companyId: row.company_id, run, runs: snapshot.runs,
      decisions, project, occurrence: row, resolveAdapter, runtimeBindingError });
    if (approved?.reason) throw contractPublicationError(approved.reason);
    if (!approved) throw contractPublicationError(section === 'product' ? 'publication-approval-stale' : 'publication-unauthorized');
    if (section !== 'product') {
      const { decision, manifest } = approved;
      const audit = decision.candidateBinding.audit;
      const auditBytes = audit?.bytes && Buffer.from(audit.bytes, 'base64');
      authorizedDecision(run, snapshot.decisions, project, section, decision.id, manifest, mode,
        auditBytes && publicationDigest(auditBytes) === audit.digest ? auditBytes : null);
    }
    return { ...approved, run, snapshot };
  }

  async function hasUnrecordedAncestor(item, mergeSha, merged, snapshot) {
    if (!/^[a-f0-9]{40}$/.test(mergeSha)) return false;
    const { row, project, github } = item;
    const peers = merged.filter(peer => peer !== item && peer.row.company_id === row.company_id &&
      peer.project.id === project.id && peer.project.githubRepositoryId === project.githubRepositoryId &&
      peer.pr.merge_commit_sha !== mergeSha);
    if (!peers.length) return false;
    const contractId = queuedContractId(item, snapshot);
    if (!contractId) return false;
    const receipts = projectReceipts(project, snapshot);
    for (const peer of peers) {
      const ancestor = peer.pr.merge_commit_sha;
      if (queuedContractId(peer, snapshot) !== contractId ||
          receipts.some(event => event.pullNumber === peer.payload.pullNumber && event.mergeCommitSha === ancestor)) continue;
      if (await landedOnMain(github, ancestor, mergeSha)) return true;
    }
    return false;
  }

  async function processRow(item, statuses, pending, merged) {
    const { row, payload, history, project, profile, app, github, section, gate, pr: preparedPull } = item;
    const { pullNumber, decisionId } = payload;
    const prefix = statusPrefix(project, app);
    const recordStatus = (sha, cause, { eligible = true, terminal = false } = {}) => {
      const key = prefix + sha;
      const target = { row, github, sha, key, eligible, terminal,
        result: { state: cause ? 'failure' : 'success', description: cause ?? 'Contract verified' } };
      if (!statuses.has(key)) statuses.set(key, []);
      statuses.get(key).push(target);
    };
    const withdraw = (cause, { exceptSha, terminal = false } = {}) => {
      const keys = [];
      for (const [key, prior] of Object.entries(history)) {
        if (key.startsWith(prefix) && key !== prefix + exceptSha &&
            (prior.state === 'success' || pending.get(key)?.desired_state === 'success')) {
          recordStatus(key.slice(prefix.length), cause, { eligible: false, terminal });
          keys.push(key);
        }
      }
      return keys;
    };

    const store = new PaperclipStore(host.db, row.company_id);
    let snapshot = await store.read();
    const existing = snapshot?.audit.find(event => event.kind === 'contract.merged'
      && event.repository?.toLowerCase() === project.repository.toLowerCase() && event.pullNumber === pullNumber);
    const recordedDecision = existing?.decisionId === decisionId && existing.section === section && Boolean(existing.lockDigest);
    if (row.disposition !== 'admitted' && !recordedDecision) {
      withdraw('publication-approval-stale');
      return;
    }
    const pr = preparedPull ?? await github.getPull(pullNumber);
    const { sha: headSha } = pr.head;
    const mergeSha = pr.merge_commit_sha;
    if (pr.merged && recordedDecision && existing.mergeCommitSha === mergeSha) {
      const binding = await readContractReceiptBinding({ contractId: existing.contractId, mergeCommitSha: mergeSha,
        contractsRoot: contractsRoot(project) }, github.readOptionalFile);
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
      const mode = project.automationMode === 'full-auto' && project.allowFullAuto !== true
        ? 'manual' : project.automationMode;
      try { await admit(row, project, snapshot, section, mode); }
      catch (error) {
        const cause = publicationMismatch(error);
        if (!cause) throw error;
        withdraw(cause);
      }
      return;
    }

    let approved, baseSha, plan, cause, mode, engine, receipts;
    try {
      if (pr.merged && existing) throw contractPublicationError('github-pull-already-recorded');
      if (pr.merged || section !== 'product') {
        // Mode resolution can write a downgrade event before verification starts.
        const run = snapshot?.runs[row.run_id];
        if (run && !['paused', 'stopped'].includes(run.status)) {
          ({ engine } = await engineFor(row.company_id));
          mode = await resolveAutomationMode(engine, project, row.run_id, decisionId);
          snapshot = await store.read();
        }
      }
      approved = await admit(row, project, snapshot, section, mode);
      if (pr.base.ref !== 'main' || (!pr.merged && pr.draft)) throw differs();
      baseSha = await github.mainSha();
      if (pr.merged && !await landedOnMain(github, mergeSha, baseSha)) {
        const key = 'ancestry:' + mergeSha;
        const count = (history[key] ?? 0) + 1;
        if (count <= 10) await save(row, row.execution_state, 'github-main-ancestry-unproven', { [key]: count });
        throw contractPublicationError('github-main-ancestry-unproven');
      }
      receipts = currentReceipt(project, approved, section);
      const revision = pr.merged && section === 'product' ? mergeSha : headSha;
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
        project, run: approved.run, section, pinnedMain: baseline, readMain,
        readApprovedDeliverable: ({ path }) => github.readOptionalFile(path, revision),
      });
      if (pr.head.ref !== plan.branch) throw differs();
      if (pr.merged) {
        await assertContractPublication(await github.pinnedTree(mergeSha),
          path => github.readOptionalFile(path, mergeSha), plan, section);
      } else {
        await verifyProspectiveMerge(github, baseSha, headSha, plan, section);
      }
    } catch (error) {
      cause = publicationMismatch(error);
      if (!cause || (cause === 'github-main-ancestry-unproven' && (history['ancestry:' + mergeSha] ?? 0) < 10)) throw error;
    }

    if (!pr.merged) {
      const latest = await github.getPull(pullNumber);
      if (latest.state !== 'open' || latest.merged || latest.head.sha !== headSha || latest.head.ref !== pr.head.ref
          || latest.base.ref !== pr.base.ref || latest.draft !== pr.draft || (baseSha && await github.mainSha() !== baseSha)) return 'deferred';
    }

    const [rowIsActive] = await host.db.query('SELECT fingerprint FROM ' + queue + ' WHERE ' + scope + active, subject(row));
    const config = await host.config.get(row.company_id);
    const { id } = project;
    const latestProject = config?.adlcProjects?.[id];
    if (!rowIsActive || !isDeepStrictEqual(config?.githubApp, app) || !latestProject
        || (latestProject.id !== undefined && latestProject.id !== id)
        || !isDeepStrictEqual({ ...latestProject, id }, project)) return 'deferred';
    if (pr.merged) {
      if (!cause) {
        const { manifest } = approved;
        const publication = {
          repository: project.repository.toLowerCase(), pullNumber, section, mode, decisionId,
          manifestId: manifest.id, revisionId: manifest.revisionId, manifestDigest: publicationDigest(manifest.bytes),
          baseSha, headSha, mergeCommitSha: mergeSha, contractId: plan.contractId, supersedes: plan.supersedes,
          folder: plan.folder, lockDigest: publicationDigest(plan.publication.get(plan.lockPath)),
        };
        try {
          for (let attempt = 0; ; attempt++) {
            const current = await store.read();
            if (current?.revision !== snapshot.revision) {
              const recorded = current?.audit.find(event => event.kind === 'contract.merged'
                && event.repository?.toLowerCase() === publication.repository && event.pullNumber === pullNumber);
              if (recorded) {
                if (recorded.decisionId === decisionId && recorded.section === section && recorded.mergeCommitSha === mergeSha
                    && recorded.lockDigest === publication.lockDigest && recorded.folder === publication.folder) break;
                throw contractPublicationError('github-pull-already-recorded');
              }
              const readmitted = await admit(row, project, current, section, mode);
              if (!isDeepStrictEqual(readmitted.manifest, manifest)) {
                throw contractPublicationError('publication-approval-stale');
              }
              if (!isDeepStrictEqual(currentReceipt(project, readmitted, section), receipts)) {
                throw contractPublicationError('publication-revision-changed');
              }
              snapshot = current;
            }
            try {
              await engine.recordContractMerge(row.run_id, publication, snapshot.revision);
              break;
            } catch (error) {
              if (error.publicationCause !== 'publication-revision-changed' || attempt === 2) throw error;
            }
          }
        } catch (error) {
          cause = publicationMismatch(error);
          if (!cause) throw error;
        }
      }
      const finish = async () => {
        const result = await save(row, cause ? 'merged-unverified' : 'recorded', cause ?? null);
        if (cause && result.rowCount === 1) host.logger?.warn('Merged ' + gate.toUpperCase() + ' contract could not be verified', { runId: row.run_id, cause });
      };
      if (cause) {
        if (cause === 'publication-run-on-hold' && (await store.read())?.runs[row.run_id]?.status !== 'stopped') {
          withdraw(cause);
          return;
        }
        // A receipted ancestor may supply the baseline for this landed tree.
        if (await hasUnrecordedAncestor(item, mergeSha, merged, snapshot)) return 'deferred';
        return { keys: withdraw(cause, { terminal: true }), finish };
      }
      await finish();
      return;
    }

    if (!cause) {
      const current = await store.read();
      if (current?.revision !== snapshot?.revision) {
        try {
          const readmitted = await admit(row, project, current, section, mode);
          if (!isDeepStrictEqual(readmitted.manifest, approved.manifest)) throw contractPublicationError('publication-approval-stale');
          if (!isDeepStrictEqual(currentReceipt(project, readmitted, section), receipts)) return 'deferred';
        } catch (error) {
          cause = publicationMismatch(error);
          if (!cause) throw error;
        }
      }
    }
    recordStatus(headSha, cause);
    if (['publication-run-on-hold', 'publication-approval-stale', 'publication-unauthorized'].includes(cause) ||
        (section !== 'product' && ['contract-product-missing', 'contract-supersedes-stale'].includes(cause))) {
      withdraw(cause, { exceptSha: headSha });
    }
  }

  const saveStatusLink = (row, key, status) => host.db.execute('UPDATE ' + queue +
    " SET verification_status=COALESCE(verification_status, '{}'::jsonb) || $7::jsonb WHERE " + identity,
    [...subject(row), JSON.stringify({ [key]: status })]);

  const statusKey = (group, sha) => [group.repositoryId, group.appId, sha, group.context];

  async function postStatus(group, key, result, preferred = group.projects[0].github) {
    const adapters = new Set([preferred, ...group.projects.map(project => project.github)]);
    let sendError;
    for (const github of adapters) {
      try { await github.writeStatus(key[2], result.state, result.description, key[3]); }
      catch (error) {
        sendError = error;
        continue;
      }
      await host.db.execute('UPDATE ' + postedStatuses +
        ' SET pending=(desired_state IS DISTINCT FROM $5 OR desired_description IS DISTINCT FROM $6),' +
        ' state=$5, description=$6 WHERE repository_id=$1 AND app_id=$2 AND head_sha=$3 AND context=$4',
      [...key, result.state, result.description]);
      return;
    }
    throw sendError;
  }

  async function writeStatus(group, targets, deferred, unknownHead) {
    const preferred = targets.filter(target => target.eligible || target.terminal);
    const options = preferred.length ? preferred : targets;
    const { github, sha, result } = options.find(target => target.result.state === 'failure') ?? options[0];
    // A terminal withdrawal proceeds even while another row sharing the head is deferred.
    if ((!preferred.length && deferred) || (result.state === 'success' && (deferred || unknownHead))) return false;
    const key = statusKey(group, sha);
    let durable = false;
    try {
      if (result.state === 'success') {
        for (const { row, key, result: individual } of targets) {
          if (isDeepStrictEqual(json(row.verification_status)?.[key], individual)) continue;
          const saved = await saveStatusLink(row, key, individual);
          if (saved.rowCount !== 1) return false;
        }
      }
      const [posted] = await host.db.query('SELECT pending, state, description FROM ' + postedStatuses +
        ' WHERE repository_id=$1 AND app_id=$2 AND head_sha=$3 AND context=$4', key);
      if (!posted || posted.pending || posted.state !== result.state || posted.description !== result.description) {
        await host.db.execute('INSERT INTO ' + postedStatuses +
          ' (repository_id, app_id, head_sha, context, pending, desired_state, desired_description) VALUES ($1,$2,$3,$4,true,$5,$6)' +
          ' ON CONFLICT (repository_id, app_id, head_sha, context) DO UPDATE SET pending=true,' +
          ' desired_state=EXCLUDED.desired_state, desired_description=EXCLUDED.desired_description',
        [...key, result.state, result.description]);
        durable = true;
        await postStatus(group, key, result, github);
      }
    } catch (error) {
      host.logger?.warn(group.gate.toUpperCase() + ' commit status will retry', { runId: options[0].row.run_id, cause: publicationRetryCause(error) });
      return durable;
    }
    for (const { row, key, eligible, result: individual } of targets) {
      try {
        const failed = individual.state === 'failure';
        const state = failed ? 'verification-failed' : 'verified';
        const cause = failed ? individual.description : null;
        const initial = json(row.verification_status)?.[key];
        if (isDeepStrictEqual(initial, individual) &&
            (!eligible || (row.execution_state === state && row.execution_reason === cause))) continue;
        if (eligible) {
          await save(row, state, cause, { [key]: individual });
        } else if (result.state !== 'success') {
          await saveStatusLink(row, key, individual);
        }
      } catch (error) {
        warnRow(row, error);
      }
    }
    return true;
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

  function warnRow(row, error) {
    host.logger?.warn(publications[row.kind].gate.toUpperCase() + ' contract verification will retry', { runId: row.run_id, cause: publicationRetryCause(error) });
  }

  async function observePulls(group) {
    const { work, prefix } = group;
    for (const item of work) {
      const { row, github, payload, history } = item;
      item.keys = new Set(Object.keys(history).filter(key => key.startsWith(prefix)));
      if (row.disposition === 'admitted') {
        try {
          item.pr = await github.getPull(payload.pullNumber);
          item.keys.add(prefix + item.pr.head.sha);
        } catch (error) {
          item.failed = true;
          if (error.status !== 404) group.unknownHead = true;
          warnRow(row, error);
        }
      }
    }
  }

  async function scanRepository(group, merged) {
    const { work, projects, prefix, unknownHead } = group;
    const pending = new Map((await host.db.query('SELECT head_sha, desired_state, desired_description FROM ' + postedStatuses +
      ' WHERE repository_id=$1 AND app_id=$2 AND context=$3 AND pending=true',
    [group.repositoryId, group.appId, group.context])).map(status => [prefix + status.head_sha, status]));
    const counts = new Map(), statuses = new Map(), deferred = new Set();
    const handled = new Set(), durable = new Set(), terminal = [];
    for (const { keys } of work) {
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const item of work) {
      let retry = item.failed;
      try {
        if (!retry) {
          const result = await processRow(item, statuses, pending, merged);
          retry = result === 'deferred';
          if (result?.finish) terminal.push({ row: item.row, ...result });
        }
      } catch (error) {
        retry = true;
        warnRow(item.row, error);
      }
      for (const key of item.keys) {
        if (retry) deferred.add(key);
        counts.set(key, counts.get(key) - 1);
        if (counts.get(key) === 0 && statuses.has(key)) {
          handled.add(key);
          if (await writeStatus(group, statuses.get(key), deferred.has(key), unknownHead)) durable.add(key);
          statuses.delete(key);
        }
      }
    }
    for (const [key, status] of pending) {
      // Only the current scan's verified rows can authorize a success POST.
      if (handled.has(key) || deferred.has(key) || status.desired_state === 'success') continue;
      try {
        await postStatus(group, statusKey(group, status.head_sha),
          { state: status.desired_state, description: status.desired_description });
      } catch (error) {
        host.logger?.warn(group.gate.toUpperCase() + ' commit status will retry', { cause: publicationRetryCause(error) });
      }
    }
    for (const { row, keys, finish } of terminal) {
      if (keys.every(key => durable.has(key))) {
        try { await finish(); }
        catch (error) { warnRow(row, error); }
      }
    }
    for (const { companyId, project, github } of projects) {
      try { await reportUnapproved(companyId, project, github, await github.mainSha()); }
      catch (error) {
        host.logger?.warn('Contract repository scan will retry', { cause: publicationRetryCause(error) });
      }
    }
  }

  async function scan() {
    const groups = new Map();
    const rowsByCompany = Map.groupBy(await host.db.query('SELECT * FROM ' + queue +
      " WHERE kind IN ($1,$2,$3) AND (disposition IN ('admitted','rejected-admission') OR verification_status IS NOT NULL)" +
      active + ' ORDER BY run_id,node_id,attempt_index', Object.keys(publications)),
    row => row.company_id);
    for (const companyId of await listGraphCompanies(host.db)) {
      let config;
      try { config = await host.config.get(companyId); }
      catch {
        host.logger?.warn('Contract project configuration will retry', { cause: 'publication-retry' });
        continue;
      }
      const app = config?.githubApp;
      if (!validGitHubApp(app)) continue;
      const installationTokenProvider = createInstallationTokenProvider({ host, companyId, app, fetch });
      for (const [id, value] of Object.entries(config.adlcProjects ?? {})) {
        if (!Object.values(publications).some(({ gate }) => value?.contractPublication?.[gate] === true)
            || (value.id !== undefined && value.id !== id)
            || githubAppConfigErrors({ githubApp: app, adlcProjects: { [id]: value } }).length) continue;
        const project = { ...value, id };
        if (!modelSeatRules.isContractsRoot(contractsRoot(project))) continue;
        const github = createGitHubAppAdapter({ fetch, installationTokenProvider, repository: project.repository,
          githubRepositoryId: project.githubRepositoryId, contractsRoot: contractsRoot(project) });
        const prefix = statusPrefix(project, app);
        for (const [kind, { section, gate, context }] of Object.entries(publications)) {
          if (project.contractPublication[gate] !== true) continue;
          const profile = resolveReferencePublicationProfile(project.contractPublication.validatorId, section);
          if (!profile) continue;
          const key = prefix + context;
          if (!groups.has(key)) groups.set(key, {
            repositoryId: project.githubRepositoryId, appId: app.appId, prefix, context, gate, work: [], projects: [],
          });
          const group = groups.get(key);
          group.projects.push({ companyId, project, github });
          for (const row of rowsByCompany.get(companyId) ?? []) {
            if (row.kind !== kind) continue;
            try {
              const request = json(row.request_json);
              const payload = request?.payload;
              if (!payload || request?.projectId !== id || request.repository !== project.repository.toLowerCase()) continue;
              group.work.push({ row, payload, project, profile, app, github, section, gate, history: json(row.verification_status) ?? {} });
            } catch (error) {
              warnRow(row, error);
            }
          }
        }
      }
    }
    // Observe every gate before evaluating rows so a later group can supply a
    // predecessor even if its verification must retry.
    for (const group of groups.values()) await observePulls(group);
    const merged = [...groups.values()].flatMap(group => group.work.filter(item => item.pr?.merged));
    for (const group of groups.values()) await scanRepository(group, merged);
  }

  function tick() {
    running ??= scan().finally(() => { running = undefined; });
    return running;
  }
  return { tick };
}
