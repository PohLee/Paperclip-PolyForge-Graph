import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { canonicalEvidence,verifyEvidenceReceipt } from '../../src/host/evidence-provider.mjs';

const secret='local-test-provider-secret-only';
const now=()=> '2026-10-29T12:00:00.000Z';
const provider={id:'metric-source',companyId:'c',projectIds:['p'],kinds:['metric'],secretRef:'fixture',maxAgeSeconds:3600};
const receipt={id:'measurement-1',providerId:provider.id,companyId:'c',projectId:'p',kind:'metric',issuedAt:'2026-10-29T11:55:00.000Z',expiresAt:'2026-10-29T12:30:00.000Z',subjectRefs:[{id:'goal-revision',version:'1'}],data:{goalRevisionId:'goal-revision',goalId:'subscriptions',keyResultId:'paid-users',source:'billing',window:'launch+10d',value:7,observedAt:'2026-10-29T11:54:00.000Z'}};
const sign=value=>createHmac('sha256',secret).update(canonicalEvidence(value)).digest('hex');
const verify=(value,overrides={})=>verifyEvidenceReceipt({receipt:value,signature:sign(value),provider,companyId:'c',projectId:'p',resolveSecret:async()=>secret,now,...overrides});
test('metric observation is authenticated against configured provider and retains an auditable digest',async()=>{
  const verified=await verify(receipt);assert.equal(verified.data.value,7);assert.equal(verified.verification.method,'hmac-sha256');assert.match(verified.verification.receiptDigest,/^sha256:[a-f0-9]{64}$/);
});
test('tampering, cross-company references, expired windows and unauthorized evidence kinds are rejected',async()=>{
  await assert.rejects(verify({...receipt,data:{...receipt.data,value:100}},{signature:sign(receipt)}),/signature verification/);
  await assert.rejects(verify({...receipt,companyId:'other'}),/company\/project/);
  await assert.rejects(verify({...receipt,expiresAt:'2026-10-29T11:59:00.000Z'}),/expired/);
  await assert.rejects(verify({...receipt,kind:'release'}),/not allowed/);
  await assert.rejects(verify({...receipt,data:{...receipt.data,observedAt:'2026-10-28T00:00:00.000Z'}}),/stale/);
});

test('release provider attests the immutable release record digest',async()=>{
  const release={...receipt,kind:'release',subjectRefs:[{id:'release-record',version:'1',digest:`sha256:${'a'.repeat(64)}`}],data:{sourceRunId:'run-1',releaseEvent:{id:'deployment-1',version:'1'},candidate:{id:'candidate-1',version:'1'},authorizationDecisionId:'authorization-1'}};
  const config={...provider,kinds:['release']};
  assert.equal((await verify(release,{provider:config})).subjectRefs[0].digest,release.subjectRefs[0].digest);
  await assert.rejects(verify({...release,subjectRefs:[{id:'release-record',version:'1'}]},{provider:config}),/record digest/);
});
