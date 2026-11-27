import { createHash } from 'node:crypto';

const origin = 'https://api.github.com';
const maxBlobBytes = 2 * 1024 * 1024;
const maxBlobJsonChars = 3 * 1024 * 1024;
const sha = /^[0-9a-f]{40}$/;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const fault = code => new Error(code);

export function createHostGitHubTransport(host) {
  return async function githubFetch(target, { method = 'GET', headers = {}, body } = {}) {
    let url;
    try { url = new URL(target); } catch { throw fault('github-transport-invalid-url'); }
    if (url.origin !== origin || url.username || url.password || url.hash) {
      throw fault('github-transport-invalid-url');
    }
    if (body !== undefined && typeof body !== 'string') throw fault('github-transport-invalid-body');
    let response;
    try {
      const requestHeaders = new Headers(headers);
      requestHeaders.set('user-agent', 'polyforge-graph');
      response = await host.http.fetch(url.href, {
        method, headers: Object.fromEntries(requestHeaders), body, redirect: 'error',
      });
    } catch {
      throw fault('github-transport-request-failed');
    }
    if (response.redirected === true || (response.url && response.url !== url.href)
      || (response.status >= 300 && response.status < 400)) throw fault('github-transport-redirect');
    return response;
  };
}

export async function readGitHubBlob(response, expectedSha) {
  if (!sha.test(expectedSha)) throw fault('github-blob-invalid-sha');
  let body;
  try {
    const text = await response.text();
    if (text.length > maxBlobJsonChars) throw fault('github-blob-too-large');
    body = JSON.parse(text);
  } catch (error) {
    if (error.message === 'github-blob-too-large') throw fault('github-blob-too-large');
    throw fault('github-blob-invalid-json');
  }
  if (body?.sha !== expectedSha || body.encoding !== 'base64' || typeof body.content !== 'string'
    || !Number.isSafeInteger(body.size) || body.size < 0 || body.size > maxBlobBytes) {
    throw fault('github-blob-invalid-metadata');
  }
  const encoded = body.content.replace(/\r?\n/g, '');
  if (encoded.length !== Math.ceil(body.size / 3) * 4 || !base64.test(encoded)) {
    throw fault('github-blob-invalid-base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw fault('github-blob-invalid-base64');
  if (bytes.length !== body.size) throw fault('github-blob-size-mismatch');
  const actualSha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  if (actualSha !== expectedSha) throw fault('github-blob-hash-mismatch');
  return bytes;
}
