import { validateSelection } from '../adapters/concept-gallery/index.mjs';

const refId=ref=>ref?.id??ref?.artifactId;
const isRef=ref=>ref&&typeof ref==='object'&&refId(ref)&&ref.version;
const same=(left,right)=>isRef(left)&&isRef(right)&&refId(left)===refId(right)&&left.version===right.version;
export const equalArtifactRefs=(left,right)=>Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((ref,index)=>same(ref,right[index])&&ref.digest===right[index].digest);

export function createArtifactLineage(run) {
  function latest(nodeId,kind) {
    const attempts=run.nodeStates[nodeId]?.attempts??[];
    for(let i=attempts.length-1;i>=0;i--) {
      const value=attempts[i].output?.creativeArtifacts?.[kind];
      if(value) return value;
    }
    return null;
  }
  function exactRecord(ref) {
    for(const node of run.graph.nodes) for(const attempt of run.nodeStates[node.id]?.attempts??[]) {
      const item=(attempt.artifacts??[]).find(item=>same(item,ref));
      if(item) return {item,attempt,node,payload:attempt.output?.creativeArtifacts?.[item.kind]};
    }
    return null;
  }
  function current(ref,nodeId,kind,message) {
    const expected=latest(nodeId,kind);
    const state=run.nodeStates[nodeId];
    if(state?.status!=='completed'||!same(ref,expected)||!(state.artifacts??[]).some(item=>item.kind===kind&&same(item,ref))) throw new Error(message);
    return expected;
  }
  function selectedConceptRef(ref) {
    const set=run.input.concept_set,selection=run.input.concept_selection;
    if(!validateSelection(selection,set).valid) throw new Error('Run does not contain a current human-selected concept');
    const selected=set.candidates.find(candidate=>candidate.id===selection.candidateId);
    if(!same(ref,selected)||(ref.imageDigest&&ref.imageDigest!==selected.image.digest)) throw new Error('Design output must remain bound to the exact human-selected concept id, version, and digest (imageDigest)');
    return selected;
  }
  function submission(nodeId,payloads) {
    if(nodeId==='interpret-selection') selectedConceptRef(payloads.direction_contract.conceptRef);
    if(nodeId==='map-page') {
      const ref=payloads.page_section_map.conceptRef;
      if(!same(ref,latest('interpret-selection','direction_contract')?.conceptRef)) throw new Error('Page map must preserve the selected concept version');
      selectedConceptRef(ref);
    }
    if(nodeId==='desktop-design'||nodeId==='mobile-design') {
      const design=payloads[nodeId==='desktop-design'?'desktop_web_design':'mobile_web_design'];
      current(design.pageRef,'map-page','page_section_map','Desktop/mobile design must cover the exact page map');
      selectedConceptRef(design.conceptRef);
    }
    if(nodeId==='read-baseline'&&!same(payloads.pinned_design_context.designBaselineRef,run.input.designBaselineRef)) throw new Error('SaaS design context must preserve the exact input baseline revision');
    if(nodeId==='map-permissions'&&!equalArtifactRefs(payloads.saas_state_permission_matrix.contractRefs,run.input.beContracts)) throw new Error('SaaS state/permission matrix must cite the exact pinned BE contracts');
    if(nodeId==='be-contract-review'&&!equalArtifactRefs(payloads.be_contract_review.contractRefs,run.input.beContracts)) throw new Error('BE contract review must cite the exact pinned contract references');
    if(nodeId==='design-feature') {
      const design=payloads.saas_feature_design;
      if(!same(design.stateMatrixRef,latest('map-permissions','saas_state_permission_matrix'))||!same(design.baselineRef,run.input.designBaselineRef)) throw new Error('SaaS feature design must preserve its exact state matrix and baseline inputs');
    }
    if(nodeId==='handoff') {
      const handoff=payloads.creative_design_handoff;
      if(!same(handoff.designSpecRef,latest('design-feature','saas_feature_design'))||!same(handoff.designBaselineRef,run.input.designBaselineRef)) throw new Error('SaaS handoff must pin the exact feature design and original baseline');
    }
    if(nodeId==='inventory-system'||nodeId==='propose-system-change') {
      const expected=run.input.designBaselineRef??run.input.bootstrapRef;
      const ref=nodeId==='inventory-system'?payloads.design_system_inventory.baselineRef:payloads.design_system_change_proposal.expectedBaselineRef;
      if(!same(ref,expected)||ref.digest!==expected?.digest) throw new Error(nodeId==='inventory-system'?'Design-system inventory must cite the exact existing or bootstrap baseline':'Design-system proposal must retain the exact expected baseline');
    }
    if(nodeId==='pin-review-subject'&&!equalArtifactRefs(payloads.review_subject.subjectRefs,run.input.reviewSubjectRefs)) throw new Error('Pinned design assurance subject must exactly match the start-run references');
    if(nodeId==='visual-review'||nodeId==='behavior-review') {
      const kind=nodeId==='visual-review'?'visual_review_findings':'behavior_review_findings';
      const subject=latest('pin-review-subject','review_subject');
      if(payloads[kind].subjectRefs.some(ref=>!same(ref,subject)||!exactRecord(ref))) throw new Error('Design assurance review must cite the exact pinned subject artifact');
    }
    if(nodeId==='campaign-concept') {
      const concept=payloads.campaign_concept;
      current(concept.briefRef,'read-campaign-brief','campaign_brief','Campaign concept must cite the current campaign brief');
      if(!same(concept.brandBaselineRef,run.input.brandBaselineRef)) throw new Error('Campaign concept must preserve the pinned brand baseline');
    }
    if(nodeId==='produce-assets') current(payloads.campaign_asset_package.conceptRef,'campaign-concept','campaign_concept','Campaign assets must cite the current campaign concept');
    if(nodeId==='campaign-review') current(payloads.campaign_review.assetPackageRef,'produce-assets','campaign_asset_package','Campaign review must cite the exact current asset package version');
    if(nodeId==='publish-campaign-package') {
      const pkg=payloads.campaign_final_package;
      if(!same(pkg.brandBaselineRef,run.input.brandBaselineRef)) throw new Error('Campaign package must preserve the exact pinned brand baseline');
      current(pkg.conceptRef,'campaign-concept','campaign_concept','Campaign package must cite the current campaign concept');
      const assets=current(pkg.assetPackageRef,'produce-assets','campaign_asset_package','Campaign package must pin the exact reviewed asset package version');
      const review=current(pkg.reviewRef,'campaign-review','campaign_review','Campaign package must pin the exact campaign review version');
      if(!same(review.assetPackageRef,assets)||!same(assets.conceptRef,pkg.conceptRef)) throw new Error('Campaign package must preserve the exact reviewed asset lineage');
    }
    if(nodeId==='brand-review') {
      const review=payloads.brand_review;
      current(review.strategyRef,'positioning','brand_strategy','Brand review must cite the current strategy');
      current(review.identityRef,'identity-system','brand_identity_system','Brand review must cite the current identity system');
      current(review.voiceRef,'voice-system','brand_voice_system','Brand review must cite the current voice system');
    }
    if(nodeId==='publish-brand-baseline') {
      const baseline=payloads.brand_baseline,review=latest('brand-review','brand_review');
      for(const [field,node,kind] of [['strategyRef','positioning','brand_strategy'],['identityRef','identity-system','brand_identity_system'],['voiceRef','voice-system','brand_voice_system']]) {
        current(baseline[field],node,kind,`Brand baseline must pin the exact ${field} version reviewed`);
        if(!same(baseline[field],review?.[field])) throw new Error(`Brand baseline ${field} differs from the accepted review`);
      }
    }
    if(nodeId==='fidelity-review') {
      const review=payloads.web_design_review;
      selectedConceptRef(review.conceptRef);
      for(const [field,node,kind] of [['pageMapRef','map-page','page_section_map'],['desktopRef','desktop-design','desktop_web_design'],['mobileRef','mobile-design','mobile_web_design']]) current(review[field],node,kind,`Web acceptance review must cite the exact ${field} version`);
    }
    if(nodeId==='publish-web-package') {
      const pkg=payloads.web_design_package,review=current(pkg.reviewRef,'fidelity-review','web_design_review','Web package must pin the exact fidelity review version');
      selectedConceptRef(pkg.conceptRef);
      if(!same(pkg.conceptRef,review.conceptRef)) throw new Error('Web package concept differs from the accepted review');
      for(const [field,node,kind] of [['pageMapRef','map-page','page_section_map'],['desktopRef','desktop-design','desktop_web_design'],['mobileRef','mobile-design','mobile_web_design']]) {
        current(pkg[field],node,kind,`Web design package must pin the exact ${field} artifact`);
        if(!same(pkg[field],review[field])) throw new Error(`Web package ${field} differs from the accepted review`);
      }
    }
    if(nodeId==='saas-independent-review') current(payloads.saas_design_review.handoffRef,'handoff','creative_design_handoff','SaaS acceptance review must cite the exact handoff version');
    if(nodeId==='publish-saas-package') {
      const pkg=payloads.saas_design_package,review=current(pkg.reviewRef,'saas-independent-review','saas_design_review','SaaS package must pin the exact independent review version');
      const handoff=current(pkg.handoffRef,'handoff','creative_design_handoff','SaaS package must pin the exact handoff version');
      current(pkg.stateMatrixRef,'map-permissions','saas_state_permission_matrix','SaaS package must pin the exact contract-derived state matrix');
      if(!same(review.handoffRef,handoff)||!same(pkg.baselineRef,run.input.designBaselineRef)||!equalArtifactRefs(pkg.apiContractRefs,run.input.beContracts)) throw new Error('SaaS package must pin exact baseline, contracts, handoff, and independent review');
    }
    if(nodeId==='impact-review') {
      const review=payloads.design_system_review;
      current(review.proposalRef,'propose-system-change','design_system_change_proposal','Design-system review must cite the current proposal');
      current(review.validationRef,'validate-representative-pages','design_system_validation','Design-system review must cite the current validation');
    }
    if(nodeId==='publish-design-baseline') {
      const baseline=payloads.design_baseline;
      for(const [field,node,kind] of [['tokensRef','inventory-system','design_system_inventory'],['componentsRef','propose-system-change','design_system_change_proposal'],['patternsRef','validate-representative-pages','design_system_validation'],['migrationRef','impact-review','design_system_review']]) current(baseline[field],node,kind,`Design baseline must pin the exact ${field} version`);
    }
  }
  function decision(nodeId,outcome) {
    if(nodeId==='campaign-disposition'&&outcome==='ready') current(latest('campaign-review','campaign_review')?.assetPackageRef,'produce-assets','campaign_asset_package','Campaign acceptance review must cite the exact current asset package version');
    if(nodeId==='brand-disposition'&&outcome==='ready') submission('brand-review',{brand_review:latest('brand-review','brand_review')});
    if(nodeId==='web-design-disposition'&&outcome==='ready') submission('fidelity-review',{web_design_review:latest('fidelity-review','web_design_review')});
    if(nodeId==='saas-disposition'&&outcome==='ready') submission('saas-independent-review',{saas_design_review:latest('saas-independent-review','saas_design_review')});
    if(nodeId==='system-disposition'&&outcome==='accepted') submission('impact-review',{design_system_review:latest('impact-review','design_system_review')});
  }
  return {latest,exactRecord,selectedConceptRef,submission,decision};
}
