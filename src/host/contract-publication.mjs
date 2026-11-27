import { createHash } from 'node:crypto';
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { contractPublicationError } from './contract-publication-causes.mjs';
import { modelSeatRules as pack } from '../plugin/trusted-pack-adapters.mjs';

export const referencePublicationProfileId = 'adlc-g2-reference-v1';
export const publicationDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonicalPublicationJson = value => Buffer.from(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item, 2) + '\n');
const g2Paths = new Map([
  ['prd', 'product/prd.md'], ['acceptance.feature', 'product/acceptance.feature'], ['interaction', 'design/interaction.md'],
]);
const isG2Owned = file => file.section === 'product' || file.path === 'design/interaction.md';
const by = key => (a, b) => a[key] < b[key] ? -1 : Number(a[key] > b[key]);

function requireContract(manifest) {
  try {
    const { type, slug } = manifest.contract;
    if (Object.keys(manifest.contract).length !== 2 || !pack.contractTypes.includes(type)) throw new Error();
    pack.validateContractSlug(slug);
    return { type, slug };
  } catch {
    throw contractPublicationError('contract-type-slug-missing');
  }
}

export function contractProposalLocation({ project, decision, manifest, existing }) {
  const approved = requireContract(manifest);
  const contractId = existing?.contractId ?? pack.contractIdFromDecision(decision.id, project.contractPublication?.contractIdPrefix);
  const folder = existing?.folder ?? pack.contractFolderName({ approvedAt: decision.at, ...approved, contractId });
  const { type, slug } = pack.parseContractFolder(folder);
  const epic = type + '-' + slug;
  return { contractId, folder, branch: 'contract/' + epic + '_' + contractId, epic };
}

export function validatePublicationText(path, bytes) {
  function validateStrings(item) {
    if (typeof item === 'string') pack.validateContractText(Buffer.from(item));
    else if (Array.isArray(item)) item.forEach(validateStrings);
    else if (item && typeof item === 'object') {
      for (const [key, value] of Object.entries(item)) {
        validateStrings(key);
        validateStrings(value);
      }
    }
  }
  try {
    pack.validateContractPath(path);
    pack.validateContractText(bytes);
    if (path.endsWith('.json')) validateStrings(JSON.parse(bytes));
  } catch {
    throw contractPublicationError('contract-not-english');
  }
}

export function publicationCriteria(bytes) {
  try {
    let nextId = 0;
    const parser = new Parser(new AstBuilder(() => String(nextId++)), new GherkinClassicTokenMatcher());
    const { feature } = parser.parse(Buffer.from(bytes).toString('utf8'));
    const scenarios = feature?.children.flatMap(({ scenario, rule }) =>
      rule ? rule.children.map(child => child.scenario).filter(Boolean) : scenario ? [scenario] : []) ?? [];
    const criteria = scenarios.map(scenario => {
      const ids = scenario.tags.map(({ name }) => /^@(AC-[1-9][0-9]*)$/.exec(name)?.[1]).filter(Boolean);
      if (ids.length !== 1) throw new Error();
      return { id: ids[0] };
    });
    if (!criteria.length || new Set(criteria.map(({ id }) => id)).size !== criteria.length) throw new Error();
    return criteria;
  } catch {
    throw contractPublicationError('contract-criteria-invalid');
  }
}

function readIndex(path, bytes, initialId) {
  if (!bytes) throw contractPublicationError('contract-index-invalid');
  validatePublicationText(path, bytes);
  try {
    const index = JSON.parse(bytes);
    if (!Array.isArray(index)) throw new Error();
    if (initialId && index.some(row => typeof row?.contractId === 'string' &&
        row.contractId.toLowerCase() === initialId.toLowerCase())) {
      throw contractPublicationError('contract-id-collision');
    }
    const unique = key => new Set(index.map(row => row[key].toLowerCase())).size === index.length;
    index.forEach(pack.validateContractIndexEntry);
    if (!unique('contractId') || !unique('folder')) throw new Error();
    return index;
  } catch (error) {
    if (error.publicationCause === 'contract-id-collision') throw error;
    throw contractPublicationError('contract-index-invalid');
  }
}

function readLock(path, bytes) {
  if (!bytes) throw contractPublicationError('contract-lock-invalid');
  validatePublicationText(path, bytes);
  try { return pack.validateContractLock(JSON.parse(bytes)); }
  catch { throw contractPublicationError('contract-lock-invalid'); }
}

