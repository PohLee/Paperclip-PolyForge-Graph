import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { GraphEngine } from '../../../src/core/index.mjs';
import { pack, createCreativeHostApi, validateCreativeArtifact, assembleGallery, validateStaticImage } from '../index.mjs';

const capabilities={'image-generation':'1.0.0','html-file-write':'1.0.0','design-rendering':'1.0.0','project-source-read':'1.0.0','be-contract-read':'1.0.0','asset-production':'1.0.0'};
const fixtureActor=({claimedActor})=>({id:claimedActor?.id??'host-user',kind:claimedActor?.kind??'human',roles:claimedActor?.roles??['human-owner'],executionId:claimedActor?.executionId??'host-execution'});
const payloadArtifact=(kind,payload)=>({id:payload.id,version:payload.version,kind});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function png(width,height) {
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0)}return(value^0xffffffff)>>>0};
  const chunk=(type,data)=>{const name=Buffer.from(type),body=Buffer.concat([name,data]),size=Buffer.alloc(4),check=Buffer.alloc(4);size.writeUInt32BE(data.length);check.writeUInt32BE(crc(body));return Buffer.concat([size,body,check])};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  const pixels=Buffer.alloc((width*4+1)*height);pixels[1]=width;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

async function hostFixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),'creative-host-'));
  const engine=new GraphEngine({availableCapabilities:capabilities});
  await engine.registerPack(pack);
  const api=createCreativeHostApi({engine,artifactRootForRun:root,hasImageProvider:async()=>true,resolveActor:fixtureActor,
    resolveDecisionEvidence:async({requiredKinds})=>requiredKinds.map(kind=>({kind,payload:{kind},sourceRef:{id:'unused',version:'1'}}))});
  return {root,engine,api,dispose:()=>rm(root,{recursive:true,force:true})};
}

test('runtime requires a concrete surface only for surface-specific graphs',async()=>{
  const {api,dispose}=await hostFixture();
  try {
    await assert.rejects(api.startRun({packId:pack.id,packVersion:pack.version,graphId:'concept-sprint',mode:'manual',actor:{kind:'human'},input:{requestedCount:3,imageProviderId:'provider',creative_brief:{id:'b',version:'1',objective:'Explore',audience:'Users'}}}),/surfaceMode/);
  } finally { await dispose(); }
});

test('host API refuses a Core transition that changes a brief-pinned count of five to three',async()=>{
  const {api,engine,dispose}=await hostFixture();
  try {
    const run=await api.startRun({packId:pack.id,packVersion:pack.version,graphId:'concept-sprint',mode:'manual',actor:{id:'owner',kind:'human',roles:['human-owner'],executionId:'owner-ui'},input:{requestedCount:5,imageProviderId:'provider',creative_brief:{id:'b',version:'1',objective:'Explore options',audience:'Operators',surfaceMode:'operate'}}});
    const submit=async(nodeId,role,payload)=>api.submitNode({runId:run.id,nodeId,actor:{id:role,kind:'agent',roles:[role],executionId:`exec-${nodeId}`},artifacts:[payloadArtifact(pack.graphs.find(g=>g.id==='concept-sprint').nodes.find(n=>n.id===nodeId).produces[0],payload)],payloads:{[pack.graphs.find(g=>g.id==='concept-sprint').nodes.find(n=>n.id===nodeId).produces[0]]:payload}});
    await submit('freeze-brief','product-designer',{id:'frozen',version:'1',briefRef:{id:'b',version:'1'},requestedCount:5,explorationMode:'product-structure',comparisonCriteria:['task clarity']});
    await submit('plan-concepts','art-director',{id:'plan',version:'1',hypotheses:['navigation density']});
    await assert.rejects(api.decideNode({runId:run.id,nodeId:'choose-count',actor:{id:'owner',kind:'human',roles:['human-owner','art-director'],executionId:'owner-ui'},outcome:'3',reason:'Try fewer'}),/must match the count frozen in the brief/);
    assert.equal((await engine.getRun(run.id)).nodeStates['choose-count'].status,'pending');
  } finally { await dispose(); }
});

test('unknown creative artifact kinds fail closed instead of passing unchecked',()=>{
  assert.equal(validateCreativeArtifact('arbitrary_output',{id:'a',version:'1'}).valid,false);
});

test('new design-system bootstrap can accurately inventory an empty system',()=>{
  const result=validateCreativeArtifact('design_system_inventory',{id:'empty-inventory',version:'1',baselineRef:{id:'bootstrap',version:'1',kind:'brand_baseline'},tokens:[],components:[],consumers:[]});
  assert.equal(result.valid,true,result.errors.join('; '));
});

