import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

export const CONCEPT_SET_ARTIFACT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Static concept set', type: 'object', additionalProperties: false,
  required: ['id', 'version', 'requestedCount', 'explorationMode', 'candidates'],
  properties: {
    id: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 }, requestedCount: { type: 'integer', minimum: 3, maximum: 5 }, explorationMode: { enum: ['brand-territory', 'product-structure', 'surface-composition'] },
    candidates: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'object', required: ['id', 'version', 'title', 'thesis', 'description', 'choices', 'fit', 'tradeoff', 'image', 'provider'], properties: { id: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1 }, thesis: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 }, choices: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, fit: { type: 'string', minLength: 1 }, tradeoff: { type: 'string', minLength: 1 }, image: { type: 'object', required: ['path', 'digest', 'mimeType', 'width', 'height'], properties: { path: { type: 'string', minLength: 1 }, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, mimeType: { enum: ['image/png', 'image/jpeg', 'image/webp'] }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } } }, provider: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 }, model: { type: 'string' }, requestId: { type: 'string' } } }, sourceRefs: { type: 'array', items: { type: 'string' } } } } },
  },
};
export const CONCEPT_SELECTION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Concept preference selection', type: 'object', additionalProperties: false,
  required: ['id', 'kind', 'version', 'type', 'disposition', 'setId', 'setVersion', 'candidateId', 'candidateVersion', 'imageDigest', 'selectedBy', 'createdAt'],
  properties: {
    id: { type: 'string', minLength: 1 }, kind: { const: 'concept_selection' }, version: { type: 'string', minLength: 1 }, type: { const: 'select' }, disposition: { const: 'preference' },
    setId: { type: 'string', minLength: 1 }, setVersion: { type: 'string', minLength: 1 }, candidateId: { type: 'string', minLength: 1 }, candidateVersion: { type: 'string', minLength: 1 }, imageDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, selectedBy: { type: 'string', minLength: 1 }, reason: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' },
  },
};
const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

