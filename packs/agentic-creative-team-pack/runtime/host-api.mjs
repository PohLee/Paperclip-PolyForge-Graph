import { createHash } from 'node:crypto';
import { readFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { graphs } from '../graphs/catalog.mjs';
import { renderGalleryHtml, validateConceptSet, validateSelection, validateStaticImage } from '../adapters/concept-gallery/index.mjs';
import { assertCreativeArtifact, validateCreativeArtifact } from '../contracts/validate.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const stableJson=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item);
const refId=ref=>ref?.id??ref?.artifactId;
const isRef=value=>value&&typeof value==='object'&&refId(value)&&value.version;
const successOutcomes=new Set(['ready','complete','verified','accepted']);

function latestPayload(run,nodeId,kind) {
  const attempts=run.nodeStates[nodeId]?.attempts??[];
  for(let i=attempts.length-1;i>=0;i--) {
    const value=attempts[i].output?.creativeArtifacts?.[kind];
    if(value)return value;
  }
  return null;
}
function records(run) {
  return run.graph.nodes.flatMap(node=>(run.nodeStates[node.id]?.attempts??[]).flatMap(attempt=>(attempt.artifacts??[]).map(item=>({item,attempt,node, payload:attempt.output?.creativeArtifacts?.[item.kind]}))));
}
function exactRecord(run,ref) { return records(run).find(row=>row.item.id===refId(ref)&&row.item.version===ref.version); }
function getGraph(packId,graphId) { return packId==='creative-team'?graphs.find(g=>g.id===graphId):undefined; }
function requestedCount(run) { return run.input.creative_brief?.requestedCount??run.input.requestedCount; }
function systemExpectedRef(run) { return run.input.designBaselineRef??run.input.bootstrapRef; }
function asRefs(candidates) { return candidates.map(c=>({id:c.id,version:c.version})); }
function refsEqual(left,right) {
  return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((ref,index)=>refId(ref)===refId(right[index])&&ref.version===right[index].version&&ref.digest===right[index].digest);
}

async function insideRoot(root, relative) {
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').includes('..')) throw new Error('Artifact paths must be safe relative paths');
  const realRoot=await realpath(root), candidate=path.resolve(realRoot,relative), rel=path.relative(realRoot,candidate);
  if(rel.startsWith('..')||path.isAbsolute(rel)) throw new Error('Artifact path escapes the run artifact directory');
  const realCandidate=await realpath(candidate), realRel=path.relative(realRoot,realCandidate);
  if(realRel.startsWith('..')||path.isAbsolute(realRel)) throw new Error('Artifact symlink escapes the run artifact directory');
  return {realRoot,realCandidate};
}

export function createCreativeHostApi({engine,artifactRootForRun,hasImageProvider,decodeImage,loadExternalArtifact,getArtifactProvenance,resolveDecisionEvidence,resolveActor}={}) {
  if(!engine) throw new TypeError('engine is required');
  const rootFor=async run=>{
    const root=typeof artifactRootForRun==='function'?await artifactRootForRun(run):artifactRootForRun;
    if(!root) throw new Error('Trusted artifact storage root is not configured for this run');
    return root;
  };
  async function trustedActor(claimedActor,context) {
    if(typeof resolveActor!=='function') throw new Error('Trusted host actor resolver is required; caller-supplied actor fields are not accepted');
    const actor=await resolveActor({claimedActor,context});
    if(!actor||typeof actor.id!=='string'||!['agent','human'].includes(actor.kind)||!Array.isArray(actor.roles)||typeof actor.executionId!=='string'||!actor.executionId) throw new Error('Host actor resolver returned an invalid authenticated actor');
    return actor;
  }
  async function externalRecord(ref,kind,context={}) {
    if(!isRef(ref)||!kind) throw new Error('External artifact references require explicit kind, id, and version');
    if(ref.kind&&ref.kind!==kind) throw new Error(`External reference kind ${ref.kind} does not match ${kind}`);
    if(typeof loadExternalArtifact!=='function') throw new Error(`Trusted artifact loader is not configured for ${kind}`);
    const row=await loadExternalArtifact({ref,kind,...context});
    if(!row||row.id!==refId(ref)||row.version!==ref.version||row.kind!==kind||!row.payload||typeof row.payload!=='object') throw new Error(`Host artifact store did not return the exact ${kind} artifact version`);
    assertCreativeArtifact(kind,row.payload);
    if(row.payload.id!==row.id||row.payload.version!==row.version) throw new Error(`Loaded ${kind} payload identity differs from its trusted record`);
    const observedDigest=digest(Buffer.from(stableJson(row.payload)));
    if(row.digest!==observedDigest||(ref.digest&&ref.digest!==observedDigest)) throw new Error(`Loaded ${kind} bytes do not match their immutable SHA-256 reference`);
    return row;
  }
  async function inputArtifact(input,field,kind,context={}) {
    const ref=input?.[field];
    if(!isRef(ref)) throw new Error(`${field} must be an exact id/version reference`);
    return externalRecord(ref,kind,{...context,input});
  }
  async function verifyExternalSetImages(record) {
    if(!record.artifactRoot) throw new Error('External concept set has no trusted artifact root');
    for(const candidate of record.payload.candidates) {
      const {realCandidate}=await insideRoot(record.artifactRoot,candidate.image.path);
      const observed=await validateStaticImage(realCandidate,{decodeImage});
      if(observed.digest!==candidate.image.digest||observed.mimeType!==candidate.image.mimeType||observed.width!==candidate.image.width||observed.height!==candidate.image.height) throw new Error(`External concept ${candidate.id} bytes do not match its metadata`);
    }
  }
  async function verifyRef(run,ref,kind,context={}) {
    if(!isRef(ref)) throw new Error(`${kind} link must be an exact id/version reference`);
    if(ref.kind&&ref.kind!==kind) throw new Error(`Reference kind ${ref.kind} does not match required ${kind}`);
    const local=exactRecord(run,ref);
    if(local) {
      if(local.item.kind!==kind) throw new Error(`Reference ${refId(ref)} is ${local.item.kind}, expected ${kind}`);
      return local.payload;
    }
    return (await externalRecord(ref,kind,{run,input:run.input,...context})).payload;
  }
  function selectedConcept(run) {
    const set=run.input.concept_set,selection=run.input.concept_selection;
    if(!validateSelection(selection,set).valid) throw new Error('Run does not contain a current human-selected concept');
    return set.candidates.find(candidate=>candidate.id===selection.candidateId);
  }
  function assertSelectedConceptRef(run,ref) {
    const selected=selectedConcept(run);
    if(!isRef(ref)||refId(ref)!==selected.id||ref.version!==selected.version||(ref.imageDigest&&ref.imageDigest!==selected.image.digest)) throw new Error('Design output must remain bound to the exact human-selected concept id, version, and digest (imageDigest)');
    return selected;
  }
  async function requireDecision(run,nodeId,outcome) {
    const rows=await engine.listDecisions({runId:run.id});
    const row=rows.filter(item=>item.nodeId===nodeId&&item.status==='decided').at(-1);
    if(!row||row.outcome!==outcome) throw new Error(`Package publication requires the ${nodeId} decision to be ${outcome}`);
    return {id:row.id,version:row.at};
  }
  async function verifyImage(run,kind,candidate) {
    const root=await rootFor(run),{realCandidate}=await insideRoot(root,candidate.image.path);
      const observed=await validateStaticImage(realCandidate,{decodeImage});
    if(observed.digest!==candidate.image.digest||observed.mimeType!==candidate.image.mimeType||
      (candidate.image.width&&candidate.image.width!==observed.width)||(candidate.image.height&&candidate.image.height!==observed.height)) throw new Error(`Real image bytes do not match ${kind} metadata`);
    return observed;
  }
  async function verifiedSet(run) {
    const set=latestPayload(run,'freeze-concept-set','concept_set');
    const check=validateConceptSet(set);
    if(!check.valid) throw new Error(`Concept set invalid: ${check.errors.join('; ')}`);
    if(set.requestedCount!==requestedCount(run)) throw new Error('Concept set count differs from the frozen brief');
    const renderNodes=run.graph.nodes.filter(node=>/^render-\d\d$/.test(node.id)&&run.nodeStates[node.id]?.status==='completed');
    if(renderNodes.length!==set.requestedCount) throw new Error('Concept set does not match the exact number of completed render branches');
    const expected=new Set(renderNodes.map(node=>`concept_image_${node.id.slice(-2)}`));
    for(const candidate of set.candidates) {
      const pair=records(run).find(row=>expected.has(row.item.kind)&&row.item.id===candidate.id&&row.item.version===candidate.version);
      if(!pair) throw new Error(`Concept ${candidate.id}@${candidate.version} is not a current render artifact`);
      if(pair.payload?.image?.digest!==candidate.image.digest||pair.payload?.image?.path!==candidate.image.path) throw new Error(`Concept ${candidate.id} changed after its render artifact was frozen`);
      await verifyImage(run,pair.item.kind,candidate);
    }
    return set;
  }
  async function verifyGallery(run,payload,set) {
    const root=await rootFor(run),{realRoot,realCandidate}=await insideRoot(root,payload.path);
    if(path.basename(realCandidate).toLowerCase()!=='index.html') throw new Error('Gallery artifact must be the single index.html comparison page');
    const files=await readdir(path.dirname(realCandidate));
    if(files.filter(name=>name.toLowerCase().endsWith('.html')).length!==1) throw new Error('Gallery output must contain exactly one HTML page');
    const html=await readFile(realCandidate);
    if(digest(html)!==payload.digest) throw new Error('Gallery HTML digest does not match saved bytes');
    const source=html.toString('utf8');
    if(payload.runnablePrototype===true||/data-product-prototype\s*=\s*["']true/i.test(source)) throw new Error('Gallery must not be represented as runnable product prototypes');
    if(payload.setRef.id!==set.id||payload.setRef.version!==set.version) throw new Error('Gallery is not bound to the current concept set version');
    const expectedSet={...set,candidates:set.candidates.map(candidate=>{
      const extension=candidate.image.mimeType==='image/jpeg'?'.jpg':candidate.image.mimeType==='image/webp'?'.webp':'.png';
      const filename=`${candidate.id.replace(/[^a-zA-Z0-9_-]/g,'-')}${extension}`;
      const {filePath,...image}=candidate.image;
      return {...candidate,image:{...image,path:`images/${filename}`,verification:image.mimeType==='image/png'?'decoded':'decoded-by-host'}};
    })};
    const expectedHtml=renderGalleryHtml(expectedSet,payload.title??'Concept gallery');
    if(source!==expectedHtml) throw new Error('Gallery HTML differs from the trusted static comparison renderer output');
    for(const candidate of set.candidates) {
      const extension=candidate.image.mimeType==='image/jpeg'?'.jpg':candidate.image.mimeType==='image/webp'?'.webp':'.png';
      const filename=`${candidate.id.replace(/[^a-zA-Z0-9_-]/g,'-')}${extension}`;
      const {realCandidate:imagePath}=await insideRoot(path.dirname(realCandidate),`images/${filename}`);
      const observed=await validateStaticImage(imagePath,{decodeImage});
      if(observed.digest!==candidate.image.digest||observed.mimeType!==candidate.image.mimeType||observed.width!==candidate.image.width||observed.height!==candidate.image.height) throw new Error(`Gallery bundle image bytes differ from candidate ${candidate.id}`);
    }
    return {path:realCandidate,root:realRoot};
  }
  async function requireDecisionEvidence(run,nodeId,outcome) {
    const node=run.graph.nodes.find(item=>item.id===nodeId);
    if(!node||node.type!=='decision') throw new Error('Decision evidence requested for a non-decision node');
    const prior=await engine.listDecisions({runId:run.id});
    if(nodeId==='choose-count'&&outcome!==String(requestedCount(run))) throw new Error('The selected branch count must match the count frozen in the brief');
    if(nodeId==='brand-evidence-disposition'&&outcome==='sufficient') {
      const ledger=latestPayload(run,'brand-evidence','brand_evidence_ledger');
      if(!ledger||!Array.isArray(ledger.claims)) throw new Error('Positioning requires an evaluated evidence ledger; otherwise route to needs-evidence');
      const supported=ledger.claims.filter(claim=>['supported','verified'].includes(claim?.assessment??claim?.status));
      if(!supported.length) throw new Error('Sufficient evidence needs at least one explicitly supported claim; otherwise route to needs-evidence');
      for(const claim of ledger.claims) {
        if(!claim||typeof claim.text!=='string'||!claim.text.trim()||!['supported','verified','unsupported','disputed','hypothesis','assumption'].includes(claim.assessment??claim.status)) throw new Error('Every evidence-ledger claim needs text and an explicit evaluated status');
        if(['supported','verified'].includes(claim.assessment??claim.status)) {
          if(!Array.isArray(claim.sourceRefs)||!claim.sourceRefs.length) throw new Error('Every supported factual claim needs exact source references');
          for(const ref of claim.sourceRefs) await verifyRef(run,ref,ref.kind??'research_evidence');
        }
      }
    }
    if(nodeId==='set-status'&&outcome==='complete') {
      const review=latestPayload(run,'review-set','concept_set_review');
      if(review?.disposition!=='complete') throw new Error('Cannot complete a concept set without a complete review');
      if(review.candidateRefs?.length!==requestedCount(run)) throw new Error('Review does not reference every requested concept candidate');
      for(const ref of review.candidateRefs) if(!exactRecord(run,ref)) throw new Error('Concept review references a missing or stale candidate');
    }
    if(nodeId==='set-status'&&outcome==='incomplete') {
      const review=latestPayload(run,'review-set','concept_set_review');
      if(!review||review.disposition==='complete') throw new Error('Incomplete disposition needs a review documenting an actual gap');
    }
    const gates={
      'brand-disposition':{ready:['brand_review','brand-review','accepted']},
      'web-design-disposition':{ready:['web_design_review','fidelity-review','complete']},
      'saas-disposition':{ready:['saas_design_review','saas-independent-review','complete']},
      'system-disposition':{accepted:['design_system_review','impact-review','accepted']},
      'assurance-disposition':{verified:['design_review','disposition','verified']},
      'campaign-disposition':{ready:['campaign_review','campaign-review','accepted']},
    };
    const gate=gates[nodeId]?.[outcome];
    if(gate) {
      const report=latestPayload(run,gate[1],gate[0]);
      if(!report||report.disposition!==gate[2]) throw new Error(`${nodeId} ${outcome} requires matching review disposition evidence`);
      if(report.findings?.some(f=>!['resolved','accepted-exception'].includes(f.status))) throw new Error(`${nodeId} cannot accept unresolved findings`);
      if(report.unverified===true) throw new Error(`${nodeId} cannot accept unverified evidence`);
      if(gate[0]==='web_design_review') {
        assertSelectedConceptRef(run,report.conceptRef);
        for(const [field,nodeIdRef,kind] of [['pageMapRef','map-page','page_section_map'],['desktopRef','desktop-design','desktop_web_design'],['mobileRef','mobile-design','mobile_web_design']]) {
          const produced=latestPayload(run,nodeIdRef,kind);
          if(!produced||!isRef(report[field])||refId(report[field])!==produced.id||report[field].version!==produced.version) throw new Error(`Web acceptance review must cite the exact ${field} version`);
        }
      }
      if(gate[0]==='saas_design_review') {
        const handoff=latestPayload(run,'handoff','creative_design_handoff');
        if(!handoff||refId(report.handoffRef)!==handoff.id||report.handoffRef.version!==handoff.version) throw new Error('SaaS acceptance review must cite the exact handoff version');
      }
      if(['web_design_review','saas_design_review','design_review'].includes(gate[0])) {
        const priorAuthors=report.subjectAuthorExecutionIds??[];
        if(!priorAuthors.length) throw new Error('Review report must identify trusted candidate author executions');
        if(priorAuthors.includes(report.reviewerExecutionId)) throw new Error('Review execution must differ from all candidate author executions');
      }
    }
    const rule=run.pack.decisionRules.find(item=>item.type===node.decisionType&&item.mode===run.mode);
    if(!rule||!rule.requiredEvidence?.length) throw new Error(`No explicit evidence rule for ${node.decisionType}/${run.mode}`);
    if(typeof resolveDecisionEvidence!=='function') throw new Error('Trusted decision-evidence resolver is not configured');
    const evidence=await resolveDecisionEvidence({run,node,outcome,requiredKinds:rule.requiredEvidence});
      if(!Array.isArray(evidence)||rule.requiredEvidence.some(kind=>!evidence.some(item=>item.kind===kind&&item.payload&&typeof item.payload==='object'))) throw new Error(`Trusted evidence is incomplete for ${node.decisionType}`);
    for(const item of evidence) {
      const refs=[...(item.subjectRefs??[]),...(item.sourceRef&&typeof item.sourceRef==='object'?[item.sourceRef]:[])];
      if(!refs.length) throw new Error(`Evidence ${item.kind} has no versioned source reference`);
    for(const ref of refs) if(!exactRecord(run,ref)) await externalRecord(ref,ref.kind??item.sourceKind??item.kind,{run,input:run.input,actor:{id:item.actorId}});
    }
    return evidence;
  }

  return Object.freeze({
    async startRun(args) {
      const actor=await trustedActor(args.actor,{operation:'startRun',packId:args.packId,graphId:args.graphId});
      const graph=getGraph(args.packId,args.graphId);
      if(!graph) throw new Error(`Unknown creative graph: ${args.graphId}`);
      const input={...(args.input??{})};
      if(input.creative_brief) assertCreativeArtifact('creative_brief',input.creative_brief);
      const surfaceRequired=['concept-sprint','concept-to-web-design','saas-feature-design'].includes(args.graphId);
      if(surfaceRequired&&!['persuade','operate','read','experience'].includes(input.creative_brief?.surfaceMode)) throw new Error(`${args.graphId} requires a concrete creative_brief.surfaceMode`);
      if(['brand-foundation','concept-sprint','concept-to-web-design','saas-feature-design','brand-campaign-assets'].includes(args.graphId)&&!input.creative_brief) throw new Error(`${args.graphId} requires a validated creative_brief`);
      if(['brand-foundation','brand-campaign-assets'].includes(args.graphId)&&input.creative_brief?.surfaceMode!=null&&!['persuade','operate','read','experience'].includes(input.creative_brief.surfaceMode)) throw new Error('surfaceMode must be a supported mode when supplied');
      if(args.graphId==='concept-sprint') {
        const briefCount=input.creative_brief?.requestedCount,topCount=input.requestedCount;
        if(briefCount!=null&&topCount!=null&&briefCount!==topCount) throw new Error('requestedCount must match creative_brief.requestedCount');
        const count=briefCount??topCount??3;
        if(![3,4,5].includes(count)) throw new Error('Concept sprint requires targetCount 3, 4, or 5');
        input.requestedCount=count;
        input.creative_brief={...input.creative_brief,requestedCount:count};
        if(!input.imageProviderId||typeof hasImageProvider!=='function'||!await hasImageProvider(input.imageProviderId)) throw new Error('Concept sprint needs an installed, authorized image provider');
        if(!artifactRootForRun) throw new Error('Trusted artifact storage root is not configured');
      }
      if(args.graphId==='concept-to-web-design') {
        const setRecord=await inputArtifact(input,'conceptSetRef','concept_set',{actor});
        const selectionRecord=await inputArtifact(input,'conceptSelectionRef','concept_selection',{actor});
        await verifyExternalSetImages(setRecord);
        if(!validateSelection(selectionRecord.payload,setRecord.payload).valid) throw new Error('Web design needs a current selection bound to the exact set, concept, version, and image digest');
        if(typeof getArtifactProvenance!=='function') throw new Error('Trusted selection provenance resolver is required');
        const selectionAuthors=await getArtifactProvenance(input.conceptSelectionRef);
        if(!Array.isArray(selectionAuthors)||!selectionAuthors.some(author=>author.kind==='human'&&author.roles?.includes('human-owner'))) throw new Error('Concept selection must be an authenticated human-owner preference record');
        input.concept_set=setRecord.payload;
        input.concept_selection=selectionRecord.payload;
      }
      if(args.graphId==='saas-feature-design') {
        const baseline=await inputArtifact(input,'designBaselineRef','design_baseline',{actor});
        input.design_baseline=baseline.payload;
        if(!Array.isArray(input.beContracts)||!input.beContracts.length||!input.beContracts.every(isRef)) throw new Error('SaaS design needs exact versioned BE contract references');
        for(const ref of input.beContracts) {
          if(ref.kind!=='be_contract'||!/^[a-f0-9]{64}$/.test(ref.digest??'')) throw new Error('Every pinned BE contract ref must include kind=be_contract and its exact SHA-256 digest');
          await externalRecord(ref,'be_contract',{actor,input});
        }
      }
      if(args.graphId==='design-system-evolution') {
        if(input.designBaselineRef&&input.bootstrapRef) throw new Error('Choose an existing design baseline or an explicit bootstrap context, not both');
        if(input.designBaselineRef) {
          const baseline=await inputArtifact(input,'designBaselineRef','design_baseline',{actor});
          input.design_baseline=baseline.payload;
        } else {
          if(!isRef(input.bootstrapRef)||!['brand_baseline','concept_selection'].includes(input.bootstrapRef.kind)) throw new Error('Design-system bootstrap needs a pinned brand_baseline or concept_selection reference');
          const bootstrap=await externalRecord(input.bootstrapRef,input.bootstrapRef.kind,{actor,input});
          input[input.bootstrapRef.kind]=bootstrap.payload;
          if(input.bootstrapRef.kind==='concept_selection') {
            const set=await inputArtifact(input,'conceptSetRef','concept_set',{actor});
            await verifyExternalSetImages(set);
            if(!validateSelection(bootstrap.payload,set.payload).valid) throw new Error('Bootstrap concept selection must bind the exact current concept set');
            const authors=await getArtifactProvenance?.(input.bootstrapRef);
            if(!Array.isArray(authors)||!authors.some(author=>author.kind==='human'&&author.roles?.includes('human-owner'))) throw new Error('Bootstrap concept selection must be authenticated human preference');
            input.concept_set=set.payload;
          }
        }
      }
      // Strategy-only intake may have no surface. The first evidence decision routes unsupported claims to needs-evidence.
      if(args.graphId==='brand-campaign-assets') {
        const baseline=await inputArtifact(input,'brandBaselineRef','brand_baseline',{actor});
        input.brand_baseline=baseline.payload;
      }
      if(args.graphId==='design-assurance') {
        if(!Array.isArray(input.reviewSubjectRefs)||!input.reviewSubjectRefs.length||!input.reviewSubjectRefs.every(isRef)) throw new Error('Design assurance needs exact reviewSubjectRefs before review begins');
        for(const ref of input.reviewSubjectRefs) await externalRecord(ref,ref.kind??'design_artifact',{actor,input});
      }
      return engine.startRun({...args,input,actor});
    },

    async submitNode({runId,nodeId,actor,output={},artifacts=[],payloads={},...rest}) {
      const run=await engine.getRun(runId); if(!run||run.packId!=='creative-team') throw new Error('Creative run not found');
      actor=await trustedActor(actor,{operation:'submitNode',run,nodeId});
      const node=run.graph.nodes.find(n=>n.id===nodeId); if(!node||!['task','join','end'].includes(node.type)) throw new Error('Creative work node not found');
      if(!(await engine.getReadyNodes(runId)).some(n=>n.id===nodeId)) throw new Error('Creative task is not ready');
      if(node.type==='join'||node.type==='end') {
        if(artifacts.length||Object.keys(payloads).length) throw new Error('Automatic join/end nodes do not accept artifact payloads');
        return engine.submitNode({runId,nodeId,actor,output,...rest});
      }
      const requiredKinds=node.produces??[];
      if(requiredKinds.length!==artifacts.length||requiredKinds.some(kind=>!artifacts.some(a=>a.kind===kind))) throw new Error(`Task ${nodeId} must submit every declared output artifact`);
      const enrichedPayloads={...payloads};
      for(const artifact of artifacts) {
        const payload=enrichedPayloads[artifact.kind];
        if(!payload) throw new Error(`Payload required for ${artifact.kind}`);
        if(payload.id!==artifact.id||payload.version!==artifact.version) throw new Error(`Artifact envelope identity differs from ${artifact.kind} payload`);
        assertCreativeArtifact(/^concept_image_\d\d$/.test(artifact.kind)?'concept_candidate':artifact.kind,payload);
        if(/^concept_image_\d\d$/.test(artifact.kind)) await verifyImage(run,artifact.kind,payload);
        if(artifact.kind==='concept_set') {
          for(const candidate of payload.candidates) await verifyImage(run,'concept_set',candidate);
        }
        if(artifact.kind==='concept_gallery') {
          const set=latestPayload(run,'freeze-concept-set','concept_set');
          if(!set) throw new Error('Gallery cannot be assembled without the reviewed concept set');
          await verifyGallery(run,payload,set);
        }
        const linkKinds={
          brand_baseline:{strategyRef:'brand_strategy',identityRef:'brand_identity_system',voiceRef:'brand_voice_system'},
          web_design_package:{conceptRef:'concept_candidate',pageMapRef:'page_section_map',desktopRef:'desktop_web_design',mobileRef:'mobile_web_design',reviewRef:'web_design_review'},
          saas_design_package:{handoffRef:'creative_design_handoff',baselineRef:'design_baseline',apiContractRefs:'be_contract',stateMatrixRef:'saas_state_permission_matrix',reviewRef:'saas_design_review'},
          design_baseline:{tokensRef:'design_system_inventory',componentsRef:'design_system_change_proposal',patternsRef:'design_system_validation',migrationRef:'design_system_review'},
          campaign_asset_package:{conceptRef:'campaign_concept'},
          campaign_final_package:{brandBaselineRef:'brand_baseline',conceptRef:'campaign_concept',assetPackageRef:'campaign_asset_package',reviewRef:'campaign_review'},
        }[artifact.kind]??{};
        if(artifact.kind==='web_design_package') assertSelectedConceptRef(run,payload.conceptRef);
        for(const [field,kind] of Object.entries(linkKinds)) {
          const value=payload[field];
          for(const ref of Array.isArray(value)?value:[value]) await verifyRef(run,ref,kind,{actor});
        }
        if(['brand_baseline','design_baseline','campaign_final_package'].includes(artifact.kind)) {
          const {decisionNode,outcome}=artifact.kind==='brand_baseline'?{decisionNode:'brand-disposition',outcome:'ready'}:artifact.kind==='design_baseline'?{decisionNode:'system-disposition',outcome:'accepted'}:{decisionNode:'campaign-disposition',outcome:'ready'};
          const expected=await requireDecision(run,decisionNode,outcome),actual=payload.decisionRef;
          if(!isRef(actual)||refId(actual)!==expected.id||actual.version!==expected.version) throw new Error(`${artifact.kind} must reference the exact accepted decision record`);
        }
        if(artifact.kind==='brand_baseline') {
          const strategy=latestPayload(run,'positioning','brand_strategy'),identity=latestPayload(run,'identity-system','brand_identity_system'),voice=latestPayload(run,'voice-system','brand_voice_system');
          if(payload.strategyRef.id!==strategy?.id||payload.strategyRef.version!==strategy?.version||payload.identityRef.id!==identity?.id||payload.identityRef.version!==identity?.version||payload.voiceRef.id!==voice?.id||payload.voiceRef.version!==voice?.version) throw new Error('Brand baseline must pin the exact strategy, identity, and voice artifacts reviewed');
        }
        if(artifact.kind==='web_design_package'&&payload.reviewRef.id!==latestPayload(run,'fidelity-review','web_design_review')?.id) throw new Error('Web package must pin the exact fidelity review');
        if(artifact.kind==='saas_design_package'&&payload.reviewRef.id!==latestPayload(run,'saas-independent-review','saas_design_review')?.id) throw new Error('SaaS package must pin the exact independent review');
        if(artifact.kind==='campaign_final_package') {
          const review=latestPayload(run,'campaign-review','campaign_review'),assets=latestPayload(run,'produce-assets','campaign_asset_package');
          if(payload.reviewRef.id!==review?.id||payload.assetPackageRef.id!==assets?.id) throw new Error('Campaign package must pin the exact reviewed asset package and review');
        }
      }
      if(nodeId==='review-set') {
        const review=payloads.concept_set_review;
        if(!review||!['complete','incomplete','blocked'].includes(review.disposition)) throw new Error('Concept review needs an explicit disposition');
        const renderRows=run.graph.nodes.filter(n=>/^render-\d\d$/.test(n.id)&&run.nodeStates[n.id]?.status==='completed').map(n=>({node:n,payload:latestPayload(run,n.id,`concept_image_${n.id.slice(-2)}`)}));
        const refs=review.candidateRefs??[];
        if(review.disposition==='complete'&&renderRows.length!==requestedCount(run)) throw new Error('Review cannot mark an incomplete render set complete');
        if(refs.length!==renderRows.length) throw new Error('Review must account for every completed render candidate');
        for(const row of renderRows) {
          if(!row.payload) throw new Error(`Render node ${row.node.id} is missing its saved candidate payload`);
          const ref=refs.find(item=>refId(item)===row.payload.id&&item.version===row.payload.version);
          if(!ref) throw new Error(`Review omits candidate ${row.payload.id}@${row.payload.version}`);
          if(review.disposition==='complete') await verifyImage(run,row.node.id,row.payload);
        }
      }
      if(nodeId==='interpret-selection') assertSelectedConceptRef(run,enrichedPayloads.direction_contract.conceptRef);
      if(nodeId==='map-page') {
        const direction=latestPayload(run,'interpret-selection','direction_contract');
        if(!direction||refId(enrichedPayloads.page_section_map.conceptRef)!==refId(direction.conceptRef)||enrichedPayloads.page_section_map.conceptRef.version!==direction.conceptRef.version) throw new Error('Page map must preserve the selected concept version');
        assertSelectedConceptRef(run,enrichedPayloads.page_section_map.conceptRef);
      }
      if(nodeId==='desktop-design'||nodeId==='mobile-design') {
        const map=latestPayload(run,'map-page','page_section_map'),design=enrichedPayloads[node.produces[0]];
        if(!map||refId(design.pageRef)!==map.id||design.pageRef.version!==map.version) throw new Error('Desktop/mobile design must cover the exact page map');
        assertSelectedConceptRef(run,design.conceptRef);
      }
      if(nodeId==='fidelity-review') assertSelectedConceptRef(run,enrichedPayloads.web_design_review.conceptRef);
      if(nodeId==='publish-web-package') {
        const map=latestPayload(run,'map-page','page_section_map'),desktop=latestPayload(run,'desktop-design','desktop_web_design'),mobile=latestPayload(run,'mobile-design','mobile_web_design'),review=latestPayload(run,'fidelity-review','web_design_review');
        const pkg=enrichedPayloads.web_design_package;
        assertSelectedConceptRef(run,pkg.conceptRef);
        for(const [field,expected] of [['pageMapRef',map],['desktopRef',desktop],['mobileRef',mobile],['reviewRef',review]]) if(!expected||refId(pkg[field])!==expected.id||pkg[field].version!==expected.version) throw new Error(`Web design package must pin the exact ${field} artifact`);
      }
      if(nodeId==='read-baseline') {
        const pinned=enrichedPayloads.pinned_design_context;
        if(refId(pinned.designBaselineRef)!==refId(run.input.designBaselineRef)||pinned.designBaselineRef.version!==run.input.designBaselineRef.version) throw new Error('SaaS design context must preserve the exact input baseline revision');
      }
      if(nodeId==='map-permissions') {
        if(!refsEqual(enrichedPayloads.saas_state_permission_matrix.contractRefs,run.input.beContracts)) throw new Error('SaaS state/permission matrix must cite the exact pinned BE contracts');
      }
      if(nodeId==='be-contract-review') {
        if(!refsEqual(enrichedPayloads.be_contract_review.contractRefs,run.input.beContracts)) throw new Error('BE contract review must cite the exact pinned contract references');
      }
      if(nodeId==='design-feature') {
        const matrix=latestPayload(run,'map-permissions','saas_state_permission_matrix');
        if(!matrix||refId(enrichedPayloads.saas_feature_design.stateMatrixRef)!==matrix.id||enrichedPayloads.saas_feature_design.stateMatrixRef.version!==matrix.version||refId(enrichedPayloads.saas_feature_design.baselineRef)!==refId(run.input.designBaselineRef)||enrichedPayloads.saas_feature_design.baselineRef.version!==run.input.designBaselineRef.version) throw new Error('SaaS feature design must preserve its exact state matrix and baseline inputs');
      }
      if(nodeId==='handoff') {
        const design=latestPayload(run,'design-feature','saas_feature_design');
        if(!design||refId(enrichedPayloads.creative_design_handoff.designSpecRef)!==design.id||enrichedPayloads.creative_design_handoff.designSpecRef.version!==design.version||refId(enrichedPayloads.creative_design_handoff.designBaselineRef)!==refId(run.input.designBaselineRef)||enrichedPayloads.creative_design_handoff.designBaselineRef.version!==run.input.designBaselineRef.version) throw new Error('SaaS handoff must pin the exact feature design and original baseline');
      }
      if(nodeId==='publish-saas-package') {
        const review=latestPayload(run,'saas-independent-review','saas_design_review');
        const handoff=latestPayload(run,'handoff','creative_design_handoff');
        if(!review||!handoff||!refsEqual(enrichedPayloads.saas_design_package.apiContractRefs,run.input.beContracts)||refId(enrichedPayloads.saas_design_package.baselineRef)!==refId(run.input.designBaselineRef)||enrichedPayloads.saas_design_package.baselineRef.version!==run.input.designBaselineRef.version||refId(enrichedPayloads.saas_design_package.handoffRef)!==handoff.id||enrichedPayloads.saas_design_package.handoffRef.version!==handoff.version||refId(enrichedPayloads.saas_design_package.reviewRef)!==review.id||enrichedPayloads.saas_design_package.reviewRef.version!==review.version) throw new Error('SaaS package must pin exact baseline, contracts, handoff, and independent review');
        const matrix=latestPayload(run,'map-permissions','saas_state_permission_matrix');
        if(!matrix||refId(enrichedPayloads.saas_design_package.stateMatrixRef)!==matrix.id||enrichedPayloads.saas_design_package.stateMatrixRef.version!==matrix.version) throw new Error('SaaS package must pin the exact contract-derived state matrix');
      }
      if(nodeId==='inventory-system') {
        const inventory=enrichedPayloads.design_system_inventory;
        const expected=systemExpectedRef(run);
        if(!expected||refId(inventory.baselineRef)!==refId(expected)||inventory.baselineRef.version!==expected.version||inventory.baselineRef.digest!==expected.digest) throw new Error('Design-system inventory must cite the exact existing or bootstrap baseline');
      }
      if(nodeId==='propose-system-change') {
        const inventory=latestPayload(run,'inventory-system','design_system_inventory');
        const expected=systemExpectedRef(run),proposal=enrichedPayloads.design_system_change_proposal;
        if(!inventory||!expected||refId(proposal.expectedBaselineRef)!==refId(expected)||proposal.expectedBaselineRef.version!==expected.version||proposal.expectedBaselineRef.digest!==expected.digest) throw new Error('Design-system proposal must retain the exact expected baseline');
      }
      if(nodeId==='freeze-concept-set') {
        const review=latestPayload(run,'review-set','concept_set_review'),set=payloads.concept_set;
        if(review?.disposition!=='complete') throw new Error('A canonical concept set can only be frozen after a complete review');
        if(!set||set.requestedCount!==requestedCount(run)||set.candidates.length!==requestedCount(run)) throw new Error('Frozen concept set must match the requested cardinality');
        const refs=asRefs(set.candidates).map(item=>`${item.id}@${item.version}`).sort();
        if(refs.join('|')!==review.candidateRefs.map(item=>`${refId(item)}@${item.version}`).sort().join('|')) throw new Error('Frozen concept set differs from reviewed candidate versions');
        await Promise.all(set.candidates.map(candidate=>verifyImage(run,'concept_set',candidate)));
      }
      if(nodeId==='pin-review-subject') {
        const subject=enrichedPayloads.review_subject;
        if(!subject?.subjectRefs?.length) throw new Error('Design assurance needs exact review subject references');
        if(!refsEqual(subject.subjectRefs,run.input.reviewSubjectRefs)) throw new Error('Pinned design assurance subject must exactly match the start-run references');
        if(typeof getArtifactProvenance!=='function') throw new Error('Trusted artifact provenance resolver is required for external design subjects');
        const authors=new Set();
        for(const ref of subject.subjectRefs) {
          const local=exactRecord(run,ref);
          if(local) {
            const executionId=local.attempt.actor?.executionId;
            if(executionId) authors.add(executionId);
          } else {
            await externalRecord(ref,ref.kind,{run,input:run.input,actor});
            const provenance=await getArtifactProvenance(ref);
            if(!Array.isArray(provenance)||!provenance.some(row=>typeof row.executionId==='string')) throw new Error('External review subject has no trusted author execution provenance');
            for(const row of provenance) if(row.executionId) authors.add(row.executionId);
          }
        }
        if(!authors.size) throw new Error('Review subject author provenance is empty');
        enrichedPayloads.review_subject={...subject,subjectAuthorExecutionIds:[...authors]};
      }
      if(node.independentOf?.length) {
        const authorIds=[...new Set(node.independentOf.flatMap(refNode=>[
          ...(run.nodeStates[refNode]?.attempts??[]).map(attempt=>attempt.actor?.executionId).filter(Boolean),
          ...(latestPayload(run,refNode,'review_subject')?.subjectAuthorExecutionIds??[]),
        ]))];
        for(const id of authorIds) if(id===actor.executionId) throw new Error('Independent reviewer execution must differ from candidate authors');
        for(const artifact of artifacts) if(enrichedPayloads[artifact.kind]?.subjectAuthorExecutionIds) enrichedPayloads[artifact.kind]={...enrichedPayloads[artifact.kind],subjectAuthorExecutionIds:authorIds};
        for(const artifact of artifacts) if(enrichedPayloads[artifact.kind]?.reviewerExecutionId) {
          if(enrichedPayloads[artifact.kind].reviewerExecutionId!==actor.executionId) throw new Error('Reviewer identity must come from the trusted Core actor context');
          enrichedPayloads[artifact.kind]={...enrichedPayloads[artifact.kind],reviewerExecutionId:actor.executionId};
        }
      }
      if(nodeId==='visual-review'||nodeId==='behavior-review') {
        const reviewPayload=enrichedPayloads[node.produces?.[0]];
        if(!reviewPayload?.subjectRefs?.length) throw new Error('Design assurance review needs exact subject references');
        const subject=latestPayload(run,'pin-review-subject','review_subject');
        if(!subject?.subjectAuthorExecutionIds?.length) throw new Error('Design assurance review needs trusted subject author provenance');
        for(const ref of reviewPayload.subjectRefs) if(!exactRecord(run,ref)||refId(ref)!==subject.id||ref.version!==subject.version) throw new Error('Design assurance review must cite the exact pinned subject artifact');
        const authorIds=subject.subjectAuthorExecutionIds;
        if(authorIds.includes(actor.executionId)) throw new Error('Reviewer execution must differ from external candidate authors');
        enrichedPayloads[node.produces[0]]={...reviewPayload,subjectAuthorExecutionIds:authorIds,reviewerExecutionId:actor.executionId};
      }
      const enriched={...output,creativeArtifacts:enrichedPayloads};
      return engine.submitNode({runId,nodeId,actor,output:enriched,artifacts,...rest});
    },

    async decideNode({runId,nodeId,actor,outcome,...rest}) {
      const run=await engine.getRun(runId); if(!run||run.packId!=='creative-team') throw new Error('Creative run not found');
      actor=await trustedActor(actor,{operation:'decideNode',run,nodeId,outcome});
      const node=run.graph.nodes.find(n=>n.id===nodeId); if(!node||node.type!=='decision') throw new Error('Creative decision node not found');
      if(!(await engine.getReadyNodes(runId)).some(n=>n.id===nodeId)) throw new Error('Creative decision is not ready');
      const evidence=await requireDecisionEvidence(run,nodeId,outcome);
      return engine.decideNode({runId,nodeId,actor,outcome,...rest,evidence});
    },
  });
}