test('each graph has a valid terminal artifact contract fixture',()=>{
  const ref=(id,kind='artifact')=>({id,version:'1',kind});
  const fixtures={
    'creative-intake':['creative_brief',{id:'brief',version:'1',objective:'Clarify the task',audience:'Operators'}],
    'brand-foundation':['brand_baseline',{id:'brand',version:'1',strategyRef:ref('strategy','brand_strategy'),identityRef:ref('identity','brand_identity_system'),voiceRef:ref('voice','brand_voice_system'),decisionRef:ref('decision','decision')}],
    'concept-sprint':['concept_gallery',{id:'gallery',version:'1',path:'index.html',digest:'a'.repeat(64),setRef:ref('set','concept_set'),candidateRefs:[ref('c1','concept_candidate'),ref('c2','concept_candidate'),ref('c3','concept_candidate')]}],
    'concept-to-web-design':['web_design_package',{id:'web',version:'1',conceptRef:ref('concept','concept_candidate'),pageMapRef:ref('map','page_section_map'),desktopRef:ref('desktop','desktop_web_design'),mobileRef:ref('mobile','mobile_web_design'),reviewRef:ref('review','web_design_review')}],
    'saas-feature-design':['saas_design_package',{id:'saas',version:'1',handoffRef:ref('handoff','creative_design_handoff'),baselineRef:ref('baseline','design_baseline'),apiContractRefs:[ref('api','be_contract')],stateMatrixRef:ref('matrix','saas_state_permission_matrix'),reviewRef:ref('review','saas_design_review')}],
    'design-system-evolution':['design_baseline',{id:'ds',version:'1',tokensRef:ref('inventory','design_system_inventory'),componentsRef:ref('proposal','design_system_change_proposal'),patternsRef:ref('validation','design_system_validation'),decisionRef:ref('decision','decision'),migrationRef:ref('review','design_system_review')}],
    'design-assurance':['design_review',{id:'review',version:'1',subjectRefs:[ref('subject','review_subject')],reviewerExecutionId:'qa-exec',subjectAuthorExecutionIds:['author-exec'],scope:'declared scope',disposition:'verified',findings:[]}],
    'brand-campaign-assets':['campaign_final_package',{id:'campaign',version:'1',brandBaselineRef:ref('brand','brand_baseline'),conceptRef:ref('concept','campaign_concept'),assetPackageRef:ref('assets','campaign_asset_package'),reviewRef:ref('review','campaign_review'),decisionRef:ref('decision','decision')}],
  };
  assert.deepEqual(Object.keys(fixtures),pack.graphs.map(graph=>graph.id));
  for(const [graphId,[kind,payload]] of Object.entries(fixtures)) {
    const result=validateCreativeArtifact(kind,payload);
    assert.equal(result.valid,true,`${graphId}: ${result.errors.join('; ')}`);
  }
});

