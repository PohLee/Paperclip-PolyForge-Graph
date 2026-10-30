import { randomUUID } from 'node:crypto';

export const INTERVIEW_ARTIFACT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Interview response artifact', type: 'object', additionalProperties: false,
  required: ['id', 'kind', 'questionnaire', 'revision', 'createdAt', 'source', 'answers', 'requirements', 'history'],
  properties: {
    id: { type: 'string', minLength: 1 },
    kind: { const: 'interview_responses' },
    questionnaire: { type: 'object', required: ['id', 'version'], properties: { id: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 } }, additionalProperties: false },
    revision: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    source: { type: 'object', required: ['type'], properties: { type: { type: 'string' }, label: { type: 'string' } }, additionalProperties: true },
    answers: { type: 'array', items: { type: 'object', required: ['questionId', 'value', 'source'], properties: { questionId: { type: 'string' }, value: {}, source: { type: 'string' }, requirementKind: { enum: ['fact', 'preference', 'constraint', 'assumption'] }, updatedAt: { type: 'string' } }, additionalProperties: false } },
    requirements: { type: 'array', items: { type: 'object', required: ['id', 'kind', 'text', 'sourceRefs'], properties: { id: { type: 'string' }, kind: { enum: ['fact', 'preference', 'constraint', 'assumption', 'unknown', 'unclassified'] }, text: { type: 'string' }, sourceRefs: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
    history: { type: 'array', items: { type: 'object', required: ['revision', 'capturedAt', 'answers', 'requirements'], properties: { revision: { type: 'integer', minimum: 1 }, capturedAt: { type: 'string' }, answers: { type: 'array' }, requirements: { type: 'array' } }, additionalProperties: false } },
  },
};

export function validateInterviewArtifact(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['artifact must be an object'] };
  if (value.kind !== 'interview_responses') errors.push('kind must be interview_responses');
  if (typeof value.id !== 'string' || !value.id) errors.push('artifact id is required');
  if (!value.questionnaire?.id || !value.questionnaire?.version) errors.push('questionnaire id and version are required');
  if (!Number.isInteger(value.revision) || value.revision < 1) errors.push('revision must be a positive integer');
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) errors.push('createdAt must be a valid timestamp');
  if (!value.source || typeof value.source.type !== 'string' || !value.source.type) errors.push('source.type is required');
  const answers = Array.isArray(value.answers) ? value.answers : [];
  const requirements = Array.isArray(value.requirements) ? value.requirements : [];
  if (!Array.isArray(value.answers)) errors.push('answers must be an array');
  if (!Array.isArray(value.requirements)) errors.push('requirements must be an array');
  if (!Array.isArray(value.history)) errors.push('history must be an array');
  for (const [index, answer] of answers.entries()) {
    if (!answer?.questionId || !Object.hasOwn(answer, 'value') || !answer.source) errors.push(`answers[${index}] requires questionId, value, and source`);
  }
  for (const [index, requirement] of requirements.entries()) {
    if (!requirement?.id || !['fact', 'preference', 'constraint', 'assumption', 'unknown', 'unclassified'].includes(requirement.kind) || typeof requirement.text !== 'string' || !Array.isArray(requirement.sourceRefs)) errors.push(`requirements[${index}] is invalid`);
  }
  if (Array.isArray(value.history)) for (const [index, revision] of value.history.entries()) if (!Number.isInteger(revision?.revision) || revision.revision < 1 || !Array.isArray(revision.answers) || !Array.isArray(revision.requirements)) errors.push(`history[${index}] is invalid`);
  return { valid: errors.length === 0, errors };
}

