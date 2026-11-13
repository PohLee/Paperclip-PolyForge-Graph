export function createCapabilityCache(load, { now = Date.now, ttl = 5000 } = {}) {
  const entries = new Map();
  return {
    async get(companyId) {
      const cached = entries.get(companyId);
      if (cached && cached.expires > now()) return cached.value;
      const entry = { expires: Infinity, value: null };
      entry.value = Promise.resolve().then(() => load(companyId));
      entries.set(companyId, entry);
      try {
        const value = await entry.value;
        if (entries.get(companyId) === entry) { entry.value = value; entry.expires = now() + ttl; }
        return value;
      } catch (error) { if (entries.get(companyId) === entry) entries.delete(companyId); throw error; }
    },
    invalidate(companyId) { entries.delete(companyId); },
  };
}
