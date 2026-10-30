import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createInterviewArtifact, projectRequirements, renderInterviewHtml, validateInterviewArtifact } from '../adapters/interview/index.mjs';
import { assembleGallery, createImageProviderAdapter, createSelection, inspectStaticImage, renderGalleryHtml, validateConceptSet, validateSelection, validateStaticImage } from '../adapters/concept-gallery/index.mjs';

const questionnaire = { id: 'q', version: '1', questions: [{ id: 'need', type: 'textarea', label: 'Need' }] };
test('interview artifact preserves raw answers with source and projects unknowns explicitly', () => {
  const artifact = createInterviewArtifact({ questionnaire: { ...questionnaire, questions: [{ id: 'need', requirementKind: 'preference' }] }, answers: { need: { value: 'Not sure', source: 'interviewee' } } });
  assert.equal(validateInterviewArtifact(artifact).valid, true);
  assert.equal(validateInterviewArtifact({ ...artifact, answers: null }).valid, false);
  assert.equal(artifact.answers[0].value, 'Not sure');
  assert.equal(artifact.answers[0].source, 'interviewee');
  assert.equal(projectRequirements(artifact)[0].kind, 'unknown');
  const mixed = createInterviewArtifact({ questionnaire: { id: 'q', version: '1', questions: [{ id: 'pref', requirementKind: 'preference' }, { id: 'fact', requirementKind: 'fact' }, { id: 'negative', requirementKind: 'fact' }, { id: 'blank' }, { id: 'unsure' }] }, answers: { pref: 'clean and calm', fact: 'show full audit history', negative: false, blank: '不确定', unsure: "I don't know" } });
  assert.deepEqual(projectRequirements(mixed).map(item => item.kind), ['preference', 'fact', 'fact', 'unknown', 'unknown']);
});

test('interview HTML is semantic, offline, autosaves, and safely embeds untrusted strings', () => {
  const html = renderInterviewHtml({ ...questionnaire, title: '</script><img src=x onerror=alert(1)>' });
  assert.match(html, /localStorage/);
  assert.match(html, /role="status"/);
  assert.match(html, /\\u003c\/script/);
  assert.doesNotMatch(html, /<img src=x onerror/);
});

function png(width, height) {
  const crc = bytes => { let value=0xffffffff; for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0)} return (value^0xffffffff)>>>0 };
  const chunk = (type,data) => { const name=Buffer.from(type), body=Buffer.concat([name,data]), size=Buffer.alloc(4), check=Buffer.alloc(4); size.writeUInt32BE(data.length); check.writeUInt32BE(crc(body)); return Buffer.concat([size,body,check]) };
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(width,0); ihdr.writeUInt32BE(height,4); ihdr[8]=8; ihdr[9]=6;
  const pixels=Buffer.alloc((width*4+1)*height);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
function setOf(images, count = images.length) {
  const candidates = images.map((image, i) => ({
    id: `c${i + 1}`, version: '1', title: `Concept ${i + 1}`, thesis: 'A clear design hypothesis',
    description: 'A considered visual direction.', choices: ['Choice one'], fit: 'For focused workflows.',
    tradeoff: 'Requires more vertical space.',
    image: { path: `input-${i + 1}.png`, filePath: `input-${i + 1}.png`, digest: image.digest, mimeType: image.mimeType, width: image.width, height: image.height },
    provider: { id: 'fixture-only' },
  }));
  return { id: 'set-a', version: '1', requestedCount: count, explorationMode: 'product-structure', candidates };
}

test('concept validator requires exact 3–5 count and distinct IDs and image paths', () => {
  const one = { id:'x',version:'1',requestedCount:3,explorationMode:'product-structure',candidates:[] };
  assert.equal(validateConceptSet(one).valid, false);
  const candidate = { id:'a',version:'1',title:'t',thesis:'t',description:'d',choices:['x'],fit:'f',tradeoff:'t',image:{path:'images/x.png',digest:'a'.repeat(64),mimeType:'image/png',width:1,height:1},provider:{id:'test'} };
  assert.equal(validateConceptSet({ ...one,candidates:[candidate,candidate,{...candidate,id:'c',image:{...candidate.image,path:'images/y.png'}}] }).valid, false);
  assert.equal(validateConceptSet({ ...one,candidates:[{...candidate,image:{...candidate.image,path:'../secret.png'}},{...candidate,id:'b',image:{...candidate.image,path:'images/y.png'}},{...candidate,id:'c',image:{...candidate.image,path:'images/z.png'}}] }).valid, false);
  assert.equal(validateConceptSet({ ...one,candidates:[candidate,{...candidate,id:'b',image:{...candidate.image,path:'images/y.png'}},{...candidate,id:'c',image:{...candidate.image,path:'images/z.png'}}] }).valid, false);
  assert.equal(validateConceptSet({ ...one,candidates:null }).valid, false);
});