export async function derivePublication({
  binding, pinnedMain, project, run, section, readApprovedDeliverable, readMain, validatePublicationFormat = pack.validateApprovalManifest,
}) {
  if (section !== 'product') throw contractPublicationError('publication-validator-unavailable');
  const { decision, manifest, currentReceipt, containsCommit } = binding;
  const approved = JSON.parse(manifest.bytes);
  requireContract(approved);
  try { validatePublicationFormat(approved); } catch { throw contractPublicationError('contract-manifest-invalid'); }

  const currentRevision = currentReceipt?.mergeCommitSha ?? null;
  if (approved.supersedes !== currentRevision || (currentReceipt && !await containsCommit(currentRevision, pinnedMain))) {
    throw contractPublicationError('contract-supersedes-stale');
  }

  const root = project.contracts_root ?? project.contractsRoot ?? 'knowledge/contracts';
  const indexPath = root + '/INDEX.json';
  const indexBytes = await readMain(indexPath, pinnedMain);
  const initial = currentReceipt ? null : contractProposalLocation({ project, decision, manifest: approved });
  const index = readIndex(indexPath, indexBytes, initial?.contractId);
  const existing = currentReceipt && index.find(row => row.contractId === currentReceipt.contractId && row.status === 'active');
  if (currentReceipt && !existing) throw contractPublicationError('contract-supersedes-stale');
  const { contractId, folder, epic } = initial ?? contractProposalLocation({ project, decision, manifest: approved, existing });
  const fullPath = path => root + '/' + folder + '/' + path;
  const lockPath = fullPath('contract.lock.json');
  const oldLockBytes = await readMain(lockPath, pinnedMain);
  let oldLock;
  if (existing) {
    oldLock = readLock(lockPath, oldLockBytes);
    const approval = oldLock.sections?.product?.approvalManifest ?? oldLock.approvalManifest;
    const proven = readLock(lockPath, await readMain(lockPath, currentRevision));
    if (oldLock.contractId !== contractId || oldLock.epic !== epic || approval.id !== currentReceipt.manifestId
        || approval.revisionId !== currentReceipt.revisionId || approval.digest !== currentReceipt.manifestDigest
        || (oldLock.sections?.product?.supersedes ?? oldLock.supersedes) !== currentReceipt.supersedes
        || !canonicalPublicationJson(oldLock.files.filter(isG2Owned)).equals(canonicalPublicationJson(proven.files.filter(isG2Owned)))) {
      throw contractPublicationError('contract-supersedes-stale');
    }
    for (const { path, digest } of oldLock.files) {
      const bytes = await readMain(fullPath(path), pinnedMain);
      if (!bytes || publicationDigest(bytes) !== digest) throw contractPublicationError('contract-lock-invalid');
      validatePublicationText(fullPath(path), bytes);
    }
  } else if (oldLockBytes) {
    throw contractPublicationError('contract-id-collision');
  }

  const deliverables = new Map();
  const files = new Map();
  for (const { key, revisionId, digest } of approved.deliverables) {
    const path = g2Paths.get(key);
    if (!path) throw contractPublicationError('contract-deliverable-invalid');
    const bytes = await readApprovedDeliverable({ key, revisionId, path: fullPath(path), digest });
    if (bytes == null || publicationDigest(bytes) !== digest) {
      throw contractPublicationError('contract-deliverable-invalid');
    }
    validatePublicationText(fullPath(path), bytes);
    deliverables.set(key, bytes);
    files.set(path, bytes);
  }
  files.set('product/criteria.json', canonicalPublicationJson(publicationCriteria(deliverables.get('acceptance.feature'))));
  const priorFiles = oldLock?.files ?? [];
  if (priorFiles.some(file => isG2Owned(file) && !files.has(file.path))) {
    throw contractPublicationError('contract-deliverable-invalid');
  }
  const approvalManifest = { id: manifest.id, revisionId: manifest.revisionId, digest: publicationDigest(manifest.bytes) };
  const sectionEvidence = { approvalManifest, decisionId: decision.id,
    approvedAt: new Date(decision.at).toISOString(), supersedes: currentRevision };
  const lock = {
    ...oldLock, contractId, epic, backlogItemRef: run.input.backlogItemRef, approvalManifest, supersedes: currentRevision,
    sections: { ...oldLock?.sections, product: sectionEvidence },
    files: [...priorFiles.filter(file => !isG2Owned(file)), ...Array.from(files, ([path, bytes]) =>
      ({ path, section: path.split('/')[0], digest: publicationDigest(bytes) }))].sort(by('path')),
  };
  try { pack.validateContractLock(lock); } catch { throw contractPublicationError('contract-lock-invalid'); }
  if (!existing) index.push(pack.validateContractIndexEntry({ contractId, folder, status: 'active' }));
  index.sort(by('contractId'));

  const changes = new Map();
  const candidates = [...Array.from(files, ([path, bytes]) => [fullPath(path), bytes]),
    [lockPath, canonicalPublicationJson(lock)], [indexPath, canonicalPublicationJson(index)]];
  const ciPaths = (project.ciPaths ?? []).map(path => path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase());
  for (const [path, bytes] of candidates) {
    validatePublicationText(path, bytes);
    const before = path === indexPath ? indexBytes : path === lockPath ? oldLockBytes : await readMain(path, pinnedMain);
    if (!existing && before && path !== indexPath) throw contractPublicationError('contract-id-collision');
    if (!before || !Buffer.from(bytes).equals(Buffer.from(before))) {
      const folded = path.toLowerCase();
      if (ciPaths.some(prefix => folded === prefix || folded.startsWith(prefix + '/'))) {
        throw contractPublicationError('contract-proposal-differs');
      }
      changes.set(path, bytes);
    }
  }
  return { contractId, currentRevision, supersedes: approved.supersedes, deliverables, changes };
}

export function resolveReferencePublicationProfile(id, section) {
  if (id !== referencePublicationProfileId || section !== 'product' ||
      typeof pack.contractIdFromDecision !== 'function') return null;
  return ({ binding, project, run }) => ({
    recompute(input, { readFile, readHeadFile, containsCommit }) {
      async function readOptional(read, ...args) {
        try { return await read(...args); } catch (error) { if (error.status !== 404) throw error; return null; }
      }
      return derivePublication({
        binding: { ...binding, containsCommit }, pinnedMain: input.baseSha, project, run, section: input.section,
        readMain: (path, ref) => readOptional(readFile, path, ref),
        readApprovedDeliverable: ({ path }) => readOptional(readHeadFile, path),
      });
    },
  });
}
