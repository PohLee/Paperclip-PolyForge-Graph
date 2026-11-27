import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { beginAssignment, getAssignment, confirmAssignment, retireAssignment, cancelAssignmentRetirements, listAssignmentRetirements } from '../../src/plugin/assignment-ledger.mjs';
import { createPostgresShadowDatabase, postgresShadowAvailable } from '../helpers/postgres-shadow.mjs';

test('assignment ledger rejects an invalid namespace', async () => {
  await assert.rejects(getAssignment({ namespace: 'unsafe.namespace' }, 'company', 'operation'), /Invalid host database namespace/);
});

test('PostgreSQL assignment generations retain concurrent retirement owners and never resend unknown writes',
  { skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL' }, async t => {
    const { db, sql, namespace, companyId, otherCompanyId } = await createPostgresShadowDatabase(t);
    const migration = await readFile(new URL('../../migrations/019_issue_assignment.sql', import.meta.url), 'utf8');
    await sql.unsafe(migration.replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace)
      .replaceAll('REFERENCES public.', `REFERENCES ${namespace}.`));
    const id = 'issue-assign:run:node:1:work', request = { issueId: 'issue', agentId: 'agent' };
    await Promise.all(['A', 'B'].map(owner => retireAssignment(db, companyId, id, owner)));
    assert.deepEqual(new Set((await getAssignment(db, companyId, id)).retirement_owners), new Set(['A', 'B']));
    await cancelAssignmentRetirements(db, companyId, [id], 'A');
    assert.equal((await beginAssignment(db, companyId, id, request)).owner, false);
    await cancelAssignmentRetirements(db, companyId, [id], 'B');
    assert.equal(await getAssignment(db, companyId, id), null);
    await retireAssignment(db, companyId, 'cleanup-replay', 'retry-prefix:A');
    await retireAssignment(db, companyId, 'cleanup-replay', 'retry-prefix:B');
    await retireAssignment(db, companyId, 'cleanup-replay', 'other:C');
    const replay = await listAssignmentRetirements(db, companyId, 'retry-prefix:');
    assert.equal(replay.length, 2);
    assert.ok(replay.every(item => item.operationId === 'cleanup-replay' && item.retirementOwner.startsWith('retry-prefix:')));
    for (const item of replay) await cancelAssignmentRetirements(db, companyId, [item.operationId], item.retirementOwner);
    assert.deepEqual((await getAssignment(db, companyId, 'cleanup-replay')).retirement_owners, ['other:C']);
    const first = await beginAssignment(db, companyId, id, request);
    assert.equal(first.owner, true); assert.equal(String(first.generation), '1');
    assert.equal((await beginAssignment(db, companyId, id, request)).owner, false);
    await assert.rejects(beginAssignment(db, companyId, id, { ...request, agentId: 'other' }), /different request/);
    assert.equal((await retireAssignment(db, companyId, id, 'retry')).outcome, 'unknown');
    await cancelAssignmentRetirements(db, companyId, [id], 'retry');
    assert.equal((await getAssignment(db, companyId, id)).outcome, 'unknown');
    assert.equal((await beginAssignment(db, companyId, id, request)).owner, false);
    await confirmAssignment(db, companyId, id, first.generation, request);
    await confirmAssignment(db, companyId, id, first.generation, request);
    await retireAssignment(db, companyId, id, 'committed');
    assert.equal((await beginAssignment(db, companyId, id, request)).owner, false);
    await cancelAssignmentRetirements(db, companyId, [id], 'committed');
    const competitors = await Promise.all([beginAssignment(db, companyId, id, request), beginAssignment(db, companyId, id, request)]);
    assert.equal(competitors.filter(item => item.owner).length, 1);
    const second = competitors.find(item => item.owner);
    assert.equal(String(second.generation), '2');
    await assert.rejects(confirmAssignment(db, companyId, id, first.generation, request), /current generation/);
    await confirmAssignment(db, companyId, id, second.generation, { ...request, notSent: true }, 'confirmed_failure');
    assert.equal((await beginAssignment(db, companyId, id, request)).owner, true);
    await retireAssignment(db, otherCompanyId, id, 'other');
    await cancelAssignmentRetirements(db, companyId, [id], 'other');
    assert.deepEqual((await getAssignment(db, otherCompanyId, id)).retirement_owners, ['other']);
  });
