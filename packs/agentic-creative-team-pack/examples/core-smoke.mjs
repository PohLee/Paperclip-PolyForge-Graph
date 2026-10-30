import { GraphEngine } from '../../src/core/index.mjs';
import pack, { createCreativeHostApi } from '../index.mjs';

const engine=new GraphEngine();
await engine.registerPack(pack);
const host=createCreativeHostApi({
  engine,
  resolveActor:async()=>({id:'local-smoke-owner',kind:'human',roles:['human-owner'],executionId:'local-smoke-ui'}),
});
const run=await host.startRun({packId:pack.id,packVersion:pack.version,graphId:'creative-intake',mode:'manual',input:{},actor:{}});
console.log(JSON.stringify({pack:`${pack.id}@${pack.version}`,graphId:run.graph.id,runId:run.id,status:run.status},null,2));
