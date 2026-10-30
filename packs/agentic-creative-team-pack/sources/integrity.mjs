import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function isWithin(parent,target){
  const rel=relative(parent,target);
  return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`));
}

export async function treeDigest(dir){
  const hash=createHash('sha256');
  async function walk(base,prefix=''){
    const entries=(await readdir(base,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    for(const entry of entries){
      if(entry.name==='.git') throw new Error(`Unexpected .git directory in ${base}`);
      const full=join(base,entry.name), path=prefix?`${prefix}/${entry.name}`:entry.name, info=await lstat(full);
      if(info.isDirectory()){hash.update(`${path}\0dir\0`);await walk(full,path);}
      else if(info.isSymbolicLink()){hash.update(`${path}\0link\0${await readlink(full)}\0`);}
      else if(info.isFile()){hash.update(`${path}\0file\0`);hash.update(await readFile(full));hash.update('\0');}
      else throw new Error(`Unsupported source tree entry ${full}`);
    }
  }
  await walk(dir);
  return hash.digest('hex');
}

export async function verifySourceSnapshot({root,source,snapshot=resolve(root,source.destination)}){
  const packRoot=await realpath(root), candidate=resolve(snapshot), expectedPath=resolve(root,source.destination);
  if(candidate!==expectedPath) throw new Error(`${source.id}: snapshot path does not match its lock entry`);
  const upstreamRoot=resolve(root,'sources','upstream');
  const realUpstream=await realpath(upstreamRoot), realSnapshot=await realpath(candidate);
  if(!isWithin(packRoot,realUpstream)) throw new Error(`${source.id}: upstream root resolves outside the pack`);
  if(!isWithin(realUpstream,realSnapshot)) throw new Error(`${source.id}: snapshot resolves outside sources/upstream`);
  if(!/^[a-f0-9]{64}$/.test(source.treeSha256??'')) throw new Error(`${source.id}: missing locked tree SHA-256`);
  const actual=await treeDigest(realSnapshot);
  if(actual!==source.treeSha256) throw new Error(`${source.id}: snapshot content does not match locked tree SHA-256`);
  return {path:realSnapshot,treeSha256:actual};
}