test('campaign publication pins exact current asset and review versions',async t=>{
  const {engine,root,dispose}=await hostFixture();
  const stable=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item);
  const external=new Map();
  const remember=(kind,payload)=>{
    const row={id:payload.id,version:payload.version,kind,payload,digest:sha(Buffer.from(stable(payload)))};
    external.set(`${kind}:${row.id}@${row.version}`,row);
    return {id:row.id,version:row.version,kind,digest:row.digest};
  };
  const baseline={id:'baseline',version:'1',strategyRef:{id:'strategy',version:'1'},identityRef:{id:'identity',version:'1'},voiceRef:{id:'voice',version:'1'},decisionRef:{id:'brand-decision',version:'1'}};
  const baselineRef=remember('brand_baseline',baseline);
  const api=createCreativeHostApi({engine,artifactRootForRun:root,resolveActor:fixtureActor,
    loadExternalArtifact:async({ref,kind})=>external.get(`${kind}:${ref.id}@${ref.version}`),
    resolveDecisionEvidence:async({run,requiredKinds})=>{
      const source=run.nodeStates['campaign-review'].artifacts[0];
      return requiredKinds.map(kind=>({kind,payload:{kind},sourceRef:{id:source.id,version:source.version,kind:source.kind}}));
    }});
  try {
    const run=await api.startRun({packId:pack.id,packVersion:pack.version,graphId:'brand-campaign-assets',mode:'manual',actor:{id:'owner',kind:'human',roles:['human-owner'],executionId:'owner-ui'},input:{creative_brief:{id:'brief',version:'1',objective:'Announce launch',audience:'Customers'},brandBaselineRef:baselineRef}});
    const submit=async(nodeId,kind,payload,role)=>api.submitNode({runId:run.id,nodeId,actor:{id:role,kind:'agent',roles:[role],executionId:`exec-${nodeId}`},artifacts:[payloadArtifact(kind,payload)],payloads:{[kind]:payload}});
    const brief={id:'campaign-brief',version:'1',brandBaselineRef:baselineRef,channels:['web'],claims:['Launch']};
    const concept={id:'campaign-concept',version:'1',briefRef:{id:brief.id,version:brief.version},brandBaselineRef:baselineRef,thesis:'Launch message',claims:['Launch']};
    const assets={id:'campaign-assets',version:'1',conceptRef:{id:concept.id,version:concept.version},assets:['hero'],sourceRefs:[baselineRef]};
    const review={id:'campaign-review',version:'1',assetPackageRef:{id:assets.id,version:assets.version},disposition:'accepted',findings:[]};
    await submit('read-campaign-brief','campaign_brief',brief,'brand-voice-content');
    await submit('campaign-concept','campaign_concept',concept,'art-director');
    await submit('produce-assets','campaign_asset_package',assets,'brand-identity-designer');
    const staleAssets=remember('campaign_asset_package',{...assets,version:'0'});
    await assert.rejects(submit('campaign-review','campaign_review',{...review,assetPackageRef:staleAssets},'creative-director'),/exact current asset package version/);
    assert.equal((await engine.getRun(run.id)).nodeStates['campaign-review'].attempts.length,0);
    await submit('campaign-review','campaign_review',review,'creative-director');
    const decided=await api.decideNode({runId:run.id,nodeId:'campaign-disposition',actor:{id:'owner',kind:'human',roles:['human-owner','creative-director'],executionId:'owner-ui'},outcome:'ready',reason:'Reviewed and ready'});
    assert.equal(decided.decision.evidence[0].sourceRef.version,review.version);
    const decisionRef={id:decided.decision.id,version:decided.decision.at};
    const pkg={id:'final-package',version:'1',brandBaselineRef:baselineRef,conceptRef:{id:concept.id,version:concept.version},assetPackageRef:{id:assets.id,version:assets.version},reviewRef:{id:review.id,version:review.version},decisionRef};
    const staleReview=remember('campaign_review',{...review,version:'0'});
    for(const [field,stale] of [['assetPackageRef',staleAssets],['reviewRef',staleReview]]) await t.test(`rejects stale same-ID ${field} without publishing`,async()=>{
      await assert.rejects(submit('publish-campaign-package','campaign_final_package',{...pkg,[field]:stale},'design-ops-producer'),/exact|current|reviewed|pin/i);
      const current=await engine.getRun(run.id);
      assert.equal(current.nodeStates['publish-campaign-package'].status,'pending');
      assert.equal(current.nodeStates['publish-campaign-package'].attempts.length,0);
    });
    await submit('publish-campaign-package','campaign_final_package',pkg,'design-ops-producer');
    assert.equal((await engine.getRun(run.id)).nodeStates['publish-campaign-package'].status,'completed');
  } finally { await dispose(); }
});

