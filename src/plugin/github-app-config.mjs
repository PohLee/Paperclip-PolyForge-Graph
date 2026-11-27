import { validTransportAttestation } from './github-http-transport.mjs';

export const githubTransportAttestationSchema = {
  type: 'object', additionalProperties: false, required: ['hostVersion', 'sdkVersion', 'probedAt'],
  properties: {
    hostVersion: { type: 'string' }, sdkVersion: { type: 'string' }, probedAt: { type: 'string', format: 'date-time' },
  },
};

const maxId = Number.MAX_SAFE_INTEGER;
const idSchema = { type: 'integer', minimum: 1, maximum: maxId };
const labelSchema = { type: 'string', minLength: 1, maxLength: 128 };
const gateSchema = { type: 'boolean', default: false };
const gates = ['g2', 'g4', 'g3'];
export const validGitHubId = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const repositoryName = /^[\w.-]+\/[\w.-]+$/;
const validatorId = /^[a-zA-Z0-9][\w.-]{0,127}$/;
const prefix = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export const githubAppSchema = {
  type: 'object', additionalProperties: false, required: ['appId', 'installationId', 'privateKeyRef'],
  properties: {
    appId: idSchema, installationId: idSchema,
    privateKeyRef: {
      type: 'object', format: 'secret-ref', additionalProperties: false, required: ['type', 'secretId'],
      properties: {
        type: { const: 'secret_ref' },
        secretId: { type: 'string', format: 'uuid' },
        version: { anyOf: [idSchema, { const: 'latest' }] },
      },
    },
  },
};

export const githubPublicationProjectProperties = {
  githubRepositoryId: idSchema,
  contractPublication: {
    type: 'object', additionalProperties: false,
    properties: {
      g2: gateSchema, g4: gateSchema, g3: gateSchema,
      validatorId: labelSchema, contractIdPrefix: labelSchema, contractIdMinWidth: idSchema,
    },
  },
};

export function validGitHubApp(app) {
  const ref = app?.privateKeyRef;
  return record(app) && Object.keys(app).every(key => Object.hasOwn(githubAppSchema.properties, key))
    && validGitHubId(app.appId) && validGitHubId(app.installationId)
    && record(ref) && Object.keys(ref).every(key => ['type', 'secretId', 'version'].includes(key))
    && ref.type === 'secret_ref' && typeof ref.secretId === 'string' && uuid.test(ref.secretId)
    && (ref.version === undefined || ref.version === 'latest' || validGitHubId(ref.version));
}

function validPublication(publication) {
  return record(publication)
    && Object.keys(publication).every(key => Object.hasOwn(githubPublicationProjectProperties.contractPublication.properties, key))
    && gates.every(gate => publication[gate] === undefined || typeof publication[gate] === 'boolean')
    && (publication.validatorId === undefined || typeof publication.validatorId === 'string' && validatorId.test(publication.validatorId))
    && (publication.contractIdPrefix === undefined || typeof publication.contractIdPrefix === 'string' && prefix.test(publication.contractIdPrefix))
    && (publication.contractIdMinWidth === undefined || validGitHubId(publication.contractIdMinWidth));
}

export function enabledPublicationProjects(config) {
  return Object.values(config?.adlcProjects ?? {}).filter(project =>
    gates.some(gate => project?.contractPublication?.[gate] === true));
}

export function githubAppConfigErrors(config) {
  if (!record(config)) return ['github-config-invalid'];
  const errors = new Set();
  if (config.githubTransportAttestation !== undefined && !validTransportAttestation(config.githubTransportAttestation)) {
    errors.add('github-transport-attestation-invalid');
  }
  if (config.githubApp !== undefined && !validGitHubApp(config.githubApp)) errors.add('github-app-invalid');
  if (config.adlcProjects !== undefined && !record(config.adlcProjects)) errors.add('github-projects-invalid');
  for (const project of Object.values(config.adlcProjects ?? {})) {
    if (!record(project)) {
      errors.add('github-project-invalid');
      continue;
    }
    if (project.githubRepositoryId !== undefined && !validGitHubId(project.githubRepositoryId)) {
      errors.add('github-repository-id-invalid');
    }
    if (project.contractPublication !== undefined && !validPublication(project.contractPublication)) {
      errors.add('github-publication-config-invalid');
    }
  }
  for (const project of enabledPublicationProjects(config)) {
    if (!validGitHubApp(config.githubApp) || !validGitHubId(project.githubRepositoryId)
      || typeof project.repository !== 'string' || !repositoryName.test(project.repository)
      || project.repository.split('/').some(part => part === '.' || part === '..')
      || !project.contractPublication.validatorId) {
      errors.add('github-publication-binding-incomplete');
    }
  }
  return [...errors];
}
