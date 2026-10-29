import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const base = (process.env.POLYFORGE_E2E_BASE_URL ?? 'http://localhost:3312').replace(/\/$/, '');
export const pluginId = 'pohlee.polyforge-graph';
const state = resolve(root, '.e2e');
const cookies = response => (response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean)).map(value => value.split(';')[0]).join('; ');

export async function request(method, path, { body, cookie, allowError = false } = {}) {
  const response = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: {
    Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text(); let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { error: raw.slice(0,300) }; }
  if (!response.ok && !allowError) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
  return { status: response.status, data, cookie: cookies(response) };
}

export async function session() {
  await mkdir(state, { recursive: true });
  try { const auth = JSON.parse(await readFile(resolve(state,'enhancement-auth.json'),'utf8')); const check=await request('GET','/api/auth/get-session',{cookie:auth.cookie,allowError:true}); if(check.data?.user?.id)return auth; } catch {}
  const bootstrap = await readFile(resolve(state,'bootstrap.txt'),'utf8');
  const token = bootstrap.match(/\/api\/invites\/([A-Za-z0-9_-]+)/)?.[1] ?? bootstrap.match(/\/invite[s]?\/([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error('Create a local Paperclip bootstrap invitation first; see enhancement README.');
  const email=`polyforge-enhancement-${Date.now()}@example.invalid`,password=randomBytes(24).toString('base64url');
  const signup=await request('POST','/api/auth/sign-up/email',{body:{name:'PolyForge Enhancement Test Owner',email,password}});
  const accepted=await request('POST',`/api/invites/${token}/accept`,{cookie:signup.cookie,body:{requestType:'human'}});
  if (!accepted.data?.bootstrapAccepted) throw new Error('Local owner bootstrap was not accepted');
  const cookie=[signup.cookie,accepted.cookie].filter(Boolean).join('; ');
  const check=await request('GET','/api/auth/get-session',{cookie});
  const auth={email,password,cookie,userId:check.data?.user?.id,base};
  if(!auth.userId)throw new Error('Authenticated local owner missing');
  await writeFile(resolve(state,'enhancement-auth.json'),JSON.stringify(auth),{mode:0o600});
  return auth;
}

export async function client() {
  const auth=await session();
  const call=async(method,path,body,allowError=false)=>(await request(method,path,{body,cookie:auth.cookie,allowError}));
  return { auth, call, data: async(method,path,body)=>(await call(method,path,body)).data };
}

export async function waitFor(predicate,label,timeout=180000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const result=await predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,1000));}
  throw new Error(`Timed out waiting for ${label}`);
}
