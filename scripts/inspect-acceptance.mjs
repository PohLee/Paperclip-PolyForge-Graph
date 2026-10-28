import { readFile } from 'node:fs/promises';
const auth = JSON.parse(await readFile(new URL('../.e2e/auth.json', import.meta.url), 'utf8'));
const base = 'http://localhost:3310';
async function get(path) {
  const response = await fetch(`${base}${path}`, { headers: { Cookie: auth.cookie, Origin: 'http://localhost:3100' } });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
const companies = (await get('/api/companies')).filter(item => item.name?.startsWith('PolyForge acceptance'));
for (const company of companies.slice(-2)) {
  const issues = await get(`/api/companies/${company.id}/issues`);
  const roots = issues.filter(item => item.title?.startsWith('ADLC acceptance'));
  const heartbeats = await get(`/api/companies/${company.id}/heartbeat-runs`);
  const statusCounts = Object.groupBy(heartbeats, item => item.status);
  console.log(JSON.stringify({ companyId: company.id, name: company.name,
    roots: roots.map(item => ({ id: item.id, title: item.title })),
    issueCount: issues.length, heartbeatCount: heartbeats.length,
    heartbeatStatuses: Object.fromEntries(Object.entries(statusCounts).map(([key, list]) => [key, list.length])),
    recentHeartbeats: heartbeats.slice(0, 8).map(item => ({ id: item.id, issueId: item.issueId,
      status: item.status, errorCode: item.errorCode, startedAt: item.startedAt })) }));
  for (const root of roots.slice(-1)) {
    const graph = await get(`/api/plugins/pohlee.polyforge-graph/api/issues/${root.id}/graph`);
    console.log(JSON.stringify({ rootIssueId: root.id,
      runs: (graph.runs ?? []).map(run => ({ id: run.id, graphId: run.graphId, status: run.status,
        packVersion: run.packVersion })) }));
    for (const run of (graph.runs ?? []).filter(item => item.status === 'running')) {
      const detail = await get(`/api/plugins/pohlee.polyforge-graph/api/issues/${root.id}/graph?runId=${run.id}`);
      console.log(JSON.stringify({ runId: run.id, active: Object.entries(detail.run.nodeStates)
        .filter(([, node]) => ['pending', 'awaiting_self_review', 'awaiting_supervisor_review'].includes(node.status) && node.attempts.length)
        .map(([id, node]) => ({ id, status: node.status, attempts: node.attempts.length })),
        dispatches: detail.dispatches, pendingHuman: detail.run.pendingHuman,
        blocked: detail.blocked }));
    }
  }
  console.log(JSON.stringify({ failed: heartbeats.filter(item => item.status === 'failed')
    .map(item => ({ id: item.id, issueId: item.issueId, errorCode: item.errorCode,
      stderrExcerpt: item.stderrExcerpt?.slice(0, 180) })) }));
}
