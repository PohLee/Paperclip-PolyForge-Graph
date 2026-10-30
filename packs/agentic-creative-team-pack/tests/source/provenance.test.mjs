import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { treeDigest, verifySourceSnapshot } from '../../sources/integrity.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
test('source lock pins unique immutable full commits with expected licenses',async()=>{
 const lock=JSON.parse(await readFile(join(root,'sources','upstream.lock.json'),'utf8'));
 assert.equal(lock.schemaVersion,1); assert.equal(lock.sources.length,3);
 assert.equal(new Set(lock.sources.map(x=>x.id)).size,3);
 for(const source of lock.sources){assert.match(source.commit,/^[a-f0-9]{40}$/);assert.match(source.treeSha256,/^[a-f0-9]{64}$/);assert.match(source.repository,/^https:\/\/github\.com\/.+\.git$/);assert.ok(source.destination.startsWith('sources/upstream/'));assert.ok(['MIT','Apache-2.0'].includes(source.license));}
});
test('materializer exports tracked trees without cloning runtime state',async()=>{
 const script=await readFile(join(root,'scripts','materialize-sources.mjs'),'utf8');
 assert.match(script,/rev-parse/);assert.match(script,/git.*archive/s);assert.match(script,/expected/);assert.doesNotMatch(script,/npm install|cargo build|execFile\(.*snapshot/s);
 const resolver=await readFile(join(root,'scripts','resolve-source.mjs'),'utf8');assert.match(resolver,/verifySourceSnapshot/);
 for(const source of JSON.parse(await readFile(join(root,'sources','upstream.lock.json'),'utf8')).sources){
   const path=join(root,source.destination);await access(path);const {readdir}=await import('node:fs/promises');assert.ok(!(await readdir(path)).includes('.git'));await access(join(path,'LICENSE'));
 }
 await access(join(root,'sources','upstream','impeccable','NOTICE.md'));
});
test('source verifier rejects a corrupted isolated snapshot fixture',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'creative-source-test-'));const snapshot=join(temp,'sources','upstream','fixture');
 try{
  await mkdir(snapshot,{recursive:true});await writeFile(join(snapshot,'method.md'),'pinned content');
  const source={id:'fixture',destination:'sources/upstream/fixture',treeSha256:await treeDigest(snapshot)};
  await verifySourceSnapshot({root:temp,source,snapshot});
  await writeFile(join(snapshot,'method.md'),'changed content');
  await assert.rejects(verifySourceSnapshot({root:temp,source,snapshot}),/does not match locked tree SHA-256/);
 }finally{await rm(temp,{recursive:true,force:true});}
});