export function createInterviewArtifact({ id = randomUUID(), questionnaire, answers, source = { type: 'local-user' }, revision = 1, requirements, history = [], createdAt = new Date().toISOString() }) {
  const normalizedAnswers = Object.entries(answers ?? {}).map(([questionId, record]) => ({
    questionId,
    value: record && typeof record === 'object' && Object.hasOwn(record, 'value') ? record.value : record,
    source: record?.source ?? source.type ?? 'user',
    ...((record?.requirementKind ?? questionnaire.questions?.find(question => question.id === questionId)?.requirementKind) ? { requirementKind: record?.requirementKind ?? questionnaire.questions?.find(question => question.id === questionId)?.requirementKind } : {}),
    updatedAt: record?.updatedAt ?? createdAt,
  }));
  const artifact = { id, kind: 'interview_responses', questionnaire: { id: questionnaire.id, version: questionnaire.version }, revision, source, createdAt, answers: normalizedAnswers, requirements: requirements ?? [], history };
  const checked = validateInterviewArtifact(artifact);
  if (!checked.valid) throw new TypeError(checked.errors.join('; '));
  return artifact;
}

export function projectRequirements(artifact) {
  return artifact.answers.map((answer, index) => {
    const rawText = typeof answer.value === 'string' ? answer.value.trim() : answer.value == null ? '' : typeof answer.value === 'boolean' ? String(answer.value) : JSON.stringify(answer.value);
    const unknown = rawText === '' || /^(unknown|not sure|i(?:'m| am) not sure|don't know|i don't know|unsure|不知道|不确定|不清楚|还不知道)$/i.test(rawText);
    const kind = unknown ? 'unknown' : ['fact', 'preference', 'constraint', 'assumption'].includes(answer.requirementKind) ? answer.requirementKind : 'unclassified';
    return { id: `REQ-${String(index + 1).padStart(3, '0')}`, kind, text: unknown ? `Unknown: ${answer.questionId}` : rawText, sourceRefs: [`answer:${answer.questionId}`] };
  });
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function safeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function renderInterviewHtml(questionnaire) {
  if (!questionnaire?.id || !questionnaire?.version || !Array.isArray(questionnaire.questions)) throw new TypeError('questionnaire needs id, version, and questions');
  for (const q of questionnaire.questions) if (!q.id || !q.label || !['text', 'textarea', 'select', 'checkbox'].includes(q.type)) throw new TypeError(`invalid question: ${q.id ?? '(missing id)'}`);
  const qjson = safeJsonForHtml(questionnaire);
  const staticPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(questionnaire.title ?? 'Design interview')}</title>
<style>:root{color-scheme:light;--ink:#172b32;--muted:#49636b;--paper:#f3f4ee;--panel:#fffefa;--accent:#075e59;--line:#cad5cf}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 system-ui,sans-serif}main{max-width:900px;margin:auto;padding:clamp(1.2rem,5vw,4.5rem)}h1{font:600 clamp(2rem,6vw,4.1rem)/1.05 Georgia,serif;max-width:14ch;margin:.4rem 0 1rem;letter-spacing:-.025em}p{max-width:68ch}.lede,.note{color:var(--muted)}.form{background:var(--panel);padding:clamp(1rem,3vw,2.25rem);border:1px solid var(--line);border-radius:14px}fieldset{border:0;border-top:1px solid var(--line);padding:1.35rem 0;margin:0}legend{font-weight:700;padding:0 .4rem 0 0;font-size:1.08rem}label{display:block;font-weight:600;margin:.7rem 0 .3rem}input,textarea,select{width:100%;font:inherit;padding:.75rem .85rem;color:var(--ink);background:white;border:1px solid #78908c;border-radius:6px}input[type=checkbox]{width:auto}textarea{min-height:7rem}button{font:inherit;font-weight:650;border:1px solid var(--accent);background:var(--accent);color:white;padding:.7rem 1rem;border-radius:6px;cursor:pointer}button.secondary{background:transparent;color:var(--accent)}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #b65d30;outline-offset:2px}.actions{display:flex;flex-wrap:wrap;gap:.65rem;margin-top:1.2rem}.status{min-height:1.6em;color:var(--muted)}.unknown{color:#6c3d21}.hidden{display:none!important}footer{margin-top:1.5rem;font-size:.9rem;color:var(--muted)}@media(max-width:560px){main{padding:1rem}.actions button{flex:1 1 40%}}</style></head><body><main><p class="lede">${escapeHtml(questionnaire.kicker ?? 'A short design interview')}</p><h1>${escapeHtml(questionnaire.title ?? 'Help us understand the work')}</h1><p class="lede">${escapeHtml(questionnaire.description ?? 'Your answers stay in this browser until you export them. No server receives this form.')}</p><form id="interview" class="form"><div id="questions"></div><p id="status" class="status" role="status" aria-live="polite">Not saved yet.</p><div class="actions"><button type="button" id="export-json">Export answers JSON</button><button type="button" class="secondary" id="export-md">Export requirements Markdown</button><button type="button" class="secondary" id="import">Import JSON</button><button type="button" class="secondary" id="clear">Clear saved answers</button><input id="file" type="file" accept="application/json,.json" hidden></div></form><footer>Answers are raw source material. The requirements export labels unanswered or uncertain items as unknown; it does not turn inference into user evidence.</footer></main>
<script>const QUESTIONNAIRE=${qjson};
const form=document.getElementById('interview'),host=document.getElementById('questions'),status=document.getElementById('status'),key='creative-interview:'+QUESTIONNAIRE.id+':'+QUESTIONNAIRE.version;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let artifact=null;
function render(){for(const q of QUESTIONNAIRE.questions){const section=document.createElement('fieldset');section.dataset.question=q.id;const legend=document.createElement('legend');legend.textContent=q.legend||q.label;section.append(legend);if(q.help){const help=document.createElement('p');help.textContent=q.help;help.className='note';section.append(help)}let input;if(q.type==='textarea'){input=document.createElement('textarea')}else if(q.type==='select'){input=document.createElement('select');const empty=document.createElement('option');empty.value='';empty.textContent='Choose…';input.append(empty);for(const option of q.options||[]){const o=document.createElement('option');o.value=option.value;o.textContent=option.label;input.append(o)}}else{input=document.createElement('input');input.type=q.type}input.id='answer-'+q.id;input.name=q.id;input.setAttribute('aria-label',q.label);if(q.placeholder)input.placeholder=q.placeholder;if(q.required)input.required=true;section.append(input);if(q.unknownAllowed){const u=document.createElement('p');u.className='note';u.textContent='If this is unknown, leave it blank or write “Not sure.”';section.append(u)}if(q.when){section.dataset.parent=q.when.questionId;section.dataset.equals=String(q.when.equals);section.hidden=true}host.append(section)}updateConditions()}
function values(){const out={};for(const q of QUESTIONNAIRE.questions){const el=form.elements.namedItem(q.id);if(el)out[q.id]=q.type==='checkbox'?el.checked:el.value}return out}
function updateConditions(){for(const section of host.querySelectorAll('[data-parent]')){const parent=form.elements.namedItem(section.dataset.parent),value=parent?.type==='checkbox'?parent.checked:parent?.value;section.hidden=!parent||String(value)!==section.dataset.equals}}
function requirements(answers){return answers.map((answer,index)=>{const value=answer.value,text=typeof value==='string'?value.trim():value==null?'':String(value),unknown=text===''||/^(unknown|not sure|i(?:'m| am) not sure|don't know|i don't know|unsure|不知道|不确定|不清楚|还不知道)$/i.test(text);return{id:'REQ-'+String(index+1).padStart(3,'0'),kind:unknown?'unknown':['fact','preference','constraint','assumption'].includes(answer.requirementKind)?answer.requirementKind:'unclassified',text:unknown?'Unknown: '+answer.questionId:text,sourceRefs:['answer:'+answer.questionId]}})}
function capturedAnswers(){const current=values(),now=new Date().toISOString();return QUESTIONNAIRE.questions.map(q=>({questionId:q.id,value:current[q.id],source:'respondent',...(q.requirementKind?{requirementKind:q.requirementKind}:{}),updatedAt:now}))}
function save(){const answers=capturedAnswers();if(!artifact){artifact={id:crypto.randomUUID(),kind:'interview_responses',questionnaire:{id:QUESTIONNAIRE.id,version:QUESTIONNAIRE.version},revision:1,createdAt:new Date().toISOString(),source:{type:'local-user'},answers,requirements:requirements(answers),history:[]}}else if(JSON.stringify(artifact.answers.map(a=>[a.questionId,a.value]))!==JSON.stringify(answers.map(a=>[a.questionId,a.value]))){artifact.history.push({revision:artifact.revision,capturedAt:new Date().toISOString(),answers:artifact.answers,requirements:artifact.requirements});artifact={...artifact,revision:artifact.revision+1,answers,requirements:requirements(answers)}}try{localStorage.setItem(key,JSON.stringify(artifact));status.textContent='Revision '+artifact.revision+' saved in this browser.';status.className='status'}catch(error){status.textContent='Local save failed. Export JSON to keep these answers.';status.className='status unknown'}}
function restore(data){if(data?.questionnaire?.id!==QUESTIONNAIRE.id)throw Error('This file belongs to a different questionnaire.');if(data?.questionnaire?.version!==QUESTIONNAIRE.version)throw Error('Questionnaire version '+String(data?.questionnaire?.version)+' does not match '+QUESTIONNAIRE.version+'. An explicit migration is required.');if(data.kind!=='interview_responses'||!data.id||!Number.isInteger(data.revision)||!Array.isArray(data.answers)||!Array.isArray(data.requirements)||!Array.isArray(data.history))throw Error('This is not a canonical revisioned interview artifact.');artifact=JSON.parse(JSON.stringify(data));for(const q of QUESTIONNAIRE.questions){const answer=artifact.answers.find(item=>item.questionId===q.id);if(!answer)continue;const el=form.elements.namedItem(q.id);if(el){if(q.type==='checkbox')el.checked=answer.value===true;else el.value=String(answer.value??'')}}updateConditions();try{localStorage.setItem(key,JSON.stringify(artifact));return true}catch(error){status.textContent='Answers loaded, but local save failed. Export JSON to keep these answers.';status.className='status unknown';return false}}
function download(name,text,type){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function md(){save();const lines=['# Interview requirements','','Questionnaire: '+artifact.questionnaire.id+' v'+artifact.questionnaire.version,'Revision: '+artifact.revision,'','## Raw answers'];for(const answer of artifact.answers){const q=QUESTIONNAIRE.questions.find(item=>item.id===answer.questionId),requirement=artifact.requirements.find(item=>item.sourceRefs.includes('answer:'+answer.questionId));lines.push('','### '+(q?.label||answer.questionId),requirement?.kind==='unknown'?'**Unknown**':String(answer.value),'Source: '+answer.source+' ('+answer.questionId+')')}lines.push('','## Requirements projection','');for(const req of artifact.requirements)lines.push('- ['+req.kind+'] '+req.text+' (source: '+req.sourceRefs.join(', ')+')');return lines.join(String.fromCharCode(10))}
render();try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved){if(restore(saved)){status.textContent='Restored saved revision '+artifact.revision+' from this browser.';status.className='status'}}}catch(error){status.textContent='Could not restore saved answers. You can import a JSON backup.';status.className='status unknown'}
form.addEventListener('input',()=>{updateConditions();save()});form.addEventListener('change',()=>{updateConditions();save()});document.getElementById('export-json').onclick=()=>{save();download('interview-answers.json',JSON.stringify(artifact,null,2),'application/json')};document.getElementById('export-md').onclick=()=>download('requirements.md',md(),'text/markdown');document.getElementById('import').onclick=()=>document.getElementById('file').click();document.getElementById('file').onchange=async e=>{try{const stored=restore(JSON.parse(await e.target.files[0].text()));if(stored){status.textContent='Imported revision '+artifact.revision+' and saved in this browser.';status.className='status'}}catch(error){status.textContent='Import failed: '+error.message;status.className='status unknown'}e.target.value=''};document.getElementById('clear').onclick=()=>{try{localStorage.removeItem(key);form.reset();artifact=null;updateConditions();status.textContent='Saved answers cleared.'}catch(error){status.textContent='Could not clear local storage.';status.className='status unknown'}};
</script></body></html>`;
  return staticPage;
}
