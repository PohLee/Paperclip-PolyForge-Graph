import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const base = 'http://localhost:3311';
const output = new URL('../.e2e/real-auth.json', import.meta.url);
const invitation = await readFile(new URL('../.e2e/real-bootstrap.txt', import.meta.url), 'utf8');
const token = invitation.match(/(?:https?:\/\/[^\s]+)?\/api\/invites\/([A-Za-z0-9_-]+)/)?.[1]
  ?? invitation.match(/(?:https?:\/\/[^\s]+)?\/invites\/([A-Za-z0-9_-]+)/)?.[1]
  ?? invitation.match(/(?:https?:\/\/[^\s]+)?\/invite\/([A-Za-z0-9_-]+)/)?.[1];
assert.ok(token, 'Private bootstrap output contains no invitation token');

async function request(method, path, body, cookie) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path} returned HTTP ${response.status}`);
  return { data, cookie: (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0]).join('; ') };
}

try {
  const prior = JSON.parse(await readFile(output, 'utf8'));
  const session = await request('GET', '/api/auth/get-session', undefined, prior.cookie);
  if (session.data?.user?.id === prior.userId) {
    console.log('Existing isolated 3311 owner session remains valid.');
    process.exit(0);
  }
} catch { /* first bootstrap */ }

const email = `polyforge-real-${Date.now().toString(36)}@example.invalid`;
const password = randomBytes(24).toString('base64url');
const signup = await request('POST', '/api/auth/sign-up/email',
  { name: 'PolyForge Real Runtime Owner', email, password });
assert.ok(signup.cookie, 'Signup returned no session cookie');
const accepted = await request('POST', `/api/invites/${token}/accept`,
  { requestType: 'human' }, signup.cookie);
assert.equal(accepted.data.bootstrapAccepted, true);
const cookie = [signup.cookie, accepted.cookie].filter(Boolean).join('; ');
const session = await request('GET', '/api/auth/get-session', undefined, cookie);
assert.ok(session.data?.user?.id, 'Bootstrapped owner has no authenticated session');
await writeFile(output, JSON.stringify({ email, password, cookie, userId: session.data.user.id }),
  { mode: 0o600 });
console.log('Isolated 3311 owner bootstrapped; credentials saved only under ignored .e2e/.');
