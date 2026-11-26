import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmationGateConfig, syncConfirmationGate } from '../../src/plugin/confirmation-gate.mjs';

test('requests the current manifest revision and consumes only the configured owner response', async () => {
  const node = { id: 'requirements-gate', type: 'decision', decisionType: 'requirements-acceptance' };
  const run = { id: 'run', status: 'running', mode: 'manual', input: { projectId: 'project', paperclipIssueId: 'issue' },
    graph: { id: 'requirements-baseline', version: '0.1.2', nodes: [node], edges: [
      { from: node.id, to: 'yes', when: 'accept' },
      { from: node.id, to: 'hold', when: 'hold' },
    ] }, pack: { decisionRules: [] }, nodeStates: {} };
  const cards = [], applied = new Map();
  let revision = 'one';
  const host = { config: { get: async () => ({ adlcProjects: { project: { ownerId: 'owner' } } }) },
    issues: {
      documents: { get: async () => ({ id: 'manifest', latestRevisionId: revision }) },
      listInteractions: async () => cards,
      requestConfirmation: async (_issue, input) => {
        assert.equal(input.resolverPolicy, 'human_only');
        assert.equal(input.payload.target.revisionId, revision);
        const card = { ...input, id: revision, kind: 'request_confirmation', status: 'pending' };
        cards.push(card);
        return card;
      },
    } };
  const confirmation = await confirmationGateConfig(host, 'company', run, node);
  const engine = { decideNode: async args => applied.set(args.idempotencyKey, args) };
  const sync = () => syncConfirmationGate({ host, companyId: 'company', run, node, engine, confirmation,
    trustedActor: async (_company, { userId }) => ({ actor: { kind: 'human', id: userId, roles: ['human-owner'] } }) });
  const accept = (card, resolvedByUserId) => Object.assign(card, { status: 'accepted', result: { outcome: 'accepted' }, resolvedByUserId });
  await sync();
  accept(cards[0], 'owner');
  revision = 'two';
  await sync();
  assert.equal(applied.size, 0);
  accept(cards[1], 'other');
  assert.equal((await sync()).status, 'unauthorized');
  accept(cards[1], 'owner');
  cards[1].revokedAt = 'earlier';
  await sync();
  assert.equal(applied.size, 0);
  delete cards[1].revokedAt;
  assert.equal((await sync()).consumed, true);
  await sync();
  assert.equal(applied.size, 1);
  assert.deepEqual(applied.get('confirmation:two').evidence[0].subjectRefs, [{ artifactId: 'manifest', version: 'two' }]);
});
