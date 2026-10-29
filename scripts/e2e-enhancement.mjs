import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { client,root,base,pluginId } from './enhancement-client.mjs';
import { packs } from '../../Paperclip-PolyForge-Graph-Packs/index.mjs';
import {runEnhancementCases} from './enhancement-cases.mjs';
import {runCrossPackCases} from './enhancement-cross-pack-cases.mjs';
import {runChannelCases} from './enhancement-channel-cases.mjs';
import {runCeoAuthorityCases} from './e2e-ceo-authority.mjs';
import {runShadowSessionCase} from './e2e-shadow-session.mjs';

const {auth,call,data}=await client();
const checkpoint=resolve(root,'.e2e/enhancement-checkpoint.json');
const state=process.argv.includes('--fresh')?{base,cases:[]}:await readFile(checkpoint,'utf8').then(JSON.parse).catch(()=>({base,cases:[]}));
assert.equal(state.base,base,'Checkpoint belongs to a different host');
const save=()=>writeFile(checkpoint,JSON.stringify(state,null,2));
const record=async(name,proof)=>{state.cases=state.cases.filter(item=>item.name!==name);state.cases.push({name,status:'passed',at:new Date().toISOString(),proof});await save();console.log(`PASS ${name}`);};
const endpoint=`/api/plugins/${pluginId}/api/company`;
const read=companyId=>data('GET',`${endpoint}?companyId=${companyId}`);
const acceptanceAttempt=Date.now();
const command=(companyId,operation,fields={},key)=>data('POST',endpoint,{companyId,operation,reason:`Local deterministic enhancement acceptance: ${operation}`,idempotencyKey:key??`enhancement:${acceptanceAttempt}:${companyId}:${operation}:${JSON.stringify(fields)}`,...fields});

state.status='running';
try {
const plugin=await data('GET',`/api/plugins/${pluginId}`);
assert.equal(plugin.status,'ready');assert.equal(plugin.version,'0.8.0');
await record('Docker loads enhanced Core',{version:plugin.version,status:plugin.status});
for(const key of ['development','marketing']){
  if(!state[key]){
    const company=await data('POST','/api/companies',{name:key==='development'?'PolyForge Development Lab':'PolyForge Marketing Lab',description:'Synthetic isolated enhancement acceptance company'});
    const project=await data('POST',`/api/companies/${company.id}/projects`,{name:key==='development'?'MVP launch validation':'Marketing isolation validation',description:'Synthetic deterministic test project'});
    const issue=await data('POST',`/api/companies/${company.id}/issues`,{projectId:project.id,title:'Enhancement acceptance request',description:'Synthetic local work; no production release or campaign.',status:'todo',priority:'medium'});
    state[key]={companyId:company.id,companyPrefix:company.issuePrefix,projectId:project.id,issueId:issue.id};await save();
  }
}
const a=state.development,b=state.marketing;
// Bind the synthetic owner before recording control-plane commands so replay
// retains the same authorized actor roles throughout this acceptance company.
if(!state.fixtureRolesConfigured){
  await data('POST',`/api/plugins/${pluginId}/api/issues/${a.issueId}/graph`,{
    operation:'configure',defaultMode:'autonomous',userRoles:{[auth.userId]:['product-owner','cpo','cto-caio','principal-engineer','marketing:cmo']},
    reason:'Explicit synthetic acceptance owner roles',idempotencyKey:`enhancement:fixture-roles:${a.companyId}`});
  state.fixtureRolesConfigured=true;await save();
}
const before=await read(a.companyId);
assert.deepEqual(before.catalog.map(pack=>pack.id).sort(),['adlc','marketing']);
for(const pack of packs)await command(a.companyId,'enable-pack',{packId:pack.id,version:pack.version});
await command(b.companyId,'enable-pack',{packId:'marketing',version:packs.find(pack=>pack.id==='marketing').version});
const first=await read(a.companyId),second=await read(b.companyId);
assert.deepEqual(first.enabledPacks.map(pack=>pack.packId).sort(),['adlc','marketing']);
assert.deepEqual(second.enabledPacks.map(pack=>pack.packId),['marketing']);
await record('Multiple Packs with company activation isolation',{development:first.enabledPacks,marketing:second.enabledPacks});
const anonymous=await fetch(`${base}${endpoint}?companyId=${a.companyId}`);
assert.ok([401,403].includes(anonymous.status));
await record('Anonymous company access denied',{status:anonymous.status});
for(const pack of packs){
  const result=await command(a.companyId,'provision-pack',{packId:pack.id,version:pack.version});
  assert.ok(Object.keys(result.roleBindings).some(key=>key.startsWith(`${pack.id}:`)));
  state[`${pack.id}Provision`]=result;await save();
}
await record('Namespaced Pack Agent provisioning',{roleKeys:Object.keys(state.marketingProvision.roleBindings)});
await runEnhancementCases({state,save,record,command,read,data,call,auth});
await runCrossPackCases({state,save,record,command,read,data,call,auth});
await runCeoAuthorityCases({state,save,record,command,read,data,call,auth});
await runChannelCases({state,save,record,command,read,data,call,auth});
await runShadowSessionCase({state,save,record,command,read,data,call,auth});
state.testType='deterministic real Paperclip host with synthetic process Agents';
state.packDigests=packs.map(pack=>({id:pack.id,version:pack.version,digest:pack.release?.digest}));
state.ownerId=auth.userId;
state.status='passed';delete state.failure;
await save();
await writeFile(resolve(root,'.e2e/enhancement-result.json'),JSON.stringify(state,null,2));
console.log(JSON.stringify({cases:state.cases.length,companyId:a.companyId,projectId:a.projectId,issueId:a.issueId,base}));
} catch(error) {
  state.status='failed';state.failure={message:error.message,at:new Date().toISOString()};
  await save();await writeFile(resolve(root,'.e2e/enhancement-result.json'),JSON.stringify(state,null,2));
  throw error;
}