test('G03 wrapper completes real three-, four-, and five-image sets with one canonical static gallery each',async()=>{
  const {root,engine,api,dispose}=await hostFixture();
  try {
   for(const count of [3,4,5]) {
    const brief={id:`brief-${count}`,version:'1',objective:'Explore task organization',audience:'Operators',surfaceMode:'operate',requestedCount:count};
    const run=await api.startRun({packId:pack.id,packVersion:pack.version,graphId:'concept-sprint',mode:'manual',actor:{id:'owner',kind:'human',roles:['human-owner'],executionId:'owner-ui'},input:{requestedCount:count,imageProviderId:'fixture-provider',creative_brief:brief}});
    const graph=pack.graphs.find(item=>item.id==='concept-sprint');
    const payloadKind=nodeId=>graph.nodes.find(node=>node.id===nodeId).produces[0];
    const agentActor=(nodeId,role='art-director')=>({id:`${nodeId}-actor`,kind:'agent',roles:[role],executionId:`exec-${nodeId}`});
    const submit=async(nodeId,payload,role='art-director')=>{
      const kind=payloadKind(nodeId);
      return api.submitNode({runId:run.id,nodeId,actor:agentActor(nodeId,role),artifacts:[payloadArtifact(kind,payload)],payloads:{[kind]:payload}});
    };
    await submit('freeze-brief',{id:'frozen-brief',version:'1',briefRef:{id:brief.id,version:brief.version},requestedCount:count,explorationMode:'product-structure',comparisonCriteria:['task clarity']},'product-designer');
    await submit('plan-concepts',{id:'plan',version:'1',hypotheses:['dense navigation','task-first grouping','progressive disclosure']});
    const evidenceResolver=async({run:current,requiredKinds})=>{
      const all=current.graph.nodes.flatMap(node=>(current.nodeStates[node.id]?.attempts??[]).flatMap(attempt=>(attempt.artifacts??[]).map(item=>({item,payload:attempt.output?.creativeArtifacts?.[item.kind]}))));
      const sourceFor=kind=>kind==='requested_count'?all.find(row=>row.item.kind==='concept_sprint_brief'):kind==='brief_uncertainty'||kind==='comparison_rationale'?all.find(row=>row.item.kind==='concept_plan'):kind==='concept_versions'?all.find(row=>row.item.kind==='concept_image_01'):all.find(row=>row.item.kind==='concept_set_review');
      return requiredKinds.map(kind=>{const row=sourceFor(kind);return{kind,payload:row.payload,sourceRef:{id:row.item.id,version:row.item.version,kind:row.item.kind}}});
    };
    // The trusted resolver is fixed at host construction; rebuild this run's wrapper with its evidence source.
    const decisionApi=createCreativeHostApi({engine,artifactRootForRun:root,hasImageProvider:async()=>true,resolveActor:fixtureActor,resolveDecisionEvidence:evidenceResolver});
    await decisionApi.decideNode({runId:run.id,nodeId:'choose-count',actor:{id:'owner',kind:'human',roles:['human-owner','art-director'],executionId:'owner-ui'},outcome:String(count),reason:`The brief requests ${count} comparable directions.`});
    const imageRows=[];
    for(let index=1;index<=count;index++) {
      const file=`input-${index}.png`,bytes=png(index+2,2);
      await writeFile(path.join(root,file),bytes);
      const image=await validateStaticImage(path.join(root,file));
      const kind=payloadKind(`render-0${index}`);
      const candidate={id:`candidate-${index}`,version:'1',title:`Direction ${index}`,thesis:`Tests hypothesis ${index}`,description:'A comparable visual concept.',choices:['Different task hierarchy'],fit:'Fits the operator workflow.',tradeoff:'Uses more vertical space.',image:{path:file,digest:image.digest,mimeType:image.mimeType,width:image.width,height:image.height},provider:{id:'fixture-provider'},sourceRefs:[]};
      imageRows.push(candidate);
      await decisionApi.submitNode({runId:run.id,nodeId:`render-0${index}`,actor:agentActor(`render-0${index}`),artifacts:[{id:candidate.id,version:candidate.version,kind}],payloads:{[kind]:candidate}});
    }
    await decisionApi.submitNode({runId:run.id,nodeId:'rendered-set',actor:{id:'owner',kind:'human',roles:['human-owner'],executionId:'owner-ui'}});
    const candidateRefs=imageRows.map(({id,version})=>({id,version}));
    await decisionApi.submitNode({runId:run.id,nodeId:'review-set',actor:{id:'qa',kind:'agent',roles:['design-qa-accessibility'],executionId:'qa-independent'},artifacts:[{id:'review-1',version:'1',kind:'concept_set_review'}],payloads:{concept_set_review:{id:'review-1',version:'1',disposition:'complete',candidateRefs,findings:[]}}});
    await decisionApi.decideNode({runId:run.id,nodeId:'set-status',actor:{id:'owner',kind:'human',roles:['human-owner','art-director'],executionId:'owner-ui'},outcome:'complete',reason:'All requested images are present and independently reviewed.'});
    const set={id:`set-${count}`,version:'1',requestedCount:count,explorationMode:'product-structure',candidates:imageRows};
    await decisionApi.submitNode({runId:run.id,nodeId:'freeze-concept-set',actor:agentActor('freeze-concept-set','design-ops-producer'),artifacts:[{id:set.id,version:set.version,kind:'concept_set'}],payloads:{concept_set:set}});
    const stagedGallery=path.join(path.dirname(root),`${path.basename(root)}-gallery-${count}`);
    await assembleGallery({conceptSet:set,sourceDir:root,outputDir:stagedGallery});
    await cp(stagedGallery,path.join(root,'gallery'),{recursive:true});
    const html=await readFile(path.join(root,'gallery','index.html'));
    await decisionApi.submitNode({runId:run.id,nodeId:'assemble-gallery',actor:agentActor('assemble-gallery','design-ops-producer'),artifacts:[{id:'gallery-1',version:'1',kind:'concept_gallery'}],payloads:{concept_gallery:{id:'gallery-1',version:'1',path:'gallery/index.html',digest:sha(html),setRef:{id:set.id,version:set.version},candidateRefs,title:'Concept gallery'}}});
    for(const nodeId of ['gallery-ready']) await decisionApi.submitNode({runId:run.id,nodeId,actor:{id:'owner',kind:'human',roles:['human-owner'],executionId:'owner-ui'}});
    const final=await engine.getRun(run.id);
    assert.equal(final.status,'completed');
    assert.equal(final.nodeStates['gallery-ready'].status,'completed');
    assert.equal(final.nodeStates['gallery-incomplete'].status,'pending');
   }
  } finally { await dispose(); }
});
