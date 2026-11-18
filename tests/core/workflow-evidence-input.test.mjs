import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContractConfiguration, validateRunContracts, validateOutputContract } from '../../src/core/evidence-contracts.mjs';

test('contracted evidence targets business input without changing trusted run context', () => {
  const graph = { evidenceInputSource: 'workflowInput', workflowContract: { version: 1 }, nodes: [] };
  const run = { graph, input: { paperclipCompanyId: 'trusted-company', system_id: 'legacy-target',
    workflowInput: { system_id: 'workflow-target', paperclipCompanyId: 'untrusted-business-string' } } };
  const before = structuredClone(run);
  const node = { outputContract: 'architecture-baseline' };
  const artifacts = [{ kind: 'architecture_baseline', id: 'baseline', version: '1' }];
  const output = { systemId: 'workflow-target', summary: 'Bounded proposal', diagram: 'client -> service',
    implementationStatus: 'proposed', invariants: [{ id: 'INV-1', rule: 'Service owns writes',
      enforcement: 'Interface boundary', proof: 'Fixture assertion', status: 'active' }] };
  validateOutputContract({ runs: {} }, run, node, output, artifacts);
  assert.throws(() => validateOutputContract({ runs: {} }, run, node, { ...output, systemId: 'legacy-target' }, artifacts), /match/);
  assert.deepEqual(run, before);
  assert.equal(run.input.paperclipCompanyId, 'trusted-company');
});

test('workflow evidence input cannot bypass delivery target validation or be enabled on legacy graphs', () => {
  assert.throws(() => validateContractConfiguration({ evidenceInputSource: 'workflowInput', nodes: [] }), /requires a contracted/);
  assert.throws(() => validateContractConfiguration({ evidenceInputSource: 'actor', workflowContract: {}, nodes: [] }), /requires a contracted/);
  const graph = { evidenceInputSource: 'workflowInput', inputContracts: ['delivery-target'] };
  assert.throws(() => validateRunContracts({}, graph, { workflowInput: {
    delivery_target: { repository: 'fixture/repo', prUrl: 'https://example.invalid/1', headSha: 'short' },
  } }), /full head SHA/);
});
