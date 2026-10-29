import assert from 'node:assert/strict';
import {createHmac,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixtureContractInputs} from './fixture-contract-inputs.mjs';
import {canonicalEvidence} from '../src/host/evidence-provider.mjs';
import {root,waitFor,pluginId} from './enhancement-client.mjs';

// These cases use the real isolated Paperclip host and synthetic local process
// Agents. They do not claim model quality, production releases or real revenue.
export async function runEnhancementCases({state,save,record,command,read,data,call,auth}) {
  const a=state.development,b=state.marketing;
  const graphPath=`/api/plugins/${pluginId}/api/issues/${a.issueId}/graph`;
  const graphCommand=(operation,fields,key)=>data('POST',graphPath,{operation,...fields,
    reason:`Synthetic enhancement acceptance: ${operation}`,idempotencyKey:`enhancement:${operation}:${key}`});
  await command(a.companyId,'configure-organization',{derive:true});
  const plan=await command(a.companyId,'organization-reporting-plan');
  assert.deepEqual(plan.conflicts,[]);
  for(const change of plan.changes){
    const before=await data('GET',`/api/agents/${change.agentId}`);
    assert.equal(before.companyId,a.companyId);
    if((before.reportsTo??null)===change.toReportsTo)continue;
    assert.equal(before.reportsTo??null,change.fromReportsTo);
    await data('PATCH',`/api/agents/${change.agentId}`,{reportsTo:change.toReportsTo});
  }
  const confirmed=await command(a.companyId,'organization-reporting-confirm',{planDecisionId:plan.planDecisionId});
  assert.equal(confirmed.aligned,true);
  const company=await read(a.companyId),org=company.setup.organization;
  const ceo=await data('GET',`/api/agents/${org.ceo.id}`);
  assert.equal(ceo.reportsTo,null);
  for(const head of org.domainHeads)assert.equal((await data('GET',`/api/agents/${head.agentId}`)).reportsTo,ceo.id);
  await record('Native Board CEO and domain hierarchy',{ceoId:ceo.id,domainHeads:org.domainHeads,decisionId:confirmed.decisionId});

  if(!state.sourceComment){state.sourceComment=await data('POST',`/api/issues/${a.issueId}/comments`,{body:'Synthetic Board request: validate the MVP launch workflow.'});await save();}
  const intakeFields={projectId:a.projectId,title:'Validate the MVP launch workflow',sourceIssueId:a.issueId,sourceCommentId:state.sourceComment.id};
  const intake=await command(a.companyId,'create-intake',intakeFields);
  assert.equal((await command(a.companyId,'create-intake',intakeFields)).intake.id,intake.intake.id);
  assert.equal(intake.intake.source.senderId,auth.userId);
  assert.equal(intake.intake.description,state.sourceComment.body);
  const foreign=await call('POST',`/api/plugins/${pluginId}/api/company`,{companyId:b.companyId,operation:'create-intake',...intakeFields,reason:'Synthetic isolation rejection',idempotencyKey:'foreign-intake'},true);
  assert.ok(foreign.status>=400);
  await record('Authenticated chat provenance replay and project isolation',{intakeId:intake.intake.id,issueId:intake.issueId,foreignStatus:foreign.status});

  const goals=[{id:'enhancement-users',title:'Reach ten synthetic trial users',keyResults:[{id:'users',baseline:0,target:10,unit:'users',source:'local-fixture',window:'synthetic-launch+10d'}]}];
  const original=await command(a.companyId,'set-goals',{scope:'company',subjectId:a.companyId,goals},'enhancement:goals:original');
  state.goalRevisionId=original.revision.id;await save();
  const nativeGoals=await data('GET',`/api/companies/${a.companyId}/goals`);
  const nativeGoal=nativeGoals.find(item=>item.description?.includes('PolyForge goal: enhancement-users'));
  assert.equal(nativeGoal.level,'company');
  const unknown=await command(a.companyId,'review-outcome',{projectId:a.projectId,goalId:goals[0].id,goalRevisionId:original.revision.id,
    observations:[{keyResultId:'users',value:999,sourceRef:{url:'https://example.invalid/unverified'}}]});
  assert.equal(unknown.observations[0].status,'unknown');
  await record('Versioned native company goals and unverified outcomes stay unknown',{goalRevisionId:original.revision.id,nativeGoalId:nativeGoal.id,reviewId:unknown.id});

  const baseline=await graphCommand('product-decision',{feature:'enhancement-fixture',status:'approved',outcome:'Preserve the synthetic baseline',
    evidence:[{kind:'fixture_requirement',id:'REQ-ENHANCEMENT-1'}]},'baseline');
  const input={...fixtureContractInputs('ui-ux-design','REQ-ENHANCEMENT-1'),fixture:'deterministic-docker-e2e',feature:'enhancement-fixture',
    versioned_requirement:{id:'REQ-ENHANCEMENT-1',version:'v1'},product_decision_refs:[baseline.result.id],productDecisionRefs:[baseline.result.id]};
  await graphCommand('configure',{roleBindings:company.config.roleBindings,defaultMode:'autonomous'},'fixture-bindings');
  const workPlan=await command(a.companyId,'create-plan',{projectId:a.projectId,items:[
    {id:'design',title:'Validate synthetic design',packId:'adlc',graphId:'ui-ux-design',priority:1,dependsOn:[],input},
    {id:'launch',title:'Plan synthetic launch',packId:'marketing',graphId:'acquisition-plan',priority:2,dependsOn:['design'],input:{}},
  ]},'enhancement:work-plan');
  const early=await call('POST',`/api/plugins/${pluginId}/api/company`,{companyId:a.companyId,operation:'start-plan-item',planId:workPlan.id,itemId:'launch',reason:'Verify dependency guard',idempotencyKey:'enhancement:early-dependency'},true);
  assert.ok(early.status>=400);
  const started=await command(a.companyId,'start-plan-item',{planId:workPlan.id,itemId:'design'},'enhancement:start-design');
  state.designRunId=started.run.id;state.designIssueId=started.issueId;await save();
  const changed=await command(a.companyId,'set-goals',{scope:'company',subjectId:a.companyId,goals:[{...goals[0],title:'Revised synthetic target',keyResults:[{...goals[0].keyResults[0],target:20}]}]},'enhancement:goals:revised');
  const completed=await waitFor(async()=>{
    const dashboard=await data('GET',`/api/plugins/${pluginId}/api/issues/${started.issueId}/graph?runId=${started.run.id}`);
    if(dashboard.run.status==='completed')return dashboard;
    if(!['running','paused'].includes(dashboard.run.status))throw new Error(`Synthetic design run ${dashboard.run.status}`);
    return null;
  },'synthetic Graph completion');
  assert.equal(completed.run.goalContext.revisions.find(item=>item.scope==='company').id,original.revision.id);
  assert.notEqual(original.revision.id,changed.revision.id);
  const refreshed=await read(a.companyId),linked=refreshed.control.plans.find(item=>item.id===workPlan.id).items.find(item=>item.id==='design');
  assert.equal(linked.status,'completed');assert.equal(linked.runId,started.run.id);
  const attempts=Object.values(completed.run.nodeStates).flatMap(node=>node.attempts).filter(attempt=>attempt.actor?.kind==='agent');
  assert.ok(attempts.length>0&&attempts.every(attempt=>attempt.actor.executionId));
  for(const id of new Set(attempts.map(attempt=>attempt.actor.executionId))){const hostRun=await data('GET',`/api/heartbeat-runs/${id}`);assert.equal(hostRun.companyId,a.companyId);assert.equal(hostRun.status,'succeeded');}
  await record('Real process Agent Graph execution and pinned goals',{runId:started.run.id,attempts:attempts.length,pinnedRevision:original.revision.id,newRevision:changed.revision.id});
  await record('Cross-Pack plan dependency guard and native run completion',{planId:workPlan.id,linkedRunId:linked.runId,earlyStatus:early.status});

  const fixturePath=resolve(root,`.e2e/evidence-provider-fixture-${a.companyId}.json`);
  let fixture=await readFile(fixturePath,'utf8').then(JSON.parse).catch(()=>null);
  if(!fixture){fixture={value:randomBytes(32).toString('base64url')};const secret=await data('POST',`/api/companies/${a.companyId}/secrets`,{name:'Local enhancement evidence fixture',key:'POLYFORGE_E2E_EVIDENCE',value:fixture.value,description:'Synthetic localhost acceptance only'});fixture.secretId=secret.id;fixture.companyId=a.companyId;await writeFile(fixturePath,JSON.stringify(fixture),{mode:0o600});}
  assert.equal(fixture.companyId,a.companyId);
  const secretRef={type:'secret_ref',secretId:fixture.secretId,version:'latest'};
  const nativeConfig=await data('GET',`/api/plugins/${pluginId}/config?companyId=${a.companyId}`);
  const priorConfig=nativeConfig?.configJson??{};
  await data('POST',`/api/plugins/${pluginId}/config`,{companyId:a.companyId,configJson:{...priorConfig,
    evidence:{...priorConfig.evidence,providers:{...priorConfig.evidence?.providers,'local-fixture':{secretRef}}}}});
  await command(a.companyId,'configure-evidence-providers',{providers:[{id:'local-fixture',companyId:a.companyId,projectIds:[a.projectId],kinds:['metric'],maxAgeSeconds:604800,secretRef}]});
  if(!state.metricReceipt){const now=Date.now();state.metricReceipt={id:'enhancement-metric-1',providerId:'local-fixture',companyId:a.companyId,projectId:a.projectId,kind:'metric',issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+604800000).toISOString(),subjectRefs:[{id:'synthetic-billing-report',version:'v1'}],data:{goalRevisionId:original.revision.id,goalId:'enhancement-users',keyResultId:'users',source:'local-fixture',window:'synthetic-launch+10d',value:7,observedAt:new Date(now-2000).toISOString()}};await save();}
  const receipt=state.metricReceipt,signature=createHmac('sha256',fixture.value).update(canonicalEvidence(receipt)).digest('hex');
  const proof=await command(a.companyId,'import-evidence',{projectId:a.projectId,receipt,signature},'enhancement:metric-import');
  assert.equal((await command(a.companyId,'import-evidence',{projectId:a.projectId,receipt,signature},'enhancement:metric-import')).id,proof.id);
  const reviewed=await command(a.companyId,'review-outcome',{projectId:a.projectId,goalId:'enhancement-users',runId:started.run.id,observations:[{keyResultId:'users',evidenceReceiptId:proof.id}]});
  assert.equal(reviewed.observations[0].status,'observed');assert.equal(reviewed.observations[0].value,7);assert.equal(reviewed.packId,'adlc');
  await record('Authenticated local provider receipt import replay and outcome attribution',{receiptId:proof.id,reviewId:reviewed.id,value:7,provider:'synthetic local fixture',packId:reviewed.packId});

  const knowledge=await command(a.companyId,'record-knowledge',{projectId:a.projectId,kind:'product',title:'Synthetic launch boundary',body:'The local fixture must never represent a production release.',sourceRefs:[{kind:'graph-decision',id:baseline.result.id}]});
  const found=await command(a.companyId,'query-knowledge',{projectId:a.projectId,q:'Synthetic launch boundary'});
  assert.ok(found.some(item=>item.id===knowledge.id&&item.sourceRefs.length));
  await command(a.companyId,'append-feedback',{projectId:a.projectId,subjectId:started.run.id,body:'Retain the original product boundary during future work.'});
  const after=await read(a.companyId);
  assert.ok(after.control.feedback.some(item=>item.subjectId===started.run.id));
  assert.ok(after.control.audit.every(item=>item.actor&&item.reason));
  await record('Sourced knowledge feedback and decision audit',{knowledgeId:knowledge.id,auditCount:after.control.audit.length});
}
