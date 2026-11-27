import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeContract } from '../../src/host/contract-merge.mjs';
import { contractPublicationDisposition, contractPublicationError } from '../../src/host/contract-publication-causes.mjs';
import { publicationConfiguration } from '../../src/plugin/adlc-contract-publication.mjs';
import { githubHostTransportReadiness } from '../../src/plugin/github-http-transport.mjs';
import { app, attestation, repositoryId, versions } from '../helpers/g2-publication-fixture.mjs';

const kind = 'contract_publication_request';
const request = { projectId: 'project', repository: 'test/repository' };
const config = () => ({ githubApp: app, githubTransportAttestation: attestation, adlcProjects: { project: {
  repository: request.repository, githubRepositoryId: repositoryId, contractPublication: { g2: true, validatorId: 'adlc-g2-reference-v1' },
} } });
const ready = value => githubHostTransportReadiness(value, versions);

test('only G2 with the exact compiled profile and trusted binding can proceed', () => {
  assert.equal(publicationConfiguration(config(), request, kind, ready).project.id, 'project');
  for (const [change, reason] of [
    [value => value.adlcProjects.project.contractPublication.g2 = false, 'publication-gate-disabled'],
    [value => value.adlcProjects.project.contractPublication.validatorId = 'uninstalled-profile', 'publication-validator-unavailable'],
    [value => value.adlcProjects.project.contractPublication.contractIdPrefix = 'lower-', 'contract-prefix-invalid'],
    [value => delete value.githubApp, 'github-app-invalid'],
    [value => delete value.adlcProjects.project.githubRepositoryId, 'project-binding-mismatch'],
    [value => value.adlcProjects.project.repository = 'other/repo', 'project-binding-mismatch'],
    [value => delete value.githubTransportAttestation, 'transport-redirect-unsafe'],
  ]) {
    const changed = config();
    change(changed);
    assert.equal(publicationConfiguration(changed, request, kind, ready).reason, reason);
  }
  for (const unsupported of ['technical_publication_request', 'design_publication_request']) {
    assert.equal(publicationConfiguration(config(), request, unsupported, ready).reason, 'publication-validator-unavailable');
  }
});

test('transport readiness requires a well-formed attestation for both exact running versions', () => {
  assert.deepEqual(ready(attestation), { ready: true });
  for (const result of [
    ready(), ready({ ...attestation, probedAt: 'yesterday' }), githubHostTransportReadiness(attestation),
    githubHostTransportReadiness(attestation, { ...versions, hostVersion: '2026.1106.1' }),
    githubHostTransportReadiness(attestation, { ...versions, sdkVersion: '2026.1106.1' }),
  ]) assert.deepEqual(result, { ready: false, state: 'blocked-config', reason: 'transport-redirect-unsafe' });
});

test('mergeContract maps only allowlisted pre-intent causes to worker dispositions', async () => {
  for (const [code, state, reason = code] of [
    ['contract-id-collision', 'blocked-config'],
    ['contract-type-slug-missing', 'blocked-config'],
    ['publication-policy-changed', 'needs-new-approval'],
    ['contract-not-english', 'needs-new-approval'],
    ['github-merge-main-changed', 'needs-new-approval'],
    ['github-merge-repository-busy', 'backoff'],
    ['unrecognized-detail', 'backoff', 'publication-retry'],
  ]) {
    const fault = contractPublicationError(code, 'Private arbitrary detail');
    await assert.rejects(mergeContract({
      engine: { getRun: async () => ({ input: { projectId: 'project' } }) },
      github: { getMergeReceipt: async () => { throw fault; } }, project: { id: 'project', repository: request.repository },
      runId: 'run', pullNumber: 3, section: 'product', decisionId: 'decision', manifest: { id: 'manifest', revisionId: 'v1', bytes: Buffer.from('{}') },
      authorize: () => assert.fail('No mutation may be authorized'),
    }), error => {
      assert.deepEqual(error.publicationDisposition, { state, reason });
      return true;
    });
  }
  assert.deepEqual(contractPublicationDisposition(new Error('github-merge-main-changed')), { state: 'backoff', reason: 'publication-retry' });
});