test('provider absence is visible and configured providers must return exactly requested count', async () => {
  assert.equal(createImageProviderAdapter(null).available, false);
  const provider = createImageProviderAdapter({ generateCandidates: async () => ({ candidates: [{id:'only-one'}] }) });
  await assert.rejects(provider.generate({ count:3 }), /exactly 3/);
});

test('JPEG structural inspection is distinct from trusted decode validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jpeg-structure-'));
  try {
    const file = path.join(root, 'header-only.jpg');
    await writeFile(file, Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x00,0x01,0x00,0x01,0x03,0x01,0x11,0x00,0x02,0x11,0x00,0x03,0x11,0x00,0xff,0xd9]));
    assert.equal((await inspectStaticImage(file)).verification, 'structural');
    await assert.rejects(validateStaticImage(file), /trusted image decoder capability required/);
    const decoded = await validateStaticImage(file, { decodeImage: async () => ({ width: 1, height: 1 }) });
    assert.equal(decoded.verification, 'decoded-by-host');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('selection binds to exact set, candidate version, and image digest', () => {
  const digest = 'a'.repeat(64), candidate = { id:'c1',version:'2',image:{path:'images/a.png',digest} };
  const set = {id:'s',version:'3',candidates:[candidate]};
  const selection = createSelection({set,candidateId:'c1',selectedBy:'reviewer'});
  assert.equal(validateSelection(selection,set).valid,true);
  assert.equal(validateSelection({...selection,imageDigest:'changed'},set).valid,false);
  assert.equal(validateSelection({...selection,type:'combine'},set).valid,false);
  assert.equal(validateSelection({...selection,disposition:'accepted'},set).valid,false);
  assert.throws(()=>createSelection({set,candidateId:'c1',disposition:'accepted'}),/preferences/);
});

test('gallery assembly verifies raster headers, dimensions, MIME, digest, and bounds source paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'concept-gallery-'));
  try {
    const sourceDir = path.join(root,'source'), outputDir = path.join(root,'out'); await mkdir(sourceDir);
    const imgs=[];
    for (let i=1;i<=3;i++) { const bytes=png(500+i,700); const file=`input-${i}.png`; await writeFile(path.join(sourceDir,file),bytes); imgs.push(await validateStaticImage(path.join(sourceDir,file))); }
    const bundle = await assembleGallery({conceptSet:setOf(imgs),sourceDir,outputDir});
    assert.equal(bundle.conceptSet.candidates.length,3);
    assert.match(await readFile(bundle.indexPath,'utf8'),/static image candidates/);
    const sentinel = path.join(outputDir, 'keep.txt'); await writeFile(sentinel, 'existing output remains until full validation succeeds');
    const invalid = setOf(imgs); invalid.candidates[1].image.digest = '0'.repeat(64);
    await assert.rejects(assembleGallery({conceptSet:invalid,sourceDir,outputDir}),/digest mismatch/);
    assert.equal(await readFile(sentinel,'utf8'),'existing output remains until full validation succeeds');
    const unsafe=setOf(imgs); unsafe.candidates[0].image.filePath='../outside.png';
    await assert.rejects(assembleGallery({conceptSet:unsafe,sourceDir,outputDir:path.join(root,'bad')}),/escapes sourceDir/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('gallery labels preference distinct from acceptance and renders safe relative image links', () => {
  const candidate={id:'x',version:'1',title:'<script>alert(1)</script>',thesis:'Thesis',description:'Desc',choices:['choice'],fit:'fit',tradeoff:'tradeoff',provider:{id:'test'},image:{path:'images/x.png',digest:'a'.repeat(64),mimeType:'image/png',width:1,height:1}};
  const set={id:'s',version:'1',requestedCount:3,explorationMode:'product-structure',candidates:[candidate,{...candidate,id:'y',image:{...candidate.image,path:'images/y.png',digest:'b'.repeat(64)}},{...candidate,id:'z',image:{...candidate.image,path:'images/z.png',digest:'c'.repeat(64)}}]};
  const html=renderGalleryHtml(set);
  assert.match(html,/does not approve delivery/);
  assert.match(html,/Request combination/);
  assert.match(html,/approved:false/);
  assert.match(html,/\\u003cscript\\u003e/);
  assert.doesNotMatch(html,/<script>alert\(1\)<\/script>/);
});
