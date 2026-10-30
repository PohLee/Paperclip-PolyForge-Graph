import test from 'node:test';
import assert from 'node:assert/strict';
import { pack, validateCreativeArtifact, createImageProviderAdapter, createInterviewArtifact } from '../index.mjs';

const set = count => ({ id:'set-1',version:'v1',requestedCount:count,explorationMode:'product-structure',candidates:Array.from({length:count},(_,i)=>({
  id:`c${i+1}`,version:'v1',title:`Concept ${i+1}`,thesis:`Distinct idea ${i+1}`,description:'A clear concept summary.',choices:['Different information hierarchy'],fit:'Works for the stated task.',tradeoff:'Uses more vertical space.',image:{path:`images/c${i+1}.png`,digest:String(i+1).repeat(64),mimeType:'image/png',width:640,height:480},provider:{id:'test'},sourceRefs:[]
})) });

test('pack imports and exposes all graph IDs and runtime validators',()=>{
  assert.deepEqual(pack.graphs.map(g=>g.id),['creative-intake','brand-foundation','concept-sprint','concept-to-web-design','saas-feature-design','design-system-evolution','design-assurance','brand-campaign-assets']);
  assert.equal(pack.roles['head-of-design'].reportsToRole,null);
  assert.ok(pack.compatibility.coreRange);
  assert.equal(JSON.parse(JSON.stringify(pack)).id,'creative-team');
});

for(const count of [3,4,5]) test(`concept set validator accepts ${count} distinct candidates`,()=>{
  const result=validateCreativeArtifact('concept_set',set(count));
  assert.equal(result.valid,true,result.errors.join('; '));
});

test('concept set validator rejects count mismatch, duplicate candidates, and unsafe image paths',()=>{
  assert.equal(validateCreativeArtifact('concept_set',set(4).valueOf() && {...set(4),candidates:set(3).candidates}).valid,false);
  const duplicate=set(3); duplicate.candidates[2].id=duplicate.candidates[1].id;
  assert.equal(validateCreativeArtifact('concept_set',duplicate).valid,false);
  const unsafe=set(3); unsafe.candidates[0].image.path='../outside.png';
  assert.equal(validateCreativeArtifact('concept_set',unsafe).valid,false);
});

test('no image provider is reported as a capability gap and a wrong batch count fails',async()=>{
  assert.equal(createImageProviderAdapter(null).available,false);
  const adapter=createImageProviderAdapter({generateCandidates:async()=>({candidates:[{id:'only-one'}]})});
  await assert.rejects(adapter.generate({count:3}),/exactly 3 candidates/);
});

test('interview answers preserve source and unknown requirements validate',()=>{
  const interview=createInterviewArtifact({questionnaire:{id:'intake',version:'1'},answers:{goal:{value:'Review three design directions',source:'user'},launch:{value:'Not sure',source:'user'}},requirements:[
    {id:'REQ-001',kind:'fact',text:'Review three design directions',sourceRefs:['answer:goal']},
    {id:'REQ-002',kind:'unknown',text:'Unknown launch timing',sourceRefs:['answer:launch']}
  ]});
  assert.equal(validateCreativeArtifact('interview_responses',interview).valid,true);
  assert.equal(interview.answers[0].source,'user');
});
