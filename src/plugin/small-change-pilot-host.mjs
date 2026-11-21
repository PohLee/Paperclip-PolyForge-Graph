import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSmallChangeGitInspector } from '../host/small-change-git.mjs';

export async function loadSmallChangePilotHost(root) {
  const file = resolve(root, 'polyforge.small-change-pilot.mjs');
  const info = await lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile()) throw new Error('The small-change pilot must be a trusted local operator module');
  const { default: config } = await import(pathToFileURL(file).href);
  if (!Array.isArray(config?.companyIds) || config.companyIds.length === 0 ||
      config.companyIds.some(id => typeof id !== 'string' || !id.trim()) || typeof config.lookup !== 'function') {
    throw new Error('The small-change pilot needs explicit isolated company IDs and a scoped checkout lookup');
  }
  const companies = new Set(config.companyIds);
  return { supportsCompany: companyId => companies.has(companyId),
    inspectSmallChange: createSmallChangeGitInspector({ lookup: scope => companies.has(scope.companyId) ? config.lookup(scope) : null }) };
}
