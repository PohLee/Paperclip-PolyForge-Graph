export function createOwnerDispatchSingleflight() {
  const pending = new Map();
  return {
    async run(companyId, runId, dispatchReady) {
      const key = `${companyId}:${runId}`;
      let operation = pending.get(key);
      if (!operation) {
        operation = Promise.resolve().then(dispatchReady);
        pending.set(key, operation);
      }
      try { return await operation; }
      finally { if (pending.get(key) === operation) pending.delete(key); }
    },
    clear() { pending.clear(); },
  };
}
