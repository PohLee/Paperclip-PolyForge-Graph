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
  ['prd', 'product/prd.md'], ['acceptance.feature', 'product/acceptance.feature'], ['interaction-design', 'design/interaction.md'],
]);
const isG2Owned = file => file.section === 'product' || file.path === 'design/interaction.md';
const by = key => (a, b) => a[key] < b[key] ? -1 : Number(a[key] > b[key]);

function requireContract(manifest, epicTitle) {
  try {
    const { type } = manifest.contract;
    if (Object.keys(manifest.contract).some(key => !['type', 'slug'].includes(key)) || !pack.contractTypes.includes(type)) throw new Error();
    const slug = Object.hasOwn(manifest.contract, 'slug')
      ? pack.validateContractSlug(manifest.contract.slug) : pack.deriveContractSlug(epicTitle);
    return { type, slug };
  } catch {
    throw contractPublicationError('contract-type-slug-missing');
  }
}

export function contractProposalLocation({ project, decision, manifest, existing, epicTitle }) {
  const approved = requireContract(manifest, epicTitle);
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
  let index;
  try {
    index = JSON.parse(bytes);
  } catch {
    throw contractPublicationError('contract-index-invalid');
  }
  validatePublicationText(path, bytes);
  try {
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
  let lock;
  try { lock = JSON.parse(bytes); }
  catch { throw contractPublicationError('contract-lock-invalid'); }
  validatePublicationText(path, bytes);
  try { return pack.validateContractLock(lock); }
  catch { throw contractPublicationError('contract-lock-invalid'); }
}

function indexEntry(index, contractId) {
  const id = contractId.toLowerCase();
  const matches = index.filter(row => typeof row?.contractId === 'string' && row.contractId.toLowerCase() === id);
  const [entry] = matches;
  if (matches.length !== 1 || entry.contractId !== contractId || entry.status !== 'active') return null;
  try { pack.validateContractIndexEntry(entry); }
  catch { return null; }
  return entry;
}

export function readPublicationEntry(bytes, contractId, { canonical = false } = {}) {
  let index;
  try { index = JSON.parse(bytes); }
  catch { throw contractPublicationError('contract-index-invalid'); }
  if (!Array.isArray(index) || (canonical && !canonicalPublicationJson(index).equals(bytes))) {
    throw contractPublicationError('contract-index-invalid');
  }
  return indexEntry(index, contractId);
}

async function approvedEntry(readFile, indexPath, contractId, ref) {
  const bytes = await readFile(indexPath, ref);
  try {
    const entry = readPublicationEntry(bytes, contractId);
    if (entry) return { entry, bytes };
  } catch (error) {
    if (error.publicationCause !== 'contract-index-invalid') throw error;
  }
  throw contractPublicationError('contract-drift');
}

async function historicalBinding({ contractId, contractsRoot, mergeCommitSha, folder, lockDigest }, readFile) {
  const { entry } = await approvedEntry(readFile, contractsRoot + '/INDEX.json', contractId, mergeCommitSha);
  const historicalFolder = contractsRoot + '/' + entry.folder;
  const lockBytes = await readFile(historicalFolder + '/contract.lock.json', mergeCommitSha);
  if (!lockBytes || (folder && folder !== historicalFolder) || (lockDigest && publicationDigest(lockBytes) !== lockDigest)) {
    throw contractPublicationError('contract-drift');
  }
  return { folder: historicalFolder, lockBytes, entry };
}

export async function readContractReceiptBinding(receipt, readFile) {
  const { folder, lockBytes } = await historicalBinding(receipt, readFile);
  return { folder, lockDigest: publicationDigest(lockBytes) };
}

function approvedLock(folder, bytes, contractId) {
  let lock;
  try { lock = readLock(folder + '/contract.lock.json', bytes); }
  catch { throw contractPublicationError('contract-drift'); }
  if (lock.contractId !== contractId) throw contractPublicationError('contract-drift');
  return lock;
}

export async function readProductBinding(productReceipt, contractsRoot, readFile) {
  if (!productReceipt) throw contractPublicationError('contract-drift');
  const { folder, lockBytes } = await historicalBinding({ ...productReceipt, contractsRoot }, readFile);
  return { folder, lock: approvedLock(folder, lockBytes, productReceipt.contractId) };
}

export function assertProductLock(product, folder, bytes) {
  const lock = approvedLock(folder, bytes, product.lock.contractId);
  const owned = lock => ({
    files: lock.files.filter(isG2Owned).sort(by('path')),
    product: lock.sections?.product,
  });
  if (folder !== product.folder ||
      !canonicalPublicationJson(owned(lock)).equals(canonicalPublicationJson(owned(product.lock)))) {
    throw contractPublicationError('contract-drift');
  }
  return lock;
}

async function readLockedFiles(folder, files, readFile) {
  const result = new Map();
  for (const { path, digest } of files) {
    const file = folder + '/' + path;
    const bytes = await readFile(file);
    if (!bytes || publicationDigest(bytes) !== digest) throw contractPublicationError('contract-drift');
    result.set(file, bytes);
  }
  return result;
}

// Return only bytes that the current Paperclip receipts authorize.
export async function readApprovedContract({ contractId, contractsRoot, receipt, productReceipt = receipt?.section && receipt.section !== 'product' ? null : receipt }, readFile) {
  const drift = () => contractPublicationError('contract-drift');
  if (receipt?.contractId !== contractId) throw drift();
  const historical = await historicalBinding({ ...receipt, contractsRoot }, readFile);
  const { folder } = historical;
  const indexPath = contractsRoot + '/INDEX.json';
  const { entry, bytes: indexBytes } = await approvedEntry(readFile, indexPath, contractId);
  if (!canonicalPublicationJson(entry).equals(canonicalPublicationJson(historical.entry))) throw drift();
  const lockPath = folder + '/contract.lock.json';
  const lockBytes = await readFile(lockPath);
  if (!lockBytes || !Buffer.from(historical.lockBytes).equals(lockBytes)) throw drift();
  const product = productReceipt === receipt
    ? { folder, lock: approvedLock(folder, historical.lockBytes, contractId) }
    : await readProductBinding(productReceipt, contractsRoot, readFile);
  const lock = assertProductLock(product, folder, lockBytes);
  const files = await readLockedFiles(folder, lock.files, readFile);
  files.set(indexPath, indexBytes);
  files.set(lockPath, lockBytes);
  return files;
}

function assertPublicationChange(project, path) {
  const folded = path.toLowerCase();
  const blocked = (project.ciPaths ?? []).some(value => {
    const prefix = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
    return folded === prefix || folded.startsWith(prefix + '/');
  });
  if (blocked) {
    throw contractPublicationError('contract-proposal-differs');
  }
}

export async function derivePublication({
  binding, pinnedMain, project, run, section, readApprovedDeliverable, readMain, validatePublicationFormat = pack.validateApprovalManifest,
}) {
  if (section !== 'product') throw contractPublicationError('publication-validator-unavailable');
  const { decision, manifest, currentReceipt, latestReceipt = currentReceipt, containsCommit } = binding;
  let approved;
  try { approved = JSON.parse(manifest.bytes); }
  catch { throw contractPublicationError('contract-manifest-invalid'); }
  const epicTitle = run.input.epicTitle;
  const contract = requireContract(approved, epicTitle);
  try { validatePublicationFormat({ ...approved, contract }); }
  catch { throw contractPublicationError('contract-manifest-invalid'); }

  const currentRevision = currentReceipt?.mergeCommitSha ?? null;
  if (approved.supersedes !== currentRevision || (currentReceipt && !await containsCommit(currentRevision, pinnedMain))) {
    throw contractPublicationError('contract-supersedes-stale');
  }

  const root = project.contracts_root ?? project.contractsRoot ?? 'knowledge/contracts';
  const indexPath = root + '/INDEX.json';
  const indexBytes = await readMain(indexPath, pinnedMain);
  const initial = currentReceipt ? null : contractProposalLocation({ project, decision, manifest: approved, epicTitle });
  const index = initial ? readIndex(indexPath, indexBytes, initial.contractId) : null;
  const existing = currentReceipt && (await approvedEntry(readMain, indexPath,
    currentReceipt.contractId, latestReceipt.mergeCommitSha)).entry;
  const { contractId, folder, branch, epic } = initial ?? contractProposalLocation({ project, decision, manifest: approved, existing, epicTitle });
  const fullPath = path => root + '/' + folder + '/' + path;
  const lockPath = fullPath('contract.lock.json');
  let oldLockBytes, oldLock;
  const preserved = new Map();
  if (existing) {
    const receipts = { contractId, contractsRoot: root, receipt: latestReceipt, productReceipt: currentReceipt };
    const predecessor = latestReceipt.mergeCommitSha;
    const authorized = await readApprovedContract(receipts, (path, ref = predecessor) => readMain(path, ref));
    if (pinnedMain !== predecessor) {
      readPublicationEntry(indexBytes, contractId);
      await readApprovedContract(receipts, (path, ref = pinnedMain) => readMain(path, ref));
    }
    oldLockBytes = authorized.get(lockPath);
    oldLock = readLock(lockPath, oldLockBytes);
    const provenance = lock => lock.sections?.product ?? {
      approvalManifest: lock.approvalManifest, supersedes: lock.supersedes, decisionId: currentReceipt.decisionId,
    };
    const product = provenance(oldLock);
    if (!currentReceipt.decisionId || product.decisionId !== currentReceipt.decisionId) {
      throw contractPublicationError('contract-lock-invalid');
    }
    const approval = product.approvalManifest;
    if (typeof approval?.id !== 'string' || !approval.id.trim()
        || typeof approval.revisionId !== 'string' || !approval.revisionId.trim()
        || (product.supersedes !== null
          && (typeof product.supersedes !== 'string' || !/^[a-f0-9]{40}$/.test(product.supersedes)))) {
      throw contractPublicationError('contract-lock-invalid');
    }
    try { pack.validateSha256Digest(approval.digest); }
    catch { throw contractPublicationError('contract-lock-invalid'); }
    if (oldLock.contractId !== contractId || oldLock.epic !== epic || approval.id !== currentReceipt.manifestId
        || approval.revisionId !== currentReceipt.revisionId || approval.digest !== currentReceipt.manifestDigest
        || product.supersedes !== currentReceipt.supersedes) {
      throw contractPublicationError('contract-supersedes-stale');
    }
    for (const file of oldLock.files) {
      const { path } = file;
      const bytes = authorized.get(fullPath(path));
      validatePublicationText(fullPath(path), bytes);
      if (!isG2Owned(file)) preserved.set(fullPath(path), bytes);
    }
  } else if (await readMain(lockPath, pinnedMain)) {
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
  const entry = existing ?? pack.validateContractIndexEntry({ contractId, folder, status: 'active' });
  if (index) {
    index.push(entry);
    index.sort(by('contractId'));
  }

  const changes = new Map();
  const candidates = [...Array.from(files, ([path, bytes]) => [fullPath(path), bytes]),
    [lockPath, canonicalPublicationJson(lock)], [indexPath, index ? canonicalPublicationJson(index) : indexBytes]];
  for (const [path, bytes] of candidates) {
    if (path !== indexPath || !existing) validatePublicationText(path, bytes);
    const before = path === indexPath ? indexBytes : path === lockPath ? oldLockBytes : await readMain(path, pinnedMain);
    if (!existing && before && path !== indexPath) throw contractPublicationError('contract-id-collision');
    if (!before || !Buffer.from(bytes).equals(Buffer.from(before))) {
      assertPublicationChange(project, path);
      changes.set(path, bytes);
    }
  }
  return { contractId, currentRevision, supersedes: approved.supersedes, branch, deliverables, changes,
    lockPath, folder: root + '/' + folder, indexPath, indexEntry: entry, publication: new Map([...preserved, ...candidates]) };
}

export async function deriveSectionPublication({
  binding, pinnedMain, project, section, readApprovedDeliverable, readMain,
}) {
  const { decision, manifest, currentReceipt, latestReceipt, sectionReceipt, containsCommit } = binding;
  const contractId = currentReceipt.contractId;
  if (!await containsCommit(latestReceipt.mergeCommitSha, pinnedMain) ||
      !await containsCommit(currentReceipt.mergeCommitSha, latestReceipt.mergeCommitSha)) {
    throw contractPublicationError('contract-supersedes-stale');
  }

  const contractsRoot = project.contracts_root ?? project.contractsRoot ?? 'knowledge/contracts';
  const indexPath = contractsRoot + '/INDEX.json';
  const publication = await readApprovedContract({ contractId, contractsRoot, receipt: latestReceipt,
    productReceipt: currentReceipt }, (path, ref = pinnedMain) => readMain(path, ref));
  const indexBytes = publication.get(indexPath);
  const indexEntry = readPublicationEntry(indexBytes, contractId);
  const folder = contractsRoot + '/' + indexEntry.folder;
  const lockPath = folder + '/contract.lock.json';
  const oldLock = readLock(lockPath, publication.get(lockPath));
  const product = await readProductBinding(currentReceipt, contractsRoot, readMain);

  let approved;
  try { approved = JSON.parse(manifest.bytes); }
  catch { throw contractPublicationError('contract-manifest-invalid'); }
  const invalid = () => contractPublicationError('contract-deliverable-invalid');
  if (!Array.isArray(approved?.deliverables) || !approved.deliverables.length) throw invalid();
  const deliverables = new Map();
  const files = [];
  const keys = new Set();
  const changes = new Map();
  for (const row of approved.deliverables) {
    const { key, revisionId, digest } = row ?? {};
    try {
      pack.validateContractPath(key);
      pack.validateSha256Digest(digest);
    } catch { throw invalid(); }
    const folded = key.toLowerCase();
    if (keys.has(folded) || (section === 'design' && folded === 'interaction.md') ||
        folded.split('/').some(segment => pack.contractReservedSegments.includes(segment))) throw invalid();
    keys.add(folded);

    const relative = section + '/' + key;
    const path = folder + '/' + relative;
    const bytes = await readApprovedDeliverable({ key, revisionId, path, digest });
    if (bytes == null || publicationDigest(bytes) !== digest) throw invalid();
    validatePublicationText(path, bytes);
    deliverables.set(key, bytes);
    files.push({ path: relative, section, digest });
    const before = publication.get(path);
    if (!before || !Buffer.from(bytes).equals(before)) {
      assertPublicationChange(project, path);
      changes.set(path, bytes);
    }
    publication.set(path, bytes);
  }

  for (const file of oldLock.files) {
    const path = folder + '/' + file.path;
    if (file.section !== section || isG2Owned(file)) {
      validatePublicationText(path, publication.get(path));
      files.push(file);
    } else if (!deliverables.has(file.path.slice(section.length + 1))) {
      assertPublicationChange(project, path);
      publication.delete(path);
      changes.set(path, null);
    }
  }

  const supersedes = sectionReceipt?.mergeCommitSha ?? null;
  const approvalManifest = { id: manifest.id, revisionId: manifest.revisionId, digest: publicationDigest(manifest.bytes) };
  const lock = {
    ...oldLock,
    sections: { ...oldLock.sections, [section]: {
      approvalManifest, decisionId: decision.id, approvedAt: new Date(decision.at).toISOString(), supersedes,
    } },
    files: files.sort(by('path')),
  };
  try { pack.validateContractLock(lock); } catch { throw contractPublicationError('contract-lock-invalid'); }
  const lockBytes = canonicalPublicationJson(lock);
  validatePublicationText(lockPath, lockBytes);
  assertProductLock(product, folder, lockBytes);
  assertPublicationChange(project, lockPath);
  changes.set(lockPath, lockBytes);
  publication.set(lockPath, lockBytes);

  const { type, slug } = pack.parseContractFolder(indexEntry.folder);
  return { contractId, currentRevision: supersedes, supersedes, branch: 'contract/' + type + '-' + slug + '_' + contractId,
    deliverables, changes, lockPath, folder, indexPath, indexEntry, publication };
}

export function resolveReferencePublicationProfile(id, section) {
  if (id !== referencePublicationProfileId || typeof pack.contractIdFromDecision !== 'function') return null;
  if (section === 'product') return derivePublication;
  if (['design', 'technical'].includes(section)) return deriveSectionPublication;
  return null;
}
