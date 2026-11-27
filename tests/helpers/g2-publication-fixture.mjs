import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';

export const repositoryId = 123;
export const app = { appId: 33, installationId: 44,
  privateKeyRef: { type: 'secret_ref', secretId: 'e7e98936-6b8f-4717-91d1-2de76afe78e1' } };
export const root = 'knowledge/contracts';
export const approvalTime = '2026-09-10T15:42:00+08:00';
export const contents = new Map([
  ['prd', Buffer.from('# Orders\n\nCustomers can place an order.\n')],
  ['acceptance.feature', Buffer.from('Feature: Orders\n  Rule: Ordering is enabled\n    @AC-7\n    Scenario: Place an order\n      Given an available product\n      When I order it\n      Then an order is placed\n')],
  ['interaction-design', Buffer.from('# Order confirmation\n')],
]);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const approvalBody = () => ({
  contract: { type: 'feat', slug: 'orders' }, supersedes: null, egmReportRef: 'egm', assumptions: [], unresolvedEscalations: [],
  deliverables: Array.from(contents, ([key, bytes]) => ({ key, revisionId: key + '-v1', digest: sha256(bytes) })),
});

export function authoredProposal(decision, manifest, prior) {
  const idHash = sha256(decision.id).slice(0, 16);
  const contractId = prior?.contractId ?? 'PRC-' + String(BigInt('0x' + idHash) % 1000000000000n).padStart(12, '0');
  const folder = prior?.folder ?? '2026/09/26091007_feat-orders_' + contractId;
  const approvalManifest = { digest: sha256(manifest.bytes), id: manifest.id, revisionId: manifest.revisionId };
  const files = new Map([
    ['design/interaction.md', contents.get('interaction-design')],
    ['product/acceptance.feature', contents.get('acceptance.feature')],
    ['product/criteria.json', Buffer.from('[\n  {\n    "id": "AC-7"\n  }\n]\n')],
    ['product/prd.md', contents.get('prd')],
  ]);
  const approvedAt = '2026-09-10T07:42:00.000Z';
  const metadata = {
    approvalManifest, backlogItemRef: 'BACKLOG-7', contractId, epic: 'feat-orders',
    files: Array.from(files, ([path, bytes]) => ({ digest: sha256(bytes), path, section: path.split('/')[0] })),
    sections: { product: { approvalManifest, approvedAt, decisionId: decision.id, supersedes: prior?.commit ?? null } },
    supersedes: prior?.commit ?? null,
  };
  const render = data => Buffer.from(JSON.stringify(data, null, 2) + '\n');
  files.set('contract.lock.json', render(metadata));
  const tree = new Map(Array.from(files, ([path, bytes]) => [root + '/' + folder + '/' + path, bytes]));
  tree.set(root + '/INDEX.json', render([{ contractId, folder, status: 'active' }]));
  return { tree, folder, contractId };
}

export const emptyIndex = [root + '/INDEX.json', Buffer.from('[]\n')];
export const base = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40), advanced = 'd'.repeat(40);


const permissions = { contents: 'read', pull_requests: 'read', statuses: 'write' };

export function publicationGitHub(repository, proposal) {
  const repo = { id: repositoryId, full_name: repository };
  const commits = new Map(), trees = new Map(), blobs = new Map();
  const calls = [], statuses = [];
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const github = { calls, statuses, main: base, pr: { state: 'open', merged: false, draft: false, commits: 1,
    base: { ref: 'main', repo }, head: { sha: head, ref: 'contract/feat-orders_' + proposal.contractId } } };
  github.commit = (sha, files, parents = []) => {
    const treeSha = createHash('sha1').update(sha + 'tree').digest('hex');
    const entries = new Map();
    for (const [path, bytes] of files) {
      const parts = path.split('/');
      while (parts.length > 1) {
        parts.pop();
        const dir = parts.join('/');
        entries.set(dir, { path: dir, type: 'tree', mode: '040000',
          sha: createHash('sha1').update(treeSha + dir).digest('hex') });
      }
      const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      blobs.set(blob, { sha: blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
      entries.set(path, { path, type: 'blob', mode: '100644', sha: blob });
    }
    trees.set(treeSha, { sha: treeSha, truncated: false, tree: [...entries.values()] });
    commits.set(sha, { sha, tree: { sha: treeSha }, parents: parents.map(sha => ({ sha })) });
  };
  github.commit(base, new Map([emptyIndex]));
  github.commit(head, proposal.tree, [base]);
  function ancestors(sha) {
    const seen = new Set();
    const visit = sha => {
      if (seen.has(sha)) return;
      seen.add(sha);
      for (const parent of commits.get(sha)?.parents ?? []) visit(parent.sha);
    };
    visit(sha);
    return seen;
  }
  github.resolve = () => privateKey.export({ type: 'pkcs8', format: 'pem' });
  github.fetch = async (target, { method, headers, body, redirect }) => {
    const url = new URL(target);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(redirect, 'error');
    calls.push({ path: url.pathname, method });
    if (url.pathname === '/app/installations/' + app.installationId + '/access_tokens') {
      assert.equal(method, 'POST');
      assert.match(headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      assert.deepEqual(JSON.parse(body), { repository_ids: [repositoryId], permissions });
      return Response.json({ token: 'repo-token', repository_selection: 'selected',
        repositories: [repo], permissions: { metadata: 'read', ...permissions },
        expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    }
    const prefix = '/repositories/' + repositoryId + '/';
    assert.ok(url.pathname.startsWith(prefix));
    assert.equal(headers.authorization, 'Bearer repo-token');
    const path = url.pathname.slice(prefix.length);
    if (path.startsWith('statuses/')) {
      assert.equal(method, 'POST');
      const result = JSON.parse(body);
      statuses.push({ sha: path.split('/').at(-1), ...result });
      return Response.json(result, { status: 201 });
    }
    assert.equal(method, 'GET');
    if (path.startsWith('pulls/')) return Response.json(github.pr);
    if (path === 'commits/main') return Response.json({ sha: github.main });
    if (path.startsWith('compare/')) {
      const [left, right] = path.slice(8).split('...');
      const rightAncestors = ancestors(right);
      const common = [...ancestors(left)].find(sha => rightAncestors.has(sha));
      return common ? Response.json({ merge_base_commit: { sha: common } }) : new Response(null, { status: 404 });
    }
    const key = path.split('/').at(-1);
    const data = (path.startsWith('git/commits/') && commits.get(key))
      || (path.startsWith('git/trees/') && trees.get(key)) || (path.startsWith('git/blobs/') && blobs.get(key));
    return data ? Response.json(data) : new Response(null, { status: 404 });
  };
  return github;
}
