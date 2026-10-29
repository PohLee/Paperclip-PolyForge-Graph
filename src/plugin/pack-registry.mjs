import { loadCatalog, selectPack } from './catalog.mjs';

const message = (error) => error instanceof Error ? error.message : String(error);
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const releaseKey = (pack) => `${pack.id}@${pack.version}`;

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot(packs) {
  if (!Array.isArray(packs) || !packs.length) throw new Error('Pack catalog is empty');
  const seen = new Map();
  for (const pack of packs) {
    if (!pack?.id || !pack?.version || !Array.isArray(pack.graphs) || !pack.roles) {
      throw new Error('Invalid installed Pack');
    }
    const key = releaseKey(pack);
    if (seen.has(key)) throw new Error(`Duplicate published Pack ${key}`);
    seen.set(key, true);
  }
  return freeze(structuredClone(packs));
}

/** Coordinates instance installation with lazy, per-company Core registration. */
export function createPackRegistry({ load = loadCatalog, prepareCompany }) {
  if (typeof prepareCompany !== 'function') throw new Error('prepareCompany is required');
  let catalog = null;
  let loading = null;
  let loadAttempts = 0;
  let reloadQueue = Promise.resolve();
  let globalFailure = null;
  const companyFailures = new Map();
  const companies = new Map();
  const preparations = new Map();
  const registrationQueues = new Map();
  const registered = new Set();
  const seenReleases = new Map();

  function assertUnchanged(packs) {
    for (const pack of packs) {
      const key = releaseKey(pack);
      if (seenReleases.has(key) && seenReleases.get(key) !== canonical(pack)) {
        throw new Error(`Published Pack ${key} changed without a version bump`);
      }
    }
  }

  function remember(packs) {
    assertUnchanged(packs);
    for (const pack of packs) seenReleases.set(releaseKey(pack), canonical(pack));
  }

  function health() {
    if (globalFailure) return { status: 'degraded', message: globalFailure.message };
    if (companyFailures.size) {
      const [companyId, error] = companyFailures.entries().next().value;
      return { status: 'degraded', message: `Pack registration unavailable for company ${companyId}: ${error}` };
    }
    return !catalog ?
      { status: 'degraded', message: 'Pack catalog has not loaded' } :
      { status: 'ok', message: 'PolyForge Graph worker ready', details: {
        catalog: (catalog ?? []).map(releaseKey) } };
  }

  async function installed() {
    if (catalog) return catalog;
    if (!loading) {
      const force = loadAttempts++ > 0;
      loading = Promise.resolve().then(() => load({ force })).then((packs) => {
        const candidate = snapshot(packs);
        remember(candidate);
        catalog = candidate;
        globalFailure = null;
        return catalog;
      }).catch((error) => {
        globalFailure = { source: 'catalog', message: message(error) };
        throw error;
      }).finally(() => { loading = null; });
    }
    return loading;
  }

  async function company(companyId) {
    if (!companyId) throw new Error('Company context required for Pack registration');
    let pending = preparations.get(companyId);
    if (!pending) {
      pending = Promise.resolve().then(() => prepareCompany(companyId, companies.get(companyId)))
        .then((prepared) => {
          if (!prepared?.engine || !prepared?.store) throw new Error('Company engine and store are required');
          companies.set(companyId, prepared);
          return prepared;
        }).finally(() => { if (preparations.get(companyId) === pending) preparations.delete(companyId); });
      preparations.set(companyId, pending);
    }
    return pending;
  }

  function ensureRegistered(companyId, prepared, packs, verifyStore = false) {
    const previous = registrationQueues.get(companyId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      assertUnchanged(packs);
      if (!verifyStore && packs.every((pack) => registered.has(`${companyId}:${releaseKey(pack)}`))) return;
      const state = await prepared.store.read();
      const missing = [];
      for (const pack of packs) {
        const published = state?.packs?.[releaseKey(pack)];
        if (published && canonical(published) !== canonical(pack)) {
          throw new Error(`Published Pack ${releaseKey(pack)} changed without a version bump`);
        }
        if (!published) missing.push(pack);
      }
      if (missing.length) await prepared.engine.registerPacks(missing);
      remember(packs);
      for (const pack of packs) registered.add(`${companyId}:${releaseKey(pack)}`);
    });
    registrationQueues.set(companyId, operation.catch(() => {}));
    return operation;
  }

  async function forCompany(companyId) {
    const packs = await installed();
    try {
      const prepared = await company(companyId);
      await ensureRegistered(companyId, prepared, packs);
      companyFailures.delete(companyId);
      return { ...prepared, pack: packs.find((pack) => pack.id === 'adlc') ?? packs[0] };
    } catch (error) {
      companyFailures.set(companyId, message(error));
      throw error;
    }
  }

  async function reload(companyId, { packId = 'adlc', version = null } = {}) {
    const operation = reloadQueue.then(async () => {
      await installed();
      try {
        const candidate = snapshot(await load({ force: true }));
        assertUnchanged(candidate);
        const selected = selectPack(candidate, packId, version);
        const prepared = await company(companyId);
        await ensureRegistered(companyId, prepared, candidate, true);
        catalog = candidate;
        globalFailure = null;
        companyFailures.delete(companyId);
        return selected;
      } catch (error) {
        globalFailure = { source: 'reload', message: message(error) };
        throw error;
      }
    });
    reloadQueue = operation.catch(() => {});
    return operation;
  }

  return { installed, catalog: () => catalog ?? [], forCompany, reload, health };
}