export function validateConceptSet(set) {
  const errors = [];
  if (!set || typeof set !== 'object' || Array.isArray(set)) return { valid: false, errors: ['concept set must be an object'] };
  if (typeof set.id !== 'string' || !set.id || typeof set.version !== 'string' || !set.version) errors.push('set id and version are required strings');
  if (!['brand-territory', 'product-structure', 'surface-composition'].includes(set.explorationMode)) errors.push('explorationMode must be brand-territory, product-structure, or surface-composition');
  if (!Number.isInteger(set.requestedCount) || set.requestedCount < 3 || set.requestedCount > 5) errors.push('requestedCount must be 3, 4, or 5');
  if (!Array.isArray(set.candidates) || set.candidates.length !== set.requestedCount) errors.push('candidate count must equal requestedCount');
  const candidates = Array.isArray(set.candidates) ? set.candidates : [];
  const ids = new Set();
  const imagePaths = new Set();
  const imageDigests = new Set();
  for (const [index, c] of candidates.entries()) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push(`candidate[${index}] must be an object`); continue; }
    if (typeof c.id !== 'string' || !c.id.trim() || typeof c.version !== 'string' || !c.version.trim() || ![c.title,c.thesis,c.description,c.fit,c.tradeoff].every(text => typeof text === 'string' && text.trim()) || !Array.isArray(c.choices) || !c.choices.length || c.choices.some(choice => typeof choice !== 'string' || !choice.trim()) || typeof c.image?.path !== 'string' || !/^[a-f0-9]{64}$/.test(c.image?.digest ?? '') || !['image/png', 'image/jpeg', 'image/webp'].includes(c.image?.mimeType) || !Number.isInteger(c.image?.width) || c.image.width < 1 || !Number.isInteger(c.image?.height) || c.image.height < 1 || typeof c.provider?.id !== 'string' || !c.provider.id.trim() || (c.sourceRefs !== undefined && (!Array.isArray(c.sourceRefs) || c.sourceRefs.some(ref => typeof ref !== 'string')))) errors.push(`candidate[${index}] is missing valid concept, static image, provider, or source metadata`);
    const declaredPath = typeof c.image?.path === 'string' ? c.image.path : '';
    const imageSegments = declaredPath.split('/'), extension = path.extname(declaredPath).toLowerCase(), allowedExtensions = { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'] }[c.image?.mimeType] ?? [];
    if (declaredPath && (path.isAbsolute(declaredPath) || declaredPath.includes('\\') || /[%?#:]/.test(declaredPath) || imageSegments.some(segment => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/.test(segment)) || !allowedExtensions.includes(extension))) errors.push(`candidate[${index}] image path must be a safe relative path with a matching raster extension`);
    if (ids.has(c?.id)) errors.push(`duplicate candidate id: ${c.id}`);
    ids.add(c?.id);
    const imagePath = String(c?.image?.path ?? '').replaceAll('\\', '/').toLowerCase();
    if (imagePath && imagePaths.has(imagePath)) errors.push(`duplicate image path: ${c.image.path}`);
    if (imagePath) imagePaths.add(imagePath);
    const digest = String(c?.image?.digest ?? '').toLowerCase();
    if (/^[a-f0-9]{64}$/.test(digest) && imageDigests.has(digest)) errors.push(`duplicate image digest: ${digest}`);
    if (/^[a-f0-9]{64}$/.test(digest)) imageDigests.add(digest);
  }
  return { valid: errors.length === 0, errors };
}

export function validateSelection(selection, set) {
  if (!selection || selection.kind !== 'concept_selection' || typeof selection.id !== 'string' || !selection.id || typeof selection.version !== 'string' || !selection.version || selection.type !== 'select' || selection.disposition !== 'preference') return { valid: false, error: 'only versioned concept_selection select preference records can identify a preferred candidate' };
  if (typeof selection.selectedBy !== 'string' || !selection.selectedBy || !/^[a-f0-9]{64}$/.test(selection.imageDigest ?? '')) return { valid: false, error: 'selection actor and SHA-256 image digest are required' };
  if (!Array.isArray(set?.candidates)) return { valid: false, error: 'concept set candidates must be an array' };
  const candidate = set.candidates.find(item => item?.id === selection.candidateId);
  if (!candidate) return { valid: false, error: 'selection references no current candidate' };
  if (candidate.version !== selection.candidateVersion || candidate.image.digest !== selection.imageDigest) return { valid: false, error: 'selection is stale; candidate version or image digest changed' };
  if (selection.setId !== set.id || selection.setVersion !== set.version) return { valid: false, error: 'selection references a different concept set revision' };
  return { valid: true, candidate };
}

export function createSelection({ set, candidateId, selectedBy, reason = '', disposition = 'preference', id = randomUUID(), version = '1.0.0', createdAt = new Date().toISOString() }) {
  if (disposition !== 'preference') throw new TypeError('gallery feedback records preferences, not acceptance or approval');
  const candidate = set.candidates.find(item => item.id === candidateId);
  if (!candidate) throw new TypeError('candidateId must match a current candidate');
  if (!selectedBy || !id || !version) throw new TypeError('selection id, version, and selectedBy are required');
  return { id, kind: 'concept_selection', version, type: 'select', disposition, setId: set.id, setVersion: set.version, candidateId, candidateVersion: candidate.version, imageDigest: candidate.image.digest, selectedBy, reason, createdAt };
}

export function createImageProviderAdapter(provider) {
  if (!provider || typeof provider.generateCandidates !== 'function') return { available: false, capabilityGap: 'Image generation is unavailable. Provide 3–5 real static raster candidates; no preview or substitute is generated.' };
  return {
    available: true,
    async generate(request) {
      if (![3, 4, 5].includes(request?.count)) throw new RangeError('requested image count must be exactly 3, 4, or 5');
      const result = await provider.generateCandidates(request);
      if (!Array.isArray(result?.candidates) || result.candidates.length !== request.count) throw new Error(`provider returned ${result?.candidates?.length ?? 0}; exactly ${request.count} candidates are required`);
      const ids = result.candidates.map(item => item?.id);
      if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('provider candidate IDs must be present and unique');
      if (result.candidates.some(item => !item || typeof item.imagePath !== 'string' || !item.imagePath || typeof item.provider?.id !== 'string' || !item.provider.id)) throw new Error('each provider candidate needs an imagePath and provider.id metadata');
      return result;
    },
  };
}

function rasterMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function verifyPng(bytes, width, height) {
  let offset = 8, sawHeader = false, sawPalette = false, sawIdat = false, sawEnd = false, colorType = -1, bitDepth = -1; const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8), end = offset + 12 + length;
    if (end > bytes.length) throw new TypeError('truncated PNG chunk');
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) throw new TypeError('PNG chunk checksum mismatch');
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) throw new TypeError('invalid PNG header chunk');
      bitDepth = bytes[offset + 16]; colorType = bytes[offset + 17];
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) throw new TypeError('PNG compression, filter, or interlace mode is unsupported');
      sawHeader = true;
    }
    if (type === 'PLTE') sawPalette = true;
    if (type === 'IDAT') sawIdat = true;
    else if (sawIdat && type !== 'IEND') throw new TypeError('PNG IDAT chunks must be contiguous');
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') { if (length !== 0 || end !== bytes.length) throw new TypeError('invalid PNG end chunk'); sawEnd = true; break; }
    offset = end;
  }
  if (!sawHeader || !sawEnd || !compressed.length) throw new TypeError('incomplete PNG image');
  const colorChannels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  const legalDepths = ({ 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] })[colorType] ?? [];
  if (!colorChannels || !legalDepths.includes(bitDepth) || (colorType === 3 && !sawPalette)) throw new TypeError('unsupported PNG color format or missing palette');
  const rowBytes = Math.ceil(width * colorChannels * bitDepth / 8), bytesPerPixel = Math.max(1, Math.ceil(colorChannels * bitDepth / 8));
  const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: (rowBytes + 1) * height });
  if (decoded.length !== (rowBytes + 1) * height) throw new TypeError('PNG pixel data does not match declared dimensions');
  let previous = Buffer.alloc(rowBytes), offsetPixels = 0;
  for (let row = 0; row < height; row++) {
    const filter = decoded[offsetPixels++]; if (filter > 4) throw new TypeError('invalid PNG row filter');
    const current = Buffer.from(decoded.subarray(offsetPixels, offsetPixels + rowBytes)); offsetPixels += rowBytes;
    for (let column = 0; column < rowBytes; column++) {
      const left = column >= bytesPerPixel ? current[column - bytesPerPixel] : 0, above = previous[column], upperLeft = column >= bytesPerPixel ? previous[column - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) { const p = left + above - upperLeft, dl = Math.abs(p - left), da = Math.abs(p - above), du = Math.abs(p - upperLeft); predictor = dl <= da && dl <= du ? left : da <= du ? above : upperLeft; }
      current[column] = (current[column] + predictor) & 0xff;
    }
    previous = current;
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function dimensions(bytes, mimeType) {
  if (mimeType === 'image/png' && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mimeType === 'image/webp' && bytes.length >= 30) {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === 'VP8L' && bytes[20] === 0x2f) return { width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]), height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6)) };
    if (kind === 'VP8 ' && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      const length = bytes.readUInt16BE(offset + 2); if (length < 2) break; offset += length + 2;
    }
  }
  throw new TypeError(`could not read ${mimeType} image dimensions`);
}

