import { useEffect, useState } from 'react';

/** Use authenticated routes so native Decisions carry the actual viewer identity. */
export function useGraphData(companyId, issueId, runId) {
  const [result, setResult] = useState(null);
  const [revision, setRevision] = useState(0);
  const query = companyId && new URLSearchParams({
    companyId, ...(issueId && { issueId }), ...(runId && { runId }),
  }).toString();

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/plugins/pohlee.polyforge-graph/api/graph?${query}`, {
          credentials: 'same-origin', signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body) throw new Error(body?.error || `Graph data unavailable (HTTP ${response.status}).`);
        if (!controller.signal.aborted) setResult({ query, revision, data: body, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ query, revision, data: null, error: error.message });
      }
    }
    void load();
    return () => controller.abort();
  }, [query, revision]);

  const current = query && result?.query === query && result.revision === revision ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? null,
    loading: Boolean(query && !current), refresh: () => setRevision(value => value + 1) };
}
