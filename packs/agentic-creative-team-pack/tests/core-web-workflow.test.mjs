import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { GraphEngine } from '../../../src/core/index.mjs';
import { createCreativeHostApi, createSelection, pack, validateStaticImage } from '../index.mjs';

const capabilities = {
  'image-generation':'1.0.0', 'html-file-write':'1.0.0', 'design-rendering':'1.0.0',
  'project-source-read':'1.0.0', 'be-contract-read':'1.0.0', 'asset-production':'1.0.0',
};
const owner = { id:'test-human-owner', kind:'human', roles:['human-owner'], executionId:'test-owner-ui' };
const taskActor = role => ({ id:`test-${role}`, kind:'agent', roles:[role], executionId:`test-exec-${role}` });
const digest = value => createHash('sha256').update(Buffer.from(stableJson(value))).digest('hex');
const stableJson = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);

function testPng(width, height, color) {
  const crc = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const offset = row * (width * 4 + 1) + 1 + col * 4;
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function workflowFixture(selectedCandidateId) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'creative-web-workflow-'));
  const artifactRoot = path.join(root, 'external-artifacts');
  const images = path.join(artifactRoot, 'images');
  await mkdir(images, { recursive:true });
  const candidates = [];
  for (const [index, [id, color]] of [['candidate-one',[220,80,80]], ['candidate-two',[70,130,220]], ['candidate-three',[60,170,110]]].entries()) {
    const file = `${id}.png`, bytes = testPng(3 + index, 2, color);
    await writeFile(path.join(images, file), bytes);
    const verified = await validateStaticImage(path.join(images, file));
    candidates.push({
      id, version:'1.0.0', title:`Synthetic test fixture ${index + 1}`, thesis:'Test-only raster used to verify workflow binding.',
      description:'Synthetic pixels generated inside the test; not a product concept or screenshot.', choices:['fixture metadata'],
      fit:'Automated workflow test only.', tradeoff:'No design or product claim.',
      image:{ path:`images/${file}`, digest:verified.digest, mimeType:verified.mimeType, width:verified.width, height:verified.height },
      provider:{ id:'synthetic-test-fixture' },
    });
  }
  const conceptSet = { id:'fixture-concept-set', version:'1.0.0', requestedCount:3, explorationMode:'product-structure', candidates };
  const selection = createSelection({ set:conceptSet, candidateId:selectedCandidateId, selectedBy:'authenticated-test-owner', reason:'Test fixture preference.' });
  const rows = new Map();
  const store = payload => {
    const kind = payload.kind;
    const row = { id:payload.id, version:payload.version, kind, digest:digest(payload), payload, artifactRoot };
    rows.set(`${kind}:${payload.id}:${payload.version}`, row);
    return row;
  };
  const setRow = store({ ...conceptSet, kind:'concept_set' });
  const selectionRow = store(selection);
  for (const candidate of candidates) store({ ...candidate, kind:'concept_candidate' });
  const conceptSetRef = { id:setRow.id, version:setRow.version, kind:setRow.kind, digest:setRow.digest };
  const conceptSelectionRef = { id:selectionRow.id, version:selectionRow.version, kind:selectionRow.kind, digest:selectionRow.digest };
  const engine = new GraphEngine({ availableCapabilities:capabilities });
  await engine.registerPack(pack);
  const api = createCreativeHostApi({
    engine, artifactRootForRun:artifactRoot,
    resolveActor:({ claimedActor }) => ({ ...claimedActor }),
    loadExternalArtifact:async ({ ref, kind }) => rows.get(`${kind}:${ref.id}:${ref.version}`),
    getArtifactProvenance:async ref => ref.id === selection.id
      ? [{ kind:'human', roles:['human-owner'], executionId:'test-owner-ui' }] : [],
    resolveDecisionEvidence:async ({ requiredKinds }) => requiredKinds.map(kind => ({ kind, payload:{ fixtureEvidence:true }, sourceRef:conceptSelectionRef })),
  });
  return {
    root, engine, api, conceptSet, selection, conceptSetRef, conceptSelectionRef,
    dispose:() => rm(root, { recursive:true, force:true }),
  };
}

function payloadFor(nodeId, selected) {
  // `imageDigest` pins the selected raster while `digest` remains reserved for
  // an immutable JSON artifact payload digest in external artifact references.
  const conceptRef = { id:selected.id, version:selected.version, imageDigest:selected.image.digest };
  if (nodeId === 'interpret-selection') return { id:'direction-contract', version:'1.0.0', conceptRef, invariants:['Keep the selected test-fixture identity pinned.'] };
  if (nodeId === 'map-page') return { id:'page-map', version:'1.0.0', conceptRef, pages:[{ id:'home', sections:['hero','details'] }] };
  if (nodeId === 'desktop-design') return { id:'desktop-design', version:'1.0.0', conceptRef, pageRef:{ id:'page-map', version:'1.0.0' }, sections:[{ id:'hero', status:'complete' }], source:'Synthetic test artifact; no screenshot is claimed.' };
  if (nodeId === 'mobile-design') return { id:'mobile-design', version:'1.0.0', conceptRef, pageRef:{ id:'page-map', version:'1.0.0' }, sections:[{ id:'hero', status:'complete' }], source:'Synthetic test artifact; no screenshot is claimed.' };
  if (nodeId === 'fidelity-review') return {
    id:'independent-review', version:'1.0.0', conceptRef, pageMapRef:{ id:'page-map', version:'1.0.0' },
    desktopRef:{ id:'desktop-design', version:'1.0.0' }, mobileRef:{ id:'mobile-design', version:'1.0.0' },
    disposition:'complete', findings:[], reviewerExecutionId:'test-exec-design-qa-accessibility', subjectAuthorExecutionIds:['placeholder'],
  };
  if (nodeId === 'publish-web-package') return {
    id:'final-web-package', version:'1.0.0', conceptRef,
    pageMapRef:{ id:'page-map', version:'1.0.0' }, desktopRef:{ id:'desktop-design', version:'1.0.0' },
    mobileRef:{ id:'mobile-design', version:'1.0.0' }, reviewRef:{ id:'independent-review', version:'1.0.0' },
  };
  throw new Error(`No fixture payload defined for ${nodeId}`);
}

