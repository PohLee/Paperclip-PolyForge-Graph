import { validateConceptSet } from '../adapters/concept-gallery/index.mjs';
import { validateInterviewArtifact } from '../adapters/interview/index.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) && value.length > 0;
const ref = value => object(value) && text(value.id ?? value.artifactId) && text(value.version);
const required = {
  context_inventory:['summary','sources'], clarification_record:['questions','knownAnswers'], creative_brief:['objective','audience'],
  concept_sprint_brief:['id','version','briefRef','requestedCount','explorationMode','comparisonCriteria'], concept_plan:['id','version','hypotheses'],
  concept_candidate:['id','version','title','thesis','description','choices','fit','tradeoff','image','provider'],
  concept_selection:['id','version','kind','type','disposition','setId','setVersion','candidateId','candidateVersion','imageDigest','selectedBy','createdAt'],
  concept_set_review:['id','version','disposition','candidateRefs','findings'], concept_gallery:['id','version','path','digest','setRef','candidateRefs'],
  direction_contract:['id','version','conceptRef','invariants'], page_section_map:['id','version','conceptRef','pages'],
  desktop_web_design:['id','version','conceptRef','pageRef','sections','source'], mobile_web_design:['id','version','conceptRef','pageRef','sections','source'],
  web_design_review:['id','version','conceptRef','pageMapRef','desktopRef','mobileRef','disposition','findings','reviewerExecutionId','subjectAuthorExecutionIds'],
  web_design_package:['id','version','conceptRef','pageMapRef','desktopRef','mobileRef','reviewRef'],
  pinned_design_context:['id','version','designBaselineRef','requirementRef'], saas_state_permission_matrix:['id','version','states','permissions','unknowns','contractRefs'],
  be_contract_review:['id','version','contractRefs','unknowns','ownerRefs'], saas_feature_design:['id','version','baselineRef','stateMatrixRef','pages'],
  creative_design_handoff:['id','version','requirementRef','designBaselineRef','designSpecRef','acceptanceCriteria'],
  saas_design_review:['id','version','handoffRef','disposition','findings','reviewerExecutionId','subjectAuthorExecutionIds'],
  saas_design_package:['id','version','handoffRef','baselineRef','apiContractRefs','stateMatrixRef','reviewRef'],
  design_system_inventory:['id','version','baselineRef','tokens','components','consumers'],
  design_system_change_proposal:['id','version','expectedBaselineRef','changes','migrationImpact'],
  design_system_validation:['id','version','proposalRef','representativePages','findings'],
  design_system_review:['id','version','proposalRef','validationRef','disposition','findings'],
  design_baseline:['id','version','tokensRef','componentsRef','patternsRef','decisionRef','migrationRef'],
  review_subject:['id','version','subjectRefs','subjectAuthorExecutionIds','scope'],
  visual_review_findings:['id','version','subjectRefs','reviewerExecutionId','subjectAuthorExecutionIds','findings'],
  behavior_review_findings:['id','version','subjectRefs','reviewerExecutionId','subjectAuthorExecutionIds','findings'],
  design_review:['id','version','subjectRefs','reviewerExecutionId','subjectAuthorExecutionIds','scope','disposition','findings'],
  brand_evidence_ledger:['id','version','sources','claims','unknowns'], brand_strategy:['id','version','evidenceRef','audience','positioning','promise','proof'],
  brand_territories:['id','version','strategyRef','territories'], brand_identity_system:['id','version','strategyRef','territoryRef','rules','assetRefs'],
  brand_voice_system:['id','version','strategyRef','voice','messaging','factBoundaries'], brand_review:['id','version','strategyRef','identityRef','voiceRef','disposition','findings'],
  brand_baseline:['id','version','strategyRef','identityRef','voiceRef','decisionRef'], campaign_brief:['id','version','brandBaselineRef','channels','claims'],
  campaign_concept:['id','version','briefRef','brandBaselineRef','thesis','claims'], campaign_asset_package:['id','version','conceptRef','assets','sourceRefs'],
  campaign_review:['id','version','assetPackageRef','disposition','findings'],
  campaign_final_package:['id','version','brandBaselineRef','conceptRef','assetPackageRef','reviewRef','decisionRef'],
  be_contract:['id','version','digest','content'], research_evidence:['id','version','sources','claims'],
};