export async function inspectStaticImage(filePath) {
  const info = await stat(filePath);
  if (info.size > MAX_IMAGE_BYTES) throw new RangeError(`image exceeds 100 MB safety limit: ${filePath}`);
  const bytes = await readFile(filePath);
  const mimeType = rasterMime(bytes);
  if (!mimeType) throw new TypeError(`not a supported static PNG, JPEG, or WebP raster: ${filePath}`);
  const size = dimensions(bytes, mimeType);
  if (size.width < 1 || size.height < 1) throw new TypeError(`invalid image dimensions: ${filePath}`);
  if (size.width * size.height > MAX_IMAGE_PIXELS) throw new RangeError(`image exceeds 20 megapixel safety limit: ${filePath}`);
  if (mimeType === 'image/png') verifyPng(bytes, size.width, size.height);
  if (mimeType === 'image/jpeg' && !(bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9)) throw new TypeError('JPEG image is missing its end marker');
  if (mimeType === 'image/webp' && bytes.readUInt32LE(4) + 8 !== bytes.length) throw new TypeError('WebP RIFF length does not match file size');
  return { bytes, mimeType, ...size, digest: createHash('sha256').update(bytes).digest('hex'), verification: mimeType === 'image/png' ? 'decoded' : 'structural' };
}

export async function validateStaticImage(filePath, { decodeImage } = {}) {
  const inspected = await inspectStaticImage(filePath);
  if (inspected.mimeType !== 'image/png') {
    if (typeof decodeImage !== 'function') throw new Error(`trusted image decoder capability required for ${inspected.mimeType}; structural checks alone do not prove decodability`);
    const decoded = await decodeImage(inspected.bytes, inspected.mimeType);
    if (!decoded || decoded.width !== inspected.width || decoded.height !== inspected.height) throw new TypeError('trusted decoder dimensions do not match image headers');
    inspected.verification = 'decoded-by-host';
  }
  return inspected;
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const embedJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderGalleryHtml(conceptSet, title = 'Concept gallery') {
  const result = validateConceptSet(conceptSet);
  if (!result.valid) throw new TypeError(result.errors.join('; '));
  const data = embedJson(conceptSet);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:light;--ink:#172b32;--muted:#49636b;--paper:#f3f4ee;--panel:#fffefa;--accent:#075e59;--line:#cad5cf}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:clamp(1rem,3vw,2.8rem)}header{display:grid;grid-template-columns:1fr auto;align-items:end;gap:2rem;border-bottom:1px solid var(--line);padding-bottom:1.2rem}h1{font:600 clamp(2.2rem,5vw,4.2rem)/1.05 Georgia,serif;letter-spacing:-.025em;margin:.2rem 0}.meta{color:var(--muted);max-width:60ch}.toolbar{display:flex;gap:.5rem;flex-wrap:wrap}button{font:600 .95rem system-ui;padding:.65rem .9rem;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:white;cursor:pointer}button.secondary{background:transparent;color:var(--accent)}button:focus-visible{outline:3px solid #b65d30;outline-offset:2px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,390px),1fr));gap:2.2rem;margin-top:2rem}.concept{border-top:2px solid var(--ink);padding-top:.7rem}.concept h2{font:600 1.65rem/1.15 Georgia,serif;margin:.2rem 0}.thesis{font-weight:650;font-size:1.07rem}.imagewrap{background:#dce3dd;margin:1rem 0;position:relative}.imagewrap img{display:block;width:100%;height:auto;max-height:78vh;object-fit:contain;cursor:zoom-in}.bodycopy{max-width:66ch}.details{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1rem 0}.details h3{font-size:.9rem;margin:0;color:var(--muted)}ul{padding-left:1.2rem;margin:.3rem 0}.feedback{margin-top:1rem;border-top:1px solid var(--line);padding-top:1rem}.feedback label{display:block;font-weight:600;margin:.5rem 0}.feedback textarea{width:100%;min-height:5rem;font:inherit;padding:.65rem;border:1px solid #78908c;border-radius:5px}.actions{display:flex;gap:.5rem;flex-wrap:wrap}.status{color:var(--muted);min-height:1.4em}dialog{width:min(96vw,1400px);max-width:none;border:0;border-radius:10px;padding:1rem;background:#142328;color:white}dialog img{display:block;max-width:100%;max-height:82vh;margin:auto}dialog button{margin-bottom:.5rem}@media(max-width:700px){header{grid-template-columns:1fr}.details{grid-template-columns:1fr}.toolbar button{flex:1}}</style></head><body><main><header><div><p class="meta">${esc(conceptSet.explorationMode)} · ${conceptSet.requestedCount} static image candidates · set ${esc(conceptSet.id)} v${esc(conceptSet.version)}</p><h1>${esc(title)}</h1><p class="meta">Compare the visual directions and their stated tradeoffs. These are concept images, not interactive product prototypes. A selection below records a preference; it does not approve delivery.</p></div><div class="toolbar"><button id="export">Export preferences</button><button id="import" class="secondary">Import preferences</button><input id="file" type="file" accept="application/json,.json" hidden></div></header><section class="grid" id="grid"></section><p class="status" id="status" role="status" aria-live="polite"></p><dialog id="zoom"><button id="close">Close image</button><img alt="Expanded concept image"></dialog></main><script>
const SET=${data};const grid=document.getElementById('grid'),key='concept-gallery:'+SET.id+':'+SET.version,items=[];let revisionRequests=[];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function status(s){document.getElementById('status').textContent=s}
for(const c of SET.candidates){const article=document.createElement('article');article.className='concept';article.innerHTML='<h2>'+esc(c.title)+'</h2><p class="thesis">'+esc(c.thesis)+'</p><div class="imagewrap"><img src="'+esc(c.image.path)+'" alt="Static design concept: '+esc(c.title)+'" loading="lazy"></div><p class="bodycopy">'+esc(c.description)+'</p><div class="details"><div><h3>Design choices</h3><ul>'+c.choices.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><h3>Good fit</h3><p>'+esc(c.fit)+'</p></div><div><h3>Tradeoff</h3><p>'+esc(c.tradeoff)+'</p><p class="meta">Candidate '+esc(c.id)+' · v'+esc(c.version)+' · SHA-256 '+esc(c.image.digest.slice(0,16))+'…</p></div></div><div class="feedback"><label for="comment-'+esc(c.id)+'">Comment on this direction</label><textarea id="comment-'+esc(c.id)+'" data-comment="'+esc(c.id)+'" placeholder="What works, what should change, or what is unclear?"></textarea><div class="actions"><button data-select="'+esc(c.id)+'">Record preference</button><button class="secondary" data-revision="revise" data-candidate="'+esc(c.id)+'">Request revision</button><button class="secondary" data-revision="combine" data-candidate="'+esc(c.id)+'">Request combination</button></div></div>';grid.append(article);const img=article.querySelector('img');img.onclick=()=>{const dialog=document.getElementById('zoom');dialog.querySelector('img').src=img.src;dialog.showModal()};items.push(article)}
document.getElementById('close').onclick=()=>document.getElementById('zoom').close();
function read(){return {kind:'concept_feedback',setId:SET.id,setVersion:SET.version,savedAt:new Date().toISOString(),preferences:SET.candidates.map(c=>({candidateId:c.id,candidateVersion:c.version,imageDigest:c.image.digest,selected:document.querySelector('[data-select="'+CSS.escape(c.id)+'"]')?.dataset.selected==='true',comment:document.querySelector('[data-comment="'+CSS.escape(c.id)+'"]')?.value||''})),revisionRequests,acceptance:false}}
function save(){try{localStorage.setItem(key,JSON.stringify(read()));status('Preferences saved in this browser. They do not represent acceptance.');return true}catch(e){status('Local save failed. Export preferences JSON to keep them.');return false}}
function restore(data){if(data?.setId!==SET.id||data?.setVersion!==SET.version)throw Error('Feedback belongs to a different concept set revision.');for(const c of SET.candidates){const box=document.querySelector('[data-comment="'+CSS.escape(c.id)+'"]'),button=document.querySelector('[data-select="'+CSS.escape(c.id)+'"]');box.value='';button.dataset.selected='false';button.textContent='Record preference';button.classList.toggle('secondary',false)}for(const p of data.preferences||[]){const c=SET.candidates.find(x=>x.id===p.candidateId);if(!c||c.version!==p.candidateVersion||c.image.digest!==p.imageDigest)continue;const box=document.querySelector('[data-comment="'+CSS.escape(c.id)+'"]'),button=document.querySelector('[data-select="'+CSS.escape(c.id)+'"]');box.value=p.comment||'';button.dataset.selected=String(Boolean(p.selected));button.textContent=p.selected?'Preference recorded':'Record preference';button.classList.toggle('secondary',p.selected)}revisionRequests=(data.revisionRequests||[]).filter(r=>r.setId===SET.id&&r.setVersion===SET.version&&SET.candidates.some(c=>c.id===r.candidateId&&c.version===r.candidateVersion&&c.image.digest===r.imageDigest));return save()}
grid.addEventListener('input',save);grid.addEventListener('click',e=>{const request=e.target.closest('[data-revision]');if(request){const c=SET.candidates.find(x=>x.id===request.dataset.candidate);revisionRequests.push({type:request.dataset.revision,setId:SET.id,setVersion:SET.version,candidateId:c.id,candidateVersion:c.version,imageDigest:c.image.digest,comment:document.querySelector('[data-comment="'+CSS.escape(c.id)+'"]').value,approved:false,createdAt:new Date().toISOString()});save();status(request.dataset.revision==='combine'?'Combination captured as a revision request; no combined concept is approved.':'Revision request saved; the current concept remains unchanged.');return}const b=e.target.closest('[data-select]');if(!b)return;for(const other of grid.querySelectorAll('[data-select]')){other.dataset.selected=String(other===b);other.textContent=other===b?'Preference recorded':'Record preference';other.classList.toggle('secondary',other===b)}save()});
document.getElementById('export').onclick=()=>{const blob=new Blob([JSON.stringify(read(),null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='concept-preferences.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};document.getElementById('import').onclick=()=>document.getElementById('file').click();document.getElementById('file').onchange=async e=>{try{if(restore(JSON.parse(await e.target.files[0].text())))status('Imported matching preferences.')}catch(err){status('Import failed: '+err.message)}e.target.value=''};try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved)restore(saved)}catch(e){status('Could not restore preferences; use an exported JSON file.')}
</script></body></html>`;
}

export async function assembleGallery({ conceptSet, outputDir, sourceDir, title, decodeImage }) {
  const check = validateConceptSet(conceptSet);
  if (!check.valid) throw new TypeError(check.errors.join('; '));
  if (!sourceDir) throw new TypeError('sourceDir is required to bound candidate image reads');
  const realSourceRoot = await realpath(sourceDir);
  const targetDir = path.resolve(outputDir);
  const targetParentPath = path.dirname(targetDir);
  const targetName = path.basename(targetDir);
  if (!targetName || targetName === '.' || targetName === '..') throw new TypeError('outputDir must name a child directory');
  await mkdir(targetParentPath, { recursive: true });
  const realParent = await realpath(targetParentPath);
  const realTarget = path.join(realParent, targetName);
  const sourceToTarget = path.relative(realSourceRoot, realTarget), targetToSource = path.relative(realTarget, realSourceRoot);
  if (sourceToTarget === '' || targetToSource === '' || (!sourceToTarget.startsWith('..') && !path.isAbsolute(sourceToTarget)) || (!targetToSource.startsWith('..') && !path.isAbsolute(targetToSource))) throw new TypeError('sourceDir and outputDir must be separate, non-overlapping directories');
  const safeCandidates = [];
  const writtenNames = new Set();
  const verifiedImages = [];
  for (const candidate of conceptSet.candidates) {
    const declaredPath = candidate.image.filePath ?? candidate.image.path;
    if (path.isAbsolute(declaredPath)) throw new TypeError(`candidate image path must be relative to sourceDir: ${candidate.id}`);
    const resolvedCandidate = path.resolve(realSourceRoot, declaredPath);
    const lexicalRelative = path.relative(realSourceRoot, resolvedCandidate);
    if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) throw new TypeError(`candidate image escapes sourceDir: ${candidate.id}`);
    const sourcePath = await realpath(resolvedCandidate);
    const relative = path.relative(realSourceRoot, sourcePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError(`candidate image escapes sourceDir: ${candidate.id}`);
    const verified = await validateStaticImage(sourcePath, { decodeImage });
    if (candidate.image.digest !== verified.digest) throw new Error(`image digest mismatch for candidate ${candidate.id}`);
    if (candidate.image.mimeType !== verified.mimeType) throw new Error(`image MIME mismatch for candidate ${candidate.id}`);
    if ((candidate.image.width && candidate.image.width !== verified.width) || (candidate.image.height && candidate.image.height !== verified.height)) throw new Error(`image dimensions mismatch for candidate ${candidate.id}`);
    const ext = verified.mimeType === 'image/jpeg' ? '.jpg' : verified.mimeType === 'image/webp' ? '.webp' : '.png';
    const filename = `${candidate.id.replace(/[^a-zA-Z0-9_-]/g, '-')}${ext}`;
    if (writtenNames.has(filename.toLowerCase())) throw new TypeError(`candidate IDs collide as filenames: ${candidate.id}`);
    writtenNames.add(filename.toLowerCase());
    const { filePath, ...image } = candidate.image;
    safeCandidates.push({ ...candidate, image: { ...image, path: `images/${filename}`, width: verified.width, height: verified.height, verification: verified.verification } });
    verifiedImages.push({ filename, bytes: verified.bytes });
  }
  const publishSet = { ...conceptSet, candidates: safeCandidates };
  const html = renderGalleryHtml(publishSet, title), json = JSON.stringify(publishSet, null, 2);
  let existing;
  try { existing = await lstat(realTarget); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing?.isSymbolicLink()) throw new TypeError('outputDir cannot be a symlink');
  if (existing && !existing.isDirectory()) throw new TypeError('outputDir exists and is not a directory');
  const stageDir = await mkdtemp(path.join(realParent, `.${targetName}.stage-`));
  const backupDir = `${realTarget}.backup-${randomUUID()}`;
  let movedExisting = false;
  try {
    const stageAssets = path.join(stageDir, 'images'); await mkdir(stageAssets);
    for (const image of verifiedImages) await writeFile(path.join(stageAssets, image.filename), image.bytes, { flag: 'wx' });
    await writeFile(path.join(stageDir, 'index.html'), html, { flag: 'wx' });
    await writeFile(path.join(stageDir, 'concepts.json'), json, { flag: 'wx' });
    if (existing) { await rename(realTarget, backupDir); movedExisting = true; }
    try { await rename(stageDir, realTarget); }
    catch (error) { if (movedExisting) { await rename(backupDir, realTarget); movedExisting = false; } throw error; }
    if (movedExisting) { await rm(backupDir, { recursive: true, force: true }); movedExisting = false; }
  } finally {
    await rm(stageDir, { recursive: true, force: true });
    if (movedExisting) await rename(backupDir, realTarget);
  }
  return { indexPath: path.join(realTarget, 'index.html'), assetDir: path.join(realTarget, 'images'), conceptSet: publishSet };
}