async function startWorkflow(selectedCandidateId) {
  const fixture = await workflowFixture(selectedCandidateId);
  try {
    const run = await fixture.api.startRun({
      packId:pack.id, packVersion:pack.version, graphId:'concept-to-web-design', mode:'manual', actor:owner,
      input:{
        creative_brief:{ id:'fixture-brief', version:'1.0.0', objective:'Exercise the end-to-end wrapper contract.', audience:'Automated tests', surfaceMode:'operate' },
        conceptSetRef:fixture.conceptSetRef, conceptSelectionRef:fixture.conceptSelectionRef,
      },
    });
    return { ...fixture, run };
  } catch (error) { await fixture.dispose(); throw error; }
}

test('real host API and GraphEngine complete the G04 map, desktop/mobile, review, and final-package path', async () => {
  const fixture = await startWorkflow('candidate-two');
  try {
    const selected = fixture.conceptSet.candidates.find(candidate => candidate.id === fixture.selection.candidateId);
    for (let iteration = 0; iteration < 20; iteration++) {
      const run = await fixture.engine.getRun(fixture.run.id);
      if (run.status !== 'running') break;
      const ready = await fixture.engine.getReadyNodes(fixture.run.id);
      assert.ok(ready.length, `G04 reached no ready work at iteration ${iteration}`);
      for (const node of ready) {
        if (node.type === 'task') {
          const kind = node.produces[0], payload = payloadFor(node.id, selected);
          const actor = taskActor(node.role);
          await fixture.api.submitNode({
            runId:fixture.run.id, nodeId:node.id, actor,
            artifacts:[{ id:payload.id, version:payload.version, kind }], payloads:{ [kind]:payload },
          });
        } else if (node.type === 'decision') {
          await fixture.api.decideNode({
            runId:fixture.run.id, nodeId:node.id,
            actor:{ id:'test-human-design-director', kind:'human', roles:['human-owner',node.role], executionId:'test-design-director-ui' },
            outcome:'ready', reason:'Synthetic fixture workflow completion.',
          });
        } else {
          await fixture.api.submitNode({ runId:fixture.run.id, nodeId:node.id, actor:owner });
        }
      }
    }
    const completed = await fixture.engine.getRun(fixture.run.id);
    assert.equal(completed.status, 'completed');
    for (const nodeId of ['interpret-selection','map-page','desktop-design','mobile-design','fidelity-review','publish-web-package','web-design-ready']) {
      assert.equal(completed.nodeStates[nodeId].status, 'completed', `${nodeId} should complete`);
    }
    const pkg = completed.nodeStates['publish-web-package'].attempts.at(-1).output.creativeArtifacts.web_design_package;
    assert.equal(pkg.conceptRef.id, selected.id);
    assert.equal(pkg.conceptRef.version, selected.version);
    assert.equal(pkg.conceptRef.imageDigest, selected.image.digest);
    assert.equal(fixture.selection.imageDigest, selected.image.digest);
    assert.equal(pkg.pageMapRef.id, 'page-map');
    assert.equal(pkg.desktopRef.id, 'desktop-design');
    assert.equal(pkg.mobileRef.id, 'mobile-design');
    assert.equal(pkg.reviewRef.id, 'independent-review');
  } finally { await fixture.dispose(); }
});

test('real host API rejects a design direction that chooses a different candidate than the human preference', async () => {
  const fixture = await startWorkflow('candidate-two');
  try {
    const ready = (await fixture.engine.getReadyNodes(fixture.run.id)).find(node => node.id === 'interpret-selection');
    assert.ok(ready);
    const different = fixture.conceptSet.candidates.find(candidate => candidate.id !== fixture.selection.candidateId);
    const payload = payloadFor('interpret-selection', different);
    await assert.rejects(fixture.api.submitNode({
      runId:fixture.run.id, nodeId:'interpret-selection', actor:taskActor(ready.role),
      artifacts:[{ id:payload.id, version:payload.version, kind:'direction_contract' }], payloads:{ direction_contract:payload },
    }), /exact human-selected concept id, version, and digest/);
    assert.equal((await fixture.engine.getRun(fixture.run.id)).nodeStates['interpret-selection'].status, 'pending');
  } finally { await fixture.dispose(); }
});
