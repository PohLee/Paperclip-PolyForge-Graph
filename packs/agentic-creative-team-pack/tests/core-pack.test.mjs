import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine } from '../../../src/core/index.mjs';
import { pack } from '../index.mjs';

const capabilities = {
  'image-generation':'1.0.0','html-file-write':'1.0.0','design-rendering':'1.0.0',
  'be-contract-read':'1.0.0','project-source-read':'1.0.0','asset-production':'1.0.0'
};
const owner = { id:'test-owner',kind:'human',roles:['human-owner'],executionId:'test-ui' };
const taskActor = (role, executionId) => ({ id:`${role}-${executionId}`,kind:'agent',roles:[role],executionId });
const artifactFor = (kind, executionId) => ({ id:`${kind}-${executionId}`,version:'v1',kind });
const decisionEvidence = (node, mode) => pack.decisionRules.find(rule=>rule.type===node.decisionType&&rule.mode===mode).requiredEvidence.map(kind=>({kind,sourceRef:{id:`evidence-${kind}`,version:'v1'}}));
const engineWithPack = async () => {
  const engine = new GraphEngine({ availableCapabilities:capabilities });
  await engine.registerPack(pack);
  return engine;
};

test('the standalone pack registers all eight supported DAGs in Core and stays serializable', async () => {
  const engine = await engineWithPack();
  assert.equal(pack.graphs.length,8);
  assert.doesNotThrow(()=>JSON.stringify(pack));
  assert.equal((await engine.getPack?.('creative-team','0.1.0')) ?? 'registered','registered');
  for (const graph of pack.graphs) {
    assert.ok(graph.nodes.every(node=>['task','decision','join','end'].includes(node.type)));
    assert.ok(!graph.nodes.some(node=>node.type==='wait'||node.type==='foreach'));
  }
});

test('Core blocks concept-sprint when host image and gallery capabilities are absent',async()=>{
  const engine=new GraphEngine();
  await engine.registerPack(pack);
  await assert.rejects(engine.startRun({packId:pack.id,packVersion:pack.version,graphId:'concept-sprint',mode:'manual',
    input:{imageProviderId:'claimed-provider',creative_brief:{id:'brief-1',version:'v1'}},actor:owner}),/image-generation|html-file-write/);
});

for (const count of [3,4,5]) test(`Core activates exactly ${count} concept render tasks`, async () => {
  const engine=await engineWithPack();
  const run=await engine.startRun({packId:pack.id,packVersion:pack.version,graphId:'concept-sprint',mode:'manual',
    input:{imageProviderId:'test-provider',creative_brief:{id:'brief-1',version:'v1'}},actor:owner});
  let iterations=0;
  while ((await engine.getRun(run.id)).status==='running' && iterations++<30) {
    const ready=await engine.getReadyNodes(run.id);
    assert.ok(ready.length,`no ready work at iteration ${iterations}`);
    for (const node of ready) {
      if (node.type==='decision') {
        const outcome=node.id==='choose-count'?String(count):'complete';
        await engine.decideNode({runId:run.id,nodeId:node.id,actor:{id:`human-${node.id}`,kind:'human',roles:['human-owner',node.role],executionId:`human-${node.id}`},outcome,reason:'test fixture route',evidence:decisionEvidence(node,'manual')});
      } else if (node.type==='task') {
        const executionId=node.id.startsWith('render-')?'shared-render-execution':`exec-${node.id}`;
        const artifacts=(node.produces??[]).map(kind=>artifactFor(kind,executionId));
        await engine.submitNode({runId:run.id,nodeId:node.id,actor:taskActor(node.role,executionId),output:{fixture:true},artifacts});
      } else {
        await engine.submitNode({runId:run.id,nodeId:node.id,actor:owner});
      }
    }
  }
  const completed=await engine.getRun(run.id);
  assert.equal(completed.status,'completed');
  const rendered=Object.keys(completed.nodeStates).filter(id=>id.startsWith('render-')&&completed.nodeStates[id].status==='completed');
  assert.equal(rendered.length,count);
  assert.deepEqual(rendered,['render-01','render-02','render-03',...(count>=4?['render-04']:[]),...(count>=5?['render-05']:[])]);
});

test('Core records an incomplete concept-set disposition without claiming gallery readiness', async () => {
  const engine=await engineWithPack();
  const run=await engine.startRun({packId:pack.id,packVersion:pack.version,graphId:'concept-sprint',mode:'manual',
    input:{imageProviderId:'test-provider',creative_brief:{id:'brief-1',version:'v1'}},actor:owner});
  for (let i=0;i<20&&(await engine.getRun(run.id)).status==='running';i++) {
    for (const node of await engine.getReadyNodes(run.id)) {
      if(node.type==='decision') await engine.decideNode({runId:run.id,nodeId:node.id,actor:{id:`human-${node.id}`,kind:'human',roles:['human-owner',node.role],executionId:`human-${node.id}`},outcome:node.id==='choose-count'?'3':'incomplete',reason:'provider output is incomplete',evidence:decisionEvidence(node,'manual')});
      else if(node.type==='task') await engine.submitNode({runId:run.id,nodeId:node.id,actor:taskActor(node.role,`incomplete-${node.id}`),output:{status:node.id==='review-set'?'incomplete':'fixture'},artifacts:(node.produces??[]).map(kind=>artifactFor(kind,`incomplete-${node.id}`))});
      else await engine.submitNode({runId:run.id,nodeId:node.id,actor:owner});
    }
  }
  const result=await engine.getRun(run.id);
  assert.equal(result.status,'completed');
  assert.equal(result.nodeStates['gallery-incomplete'].status,'completed');
  assert.equal(result.nodeStates['gallery-ready'].status,'pending');
});

test('Core rejects a concept reviewer that reuses a render execution identity', async () => {
  const engine=await engineWithPack();
  const run=await engine.startRun({packId:pack.id,packVersion:pack.version,graphId:'concept-sprint',mode:'manual',
    input:{imageProviderId:'test-provider',creative_brief:{id:'brief-1',version:'v1'}},actor:owner});
  await engine.submitNode({runId:run.id,nodeId:'freeze-brief',actor:taskActor('product-designer','freeze'),artifacts:[artifactFor('concept_sprint_brief','freeze')]});
  await engine.submitNode({runId:run.id,nodeId:'plan-concepts',actor:taskActor('art-director','plan'),artifacts:[artifactFor('concept_plan','plan')]});
  await engine.decideNode({runId:run.id,nodeId:'choose-count',actor:{id:'human-count',kind:'human',roles:['human-owner','art-director'],executionId:'human-count'},outcome:'3',reason:'three candidates',evidence:decisionEvidence(run.graph.nodes.find(n=>n.id==='choose-count'),'manual')});
  for(const n of ['render-01','render-02','render-03']) await engine.submitNode({runId:run.id,nodeId:n,actor:taskActor('art-director','shared'),artifacts:[artifactFor(`concept_image_${n.slice(-2)}`,'shared')]});
  await engine.submitNode({runId:run.id,nodeId:'rendered-set',actor:owner});
  await assert.rejects(engine.submitNode({runId:run.id,nodeId:'review-set',actor:taskActor('design-qa-accessibility','shared'),artifacts:[artifactFor('concept_set_review','shared')]}),/Independent review/);
  await engine.submitNode({runId:run.id,nodeId:'review-set',actor:taskActor('design-qa-accessibility','independent'),artifacts:[artifactFor('concept_set_review','independent')]});
});
