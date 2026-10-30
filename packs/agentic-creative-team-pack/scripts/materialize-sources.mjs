import { mkdtemp, mkdir, readFile, rename, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { treeDigest, verifySourceSnapshot } from '../sources/integrity.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const lock=JSON.parse(await readFile(join(root,'sources','upstream.lock.json'),'utf8'));
const run=(cmd,args,opts={})=>new Promise((ok,no)=>{const p=spawn(cmd,args,{stdio:'inherit',...opts});p.on('error',no);p.on('close',code=>code===0?ok():no(new Error(`${cmd} exited ${code}`)))});
const requested=new Set(process.argv.slice(2)); if([...requested].some(id=>!lock.sources.some(s=>s.id===id))) throw new Error('Unknown source id');
for(const source of lock.sources.filter(s=>requested.size===0||requested.has(s.id))){
 const dest=resolve(root,source.destination);
 const upstreamRoot=resolve(root,'sources','upstream'); await mkdir(upstreamRoot,{recursive:true});
 const packReal=await realpath(root), upstreamReal=await realpath(upstreamRoot), upstreamRel=relative(packReal,upstreamReal);
 if(upstreamRel.startsWith('..'+sep)||upstreamRel==='..'||resolve(upstreamReal,relative(upstreamRoot,dest))!==dest) throw new Error('Unsafe upstream source root');
 const rel=relative(upstreamRoot,dest); if(rel.startsWith('..'+sep)||rel==='..'||resolve(upstreamRoot,rel)!==dest) throw new Error('Unsafe destination: '+dest);
 if(!/^[a-f0-9]{64}$/.test(source.treeSha256??'')) throw new Error(`${source.id}: lock is missing its materialized tree digest`);
 try{
   await access(dest);
   const {treeSha256:actual}=await verifySourceSnapshot({root,source,snapshot:dest});
   console.log(`${source.id}: existing snapshot matches locked commit and tree digest`); continue;
 }catch(error){if(error.code!=='ENOENT') throw error;}
 const temp=await mkdtemp(join(tmpdir(),'creative-source-'));
 try{
   const repo=join(temp,'repo'); await mkdir(repo);
   await run('git',['init','--quiet',repo]);
   await run('git',['-C',repo,'remote','add','origin',source.repository]);
   await run('git',['-C',repo,'fetch','--quiet','--depth','1','origin',source.commit]);
   const {stdout,stderr}=await new Promise((ok,no)=>{const p=spawn('git',['-C',repo,'rev-parse','FETCH_HEAD'],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('error',no);p.on('close',code=>code===0?ok({stdout,stderr}):no(new Error(stderr)))});
   if(stdout.trim().toLowerCase()!==source.commit.toLowerCase()) throw new Error(`${source.id}: expected ${source.commit}, got ${stdout.trim()}`);
   const archive=join(temp,'source.tar'); await run('git',['-C',repo,'archive','--format=tar','--output',archive,source.commit]);
   await mkdir(dirname(dest),{recursive:true}); const staging=join(dirname(dest),`.${basename(dest)}-${process.pid}`); await mkdir(staging);
   try{
     await run('tar',['-xf',archive,'-C',staging]);
     const actual=await treeDigest(staging);
     if(actual!==source.treeSha256) throw new Error(`${source.id}: exported tree digest does not match lock`);
     await rename(staging,dest);
   }catch(e){await rm(staging,{recursive:true,force:true});throw e}
   console.log(`${source.id}: materialized verified ${source.commit}`);
 }finally{await rm(temp,{recursive:true,force:true})}
}