export function validateCreativeArtifact(kind, payload) {
  if (!text(kind)) return { valid:false,errors:['kind must be a non-empty string'] };
  if (!object(payload)) return { valid:false,errors:['payload must be an object'] };
  if (kind === 'concept_set') return validateConceptSet(payload);
  if (kind === 'interview_responses') return validateInterviewArtifact(payload);
  if (/^concept_image_\d\d$/.test(kind)) kind='concept_candidate';
  const keys = required[kind];
  if (!keys) return { valid:false,errors:[`unknown creative artifact kind: ${kind}`] };
  const errors=[];
  if(kind==='be_contract'&&!/^[a-f0-9]{64}$/.test(payload.digest??'')) errors.push('BE contract digest must be SHA-256');
  if(kind==='concept_selection'&&payload.reason!==undefined&&typeof payload.reason!=='string') errors.push('reason must be a string when supplied');
  if(kind==='creative_brief' && payload.surfaceMode!==undefined && payload.surfaceMode!==null && !['persuade','operate','read','experience'].includes(payload.surfaceMode)) errors.push('surfaceMode is invalid');
  for (const key of keys) {
    const value=payload[key];
    if (['image','provider'].includes(key)) {
      if (!object(value)) errors.push(`${key} must be an object`);
      else if (key==='image' && (!text(value.path) || !text(value.digest) || !['image/png','image/jpeg','image/webp'].includes(value.mimeType) || value.path.startsWith('/') || value.path.includes('\\') || value.path.split('/').includes('..'))) errors.push('image must include a safe relative path, digest, and supported raster MIME type');
      continue;
    }
    if (key.endsWith('Ref') || key.endsWith('Refs') || key === 'subjectRefs' || key === 'candidateRefs') {
      if (key.endsWith('Refs') || key === 'subjectRefs' || key === 'candidateRefs') {
        if (!list(value) || value.some(item=>!ref(item))) errors.push(`${key} must contain versioned artifact references`);
      } else if (!ref(value)) errors.push(`${key} must be a versioned artifact reference`);
    } else if (['sources','claims','unknowns','questions','knownAnswers','comparisonCriteria','hypotheses','findings','invariants','pages','sections','states','permissions','ownerRefs','tokens','components','consumers','changes','representativePages','territories','rules','assetRefs','voice','messaging','factBoundaries','acceptanceCriteria','assets','channels','choices'].includes(key)) {
      const mayBeEmpty=['claims','unknowns','knownAnswers','findings','questions','tokens','components','consumers'].includes(key);
      if (!Array.isArray(value)||(!mayBeEmpty&&!value.length)) errors.push(`${key} must be an ${mayBeEmpty?'array':'non-empty array'}`);
    } else if (['kind','type','disposition','setId','candidateId','candidateVersion','imageDigest','selectedBy','createdAt'].includes(key)) {
      if (!text(value)) errors.push(`${key} must be a non-empty string`);
      if (kind==='concept_selection'&&key==='kind'&&value!=='concept_selection') errors.push('kind must be concept_selection');
      if (kind==='concept_selection'&&key==='type'&&value!=='select') errors.push('type must be select');
      if (kind==='concept_selection'&&key==='disposition'&&value!=='preference') errors.push('selection records preference only');
    } else if (['requestedCount'].includes(key)) {
      if (![3,4,5].includes(value)) errors.push(`${key} must be 3, 4, or 5`);
    } else if (['disposition'].includes(key)) {
      if (!text(value)) errors.push(`${key} must be a non-empty disposition`);
    } else if (['reviewerExecutionId'].includes(key)) {
      if (!text(value)) errors.push(`${key} must be a non-empty trusted execution identity`);
    } else if (['subjectAuthorExecutionIds'].includes(key)) {
      if (!Array.isArray(value) || value.some(item=>!text(item))) errors.push(`${key} must be an array of trusted author execution identities`);
    } else if (['surfaceMode'].includes(key)) {
      if (!['persuade','operate','read','experience'].includes(value)) errors.push('surfaceMode is invalid');
    } else if (['explorationMode'].includes(key)) {
      if (!['brand-territory','product-structure','surface-composition'].includes(value)) errors.push('explorationMode is invalid');
    } else if (['content'].includes(key)) {
      if (!object(value)) errors.push('content must be an object containing the contract material');
    } else if (['description','title','objective','audience','summary','scope','source','positioning','promise','proof','thesis','migrationImpact'].includes(key)) {
      if (!text(value)) errors.push(`${key} must be a non-empty string`);
    } else if (!text(value)) errors.push(`${key} must be a non-empty string`);
  }
  if (payload.requestedCount && payload.candidates && payload.candidates.length !== payload.requestedCount) errors.push('candidate count must exactly equal requestedCount');
  if (payload.disposition && ['complete','verified','accepted','ready'].includes(payload.disposition) && Array.isArray(payload.findings) && payload.findings.some(f=>!['resolved','accepted-exception'].includes(f.status))) errors.push('successful disposition cannot contain unresolved findings');
  if (payload.disposition && ['complete','verified','accepted','ready'].includes(payload.disposition) && payload.unverified === true) errors.push('successful disposition cannot mark evidence unverified');
  return { valid:errors.length===0,errors };
}

export function assertCreativeArtifact(kind,payload) {
  const result=validateCreativeArtifact(kind,payload);
  if (!result.valid) throw new Error(`Invalid ${kind} artifact: ${result.errors.join('; ')}`);
  return payload;
}
