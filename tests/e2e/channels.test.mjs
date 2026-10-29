import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { telegramIntake,deliverNotification } from '../../src/host/channels.mjs';

const binding={chatId:'-123',telegramUserId:'10',companyId:'c',userId:'human',projectId:'p'};
const update={update_id:55,message:{message_id:7,from:{id:10,is_bot:false},chat:{id:-123},text:'Build a new feature',document:{file_id:'attachment-1',file_name:'brief.pdf'}}};
test('Telegram intake binds the exact sender and chat, preserves provenance and rejects spoofed updates',()=>{
  const input={headers:{'X-Telegram-Bot-Api-Secret-Token':'test-secret'},secret:'test-secret',bindings:[binding],update};
  const result=telegramIntake(input);
  assert.equal(result.companyId,'c');assert.equal(result.userId,'human');assert.equal(result.attachments[0].fileId,'attachment-1');assert.equal(result.idempotencyKey,'telegram:c:55');
  assert.throws(()=>telegramIntake({...input,secret:'wrong'}),/authentication/);
  assert.throws(()=>telegramIntake({...input,update:{...update,message:{...update.message,from:{id:99}}}}),/binding/);
  assert.throws(()=>telegramIntake({...input,bindings:[binding,{...binding,companyId:'other'}]}),/exactly one/);
});
test('local email gateway round trip carries a stable delivery key and requires a real receipt',async()=>{
  const received=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;received.push({key:req.headers['idempotency-key'],body:JSON.parse(raw)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'local-receipt'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const result=await deliverNotification({channel:'email',notification:{id:'n',companyId:'c',subjectId:'human',text:'Synthetic local fixture'},destination:{companyId:'c',subjectId:'human',email:'owner@example.invalid'},config:{endpoint:`http://127.0.0.1:${server.address().port}`,tokenSecretRef:'fixture'},resolveSecret:async()=> 'fixture-only',allowLoopback:true});
    assert.equal(result.status,'delivered');assert.equal(result.receipt.id,'local-receipt');assert.equal(received[0].key,'polyforge:c:n:email');assert.equal(received[0].body.to,'owner@example.invalid');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('transport failures remain unknown, cannot leak token, and cross-company recipients are rejected',async()=>{
  const args={channel:'telegram',notification:{id:'n',companyId:'c',subjectId:'u',text:'Test'},destination:{companyId:'c',subjectId:'u',chatId:1},config:{tokenSecretRef:'ref'},resolveSecret:async()=> '123:secret',fetchImpl:async()=>{throw new Error('token 123:secret');}};
  const result=await deliverNotification(args);assert.equal(result.status,'unknown');assert.ok(!JSON.stringify(result).includes('secret'));
  await assert.rejects(deliverNotification({...args,destination:{...args.destination,companyId:'other'}}),/identity mismatch/);
});
