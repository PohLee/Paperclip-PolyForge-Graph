import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';

export const repositoryId = 123;
export const app = { appId: 33, installationId: 44,
  privateKeyRef: { type: 'secret_ref', secretId: 'e7e98936-6b8f-4717-91d1-2de76afe78e1' } };
export const versions = { hostVersion: '2026.1106.0', sdkVersion: '2026.1106.0' };
export const attestation = { ...versions, probedAt: '2026-11-27T04:00:00Z' };
export const root = 'knowledge/contracts';
export const approvalTime = '2026-09-10T15:42:00+08:00';
export const contents = new Map([
  ['prd', Buffer.from('# Orders\n\nCustomers can place an order.\n')],
  ['acceptance.feature', Buffer.from('Feature: Orders\n  Rule: Ordering is enabled\n    @AC-7\n    Scenario: Place an order\n      Given an available product\n      When I order it\n      Then an order is placed\n')],
  ['interaction', Buffer.from('# Order confirmation\n')],
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
    ['design/interaction.md', contents.get('interaction')],
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

export const base = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40), advanced = 'd'.repeat(40);

export function publicationGitHub(repository, initial, proposal) {
  const repo = { id: repositoryId, node_id: 'repo-id:' + repository, full_name: repository };
  const calls = [], refs = new Map();
  const github = { calls, refs, main: base, repo };
  const blobs = new Map();
  function tree(files) {
    return Array.from(files, ([path, bytes]) => {
      const sha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      blobs.set(sha, bytes);
      return { path, sha, type: 'blob', mode: '100644' };
    });
  }
  const baseTree = tree(initial);
  const headTree = tree(proposal ?? initial);
  const changes = Array.from(proposal ?? [], ([filename, bytes]) => {
    const previous = initial.get(filename);
    return previous?.equals(bytes) ? null : { filename, status: previous ? 'modified' : 'added' };
  }).filter(Boolean);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  github.resolve = async () => privateKey.export({ type: 'pkcs8', format: 'pem' });
  github.fetch = async (url, { method, body, headers }) => {
    const path = new URL(url).pathname;
    calls.push({ method, path });
    if (path.startsWith('/app/installations/')) {
      const { repository_ids } = JSON.parse(body);
      assert.equal(repository_ids.length, 1);
      return Response.json({ token: 'test-installation-token', expires_at: new Date(Date.now() + 600_000).toISOString() });
    }
    assert.equal(headers.authorization, 'Bearer test-installation-token');
    const tail = path.slice(('/repos/' + repository).length);
    if (github.fail?.(method, tail)) throw new Error('simulated transport failure');
    if (tail === '') return Response.json(repo);
    if (tail.startsWith('/pulls/')) return Response.json({
      state: 'open', user: { login: 'author' }, head: { sha: head },
      base: { sha: github.main, ref: 'main', repo }, changed_files: changes.length,
    });
    if (tail === '/git/refs/heads/main') {
      if (method === 'PATCH') {
        assert.deepEqual(JSON.parse(body), { sha: merge, force: false });
        github.main = merge;
      }
      return Response.json({ object: { sha: github.main } });
    }
    if (tail === '/git/refs') {
      const { ref, sha } = JSON.parse(body);
      refs.set(ref, sha);
      return Response.json({});
    }
    if (tail === '/merges') {
      const { base: branch } = JSON.parse(body);
      refs.set('refs/heads/' + branch, merge);
      return Response.json({ sha: merge, parents: [{ sha: base }, { sha: head }] });
    }
    if (tail.startsWith('/git/refs/heads/polyforge-merge-')) {
      const ref = tail.slice(5);
      if (method === 'DELETE') {
        refs.delete(ref);
        return new Response(null, { status: 204 });
      }
      return refs.has(ref) ? Response.json({ object: { sha: refs.get(ref) } }) : new Response(null, { status: 404 });
    }
    if (tail.startsWith('/compare/')) {
      if (tail === '/compare/' + base + '...' + head) return Response.json({ merge_base_commit: { sha: base }, files: changes });
      return Response.json({ merge_base_commit: { sha: base } });
    }
    if (tail.startsWith('/git/trees/')) return Response.json({
      truncated: false, tree: tail.endsWith(base) ? baseTree : headTree,
    });
    if (tail.startsWith('/git/blobs/')) {
      const sha = tail.split('/').at(-1);
      const bytes = blobs.get(sha);
      return Response.json({ sha, content: bytes.toString('base64'), encoding: 'base64', size: bytes.length });
    }
    assert.fail('Unexpected GitHub request: ' + method + ' ' + tail);
  };
  return github;
}
