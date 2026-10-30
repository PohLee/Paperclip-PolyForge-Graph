const task = (id, role, purpose, extra = {}) => ({ id, type: 'task', role, purpose, ...extra });
const decision = (id, role, decisionType, outcomes, extra = {}) => ({ id, type: 'decision', role, decisionType, outcomes, ...extra });
const join = id => ({ id, type: 'join', mode: 'all' });
const end = (id, output) => ({ id, type: 'end', output });
const edge = (from, to, when) => when === undefined ? { from, to } : { from, to, when };
const graph = (id, start, nodes, edges, extra = {}) => ({ id, version: '0.1.0', start, nodes, edges, ...extra });

export const graphs = [
  graph('creative-intake', 'read-context', [
    task('read-context','design-ops-producer','Inventory the request and available product, brand, design, research, and technical context.',{produces:['context_inventory']}),
    task('clarify-brief','design-researcher','Ask no more than three high-value questions by default, reusing known answers; preserve unanswered items as unknown.',{produces:['clarification_record']}),
    task('synthesize-brief','product-designer','Create a sourced brief separating facts, preferences, constraints, assumptions, and open questions.',{produces:['creative_brief']}),
    decision('route-work','head-of-design','creative-routing',['brand','concept','web-design','saas-feature','system','assurance','campaign','needs-information','no-design-work']),
    end('brief-ready','brief_ready'), end('needs-information','needs_information'), end('no-design-work','no_design_work'),
    ...['brand','concept','web-design','saas-feature','system','assurance','campaign'].map(x=>end(`route-${x}`,`route:${x}`))
  ], [edge('read-context','clarify-brief'),edge('clarify-brief','synthesize-brief'),edge('synthesize-brief','route-work'),
    ...['brand','concept','web-design','saas-feature','system','assurance','campaign'].map(x=>edge('route-work',`route-${x}`,x)),
    edge('route-work','needs-information','needs-information'),edge('route-work','no-design-work','no-design-work'),edge('route-work','brief-ready','brief-ready')]),

  graph('brand-foundation','brand-evidence',[
    task('brand-evidence','brand-strategist','Separate sourced audience/category evidence from assumptions and identify evidence gaps.',{produces:['brand_evidence_ledger']}),
    decision('brand-evidence-disposition','brand-strategist','brand-evidence-disposition',['sufficient','needs-evidence']),
    task('positioning','brand-strategist','Define audience, category frame, differentiated positioning, promise, proof, personality, and messaging.',{requiredInputs:['creative_brief','brand_evidence_ledger'],produces:['brand_strategy']}),
    task('territories','art-director','Develop distinct visual territories while holding accepted strategy and product facts fixed.',{requiredInputs:['brand_strategy'],produces:['brand_territories']}),
    task('identity-system','brand-identity-designer','Specify identity rules, usage examples, and asset requirements for the selected direction.',{requiredInputs:['brand_strategy','brand_territories'],produces:['brand_identity_system']}),
    task('voice-system','brand-voice-content','Define voice, messaging hierarchy, naming brief, and factual copy boundaries.',{requiredInputs:['brand_strategy'],produces:['brand_voice_system']}),
    join('brand-review-ready'),task('brand-review','creative-director','Review strategy, identity, voice, evidence quality, and unresolved production needs.',{requiredInputs:['brand_strategy','brand_identity_system','brand_voice_system'],produces:['brand_review']}),
    decision('brand-disposition','creative-director','brand-foundation-disposition',['ready','needs-evidence','direction-pending']),
    task('publish-brand-baseline','design-ops-producer','Publish one exact, approved brand baseline referencing strategy, identity, voice, and acceptance decision.',{produces:['brand_baseline']}),
    end('brand-ready','brand_baseline_ready'),end('brand-evidence-needed','strategy_needs_evidence'),end('brand-direction-pending','brand_direction_pending')
  ],[edge('brand-evidence','brand-evidence-disposition'),edge('brand-evidence-disposition','positioning','sufficient'),edge('brand-evidence-disposition','brand-evidence-needed','needs-evidence'),edge('positioning','territories'),edge('positioning','voice-system'),edge('territories','identity-system'),edge('identity-system','brand-review-ready'),edge('voice-system','brand-review-ready'),edge('brand-review-ready','brand-review'),edge('brand-review','brand-disposition'),edge('brand-disposition','publish-brand-baseline','ready'),edge('publish-brand-baseline','brand-ready'),edge('brand-disposition','brand-evidence-needed','needs-evidence'),edge('brand-disposition','brand-direction-pending','direction-pending')]),

  graph('concept-sprint','freeze-brief',[
    task('freeze-brief','product-designer','Freeze brief, target count (3-5), surface mode, exploration mode, content, and shared comparison criteria.',{requiredInputs:['creative_brief'],produces:['concept_sprint_brief']}),
    task('plan-concepts','art-director','Define distinct hypotheses and tradeoffs at comparable fidelity before image generation.',{produces:['concept_plan']}),
    decision('choose-count','art-director','concept-count',['3','4','5']),
    task('render-01','art-director','Generate and save one real static image for concept 01 using the authorized image provider.',{produces:['concept_image_01']}),
    task('render-02','art-director','Generate and save one real static image for concept 02 using the authorized image provider.',{produces:['concept_image_02']}),
    task('render-03','art-director','Generate and save one real static image for concept 03 using the authorized image provider.',{produces:['concept_image_03']}),
    task('render-04','art-director','Generate and save one real static image for concept 04 using the authorized image provider.',{produces:['concept_image_04']}),
    task('render-05','art-director','Generate and save one real static image for concept 05 using the authorized image provider.',{produces:['concept_image_05']}),
    join('rendered-set'),task('review-set','design-qa-accessibility','Check image existence/decoding, count, shared brief fidelity, comparable completion, and meaningful differences; emit exact-version review, or mark incomplete.',{independentOf:['render-01','render-02','render-03','render-04','render-05'],produces:['concept_set_review']}),
    decision('set-status','art-director','concept-set-status',['complete','incomplete','blocked']),
    task('freeze-concept-set','design-ops-producer','Freeze the canonical set from exact reviewed candidate versions after the complete disposition.',{produces:['concept_set']}),
    task('assemble-gallery','design-ops-producer','Assemble exactly one HTML comparison gallery with concept introductions and relative image links; do not create runnable product prototypes.',{requiredInputs:['concept_set_review'],produces:['concept_gallery']}),
    end('gallery-ready','concept_gallery_ready'),end('gallery-incomplete','concept_gallery_incomplete'),end('gallery-blocked','capability_blocked')
  ],[edge('freeze-brief','plan-concepts'),edge('plan-concepts','choose-count'),...['01','02','03'].map(n=>edge('choose-count',`render-${n}`,['3','4','5'])),edge('choose-count','render-04',['4','5']),edge('choose-count','render-05','5'),...['01','02','03','04','05'].map(n=>edge(`render-${n}`,'rendered-set')),edge('rendered-set','review-set'),edge('review-set','set-status'),edge('set-status','freeze-concept-set','complete'),edge('freeze-concept-set','assemble-gallery'),edge('set-status','gallery-incomplete','incomplete'),edge('set-status','gallery-blocked','blocked'),edge('assemble-gallery','gallery-ready')],{compatibility:{requiredCapabilities:{'image-generation':'*','html-file-write':'*'}}}),

  graph('concept-to-web-design','interpret-selection',[
    task('interpret-selection','product-designer','Pin the selected concept version and state its visual invariants and non-binding details.',{requiredInputs:['concept_selection'],produces:['direction_contract']}),
    task('map-page','product-designer','Map all required pages, sections, content, and states against the brief.',{requiredInputs:['creative_brief','direction_contract'],produces:['page_section_map']}),
    task('desktop-design','design-engineer','Produce complete desktop page design imagery or editable design source across every required section.',{requiredInputs:['page_section_map'],produces:['desktop_web_design']}),
    task('mobile-design','design-engineer','Produce corresponding complete mobile page design and responsive behavior notes.',{requiredInputs:['page_section_map','direction_contract'],produces:['mobile_web_design']}),
    join('web-designs-ready'),task('fidelity-review','design-qa-accessibility','Independently check page coverage, mobile completeness, content accuracy, and fidelity to the pinned concept.',{independentOf:['desktop-design','mobile-design'],produces:['web_design_review']}),
    decision('web-design-disposition','design-director','web-design-disposition',['ready','revision-required','incomplete']),
    task('publish-web-package','design-ops-producer','Publish a complete versioned desktop/mobile web design package tied to the exact selected concept and review.',{produces:['web_design_package']}),
    end('web-design-ready','web_design_package_ready'),end('web-design-revision','revision_required'),end('web-design-incomplete','verification_incomplete')
  ],[edge('interpret-selection','map-page'),edge('map-page','desktop-design'),edge('map-page','mobile-design'),edge('desktop-design','web-designs-ready'),edge('mobile-design','web-designs-ready'),edge('web-designs-ready','fidelity-review'),edge('fidelity-review','web-design-disposition'),edge('web-design-disposition','publish-web-package','ready'),edge('publish-web-package','web-design-ready'),edge('web-design-disposition','web-design-revision','revision-required'),edge('web-design-disposition','web-design-incomplete','incomplete')],{compatibility:{requiredCapabilities:{'design-rendering':'*'}}}),

  graph('saas-feature-design','read-baseline',[
    task('read-baseline','design-systems-designer','Pin accepted product, brand, design-system, experience, and baseline versions.',{requiredInputs:['creative_brief','design_baseline'],produces:['pinned_design_context']}),
    task('map-permissions','interaction-designer','Map user tasks, roles, permissions, and experience states to supplied BE/API contracts; label missing facts unknown.',{requiredInputs:['pinned_design_context'],produces:['saas_state_permission_matrix']}),
    task('be-contract-review','interaction-designer','Review schema, nullability, errors, pagination, async behavior, and contract ownership with the supplied BE evidence.',{requiredInputs:['pinned_design_context'],produces:['be_contract_review']}),
    join('contracts-ready'),task('design-feature','product-designer','Design complete feature pages using pinned tokens, navigation, components, terminology, and state contracts.',{requiredInputs:['saas_state_permission_matrix','be_contract_review'],produces:['saas_feature_design']}),
    task('handoff','design-ops-producer','Prepare versioned design handoff and state exactly what is ready for a separate ADLC bridge.',{requiredInputs:['saas_feature_design'],produces:['creative_design_handoff']}),
    task('saas-independent-review','design-qa-accessibility','Independently verify pinned baseline continuity, state/permission coverage, API evidence, and unknown ownership.',{requiredInputs:['creative_design_handoff'],independentOf:['design-feature','be-contract-review'],produces:['saas_design_review']}),
    decision('saas-disposition','design-director','saas-design-disposition',['ready','revision-required','incomplete']),task('publish-saas-package','design-ops-producer','Publish the final SaaS design package with exact baseline, contract, state matrix, and review references.',{produces:['saas_design_package']}),
    end('saas-ready','saas_design_ready'),end('saas-revision','revision_required'),end('saas-incomplete','verification_incomplete')
  ],[edge('read-baseline','map-permissions'),edge('read-baseline','be-contract-review'),edge('map-permissions','contracts-ready'),edge('be-contract-review','contracts-ready'),edge('contracts-ready','design-feature'),edge('design-feature','handoff'),edge('design-feature','saas-independent-review'),edge('be-contract-review','saas-independent-review'),edge('handoff','saas-independent-review'),edge('saas-independent-review','saas-disposition'),edge('saas-disposition','publish-saas-package','ready'),edge('publish-saas-package','saas-ready'),edge('saas-disposition','saas-revision','revision-required'),edge('saas-disposition','saas-incomplete','incomplete')],{compatibility:{requiredCapabilities:{'be-contract-read':'*','project-source-read':'*'}}}),

  graph('design-system-evolution','inventory-system',[
    task('inventory-system','design-systems-designer','Inventory current accepted baseline, or pin a brand/concept bootstrap context before proposing the first system.',{requiredInputAny:[['design_baseline','brand_baseline','concept_selection']],produces:['design_system_inventory']}),
    task('propose-system-change','design-systems-designer','Propose the smallest versioned token/component/pattern change with expected baseline and migration impact.',{requiredInputs:['design_system_inventory'],produces:['design_system_change_proposal']}),
    task('validate-representative-pages','design-engineer','Apply proposal to representative pages and check visual, responsive, and accessibility consequences.',{requiredInputs:['design_system_change_proposal'],produces:['design_system_validation']}),
    task('impact-review','design-director','Review migration scope, affected consumers, compatibility, and rollback path.',{requiredInputs:['design_system_change_proposal','design_system_validation'],produces:['design_system_review']}),
    decision('system-disposition','design-director','design-system-disposition',['accepted','revision-required','incomplete']),
    task('publish-design-baseline','design-ops-producer','Publish accepted design baseline with exact version, digest, migration record, and decision reference.',{produces:['design_baseline']}),end('system-ready','design_baseline_ready'),end('system-revision','revision_required'),end('system-incomplete','verification_incomplete')
  ],[edge('inventory-system','propose-system-change'),edge('propose-system-change','validate-representative-pages'),edge('validate-representative-pages','impact-review'),edge('impact-review','system-disposition'),edge('system-disposition','publish-design-baseline','accepted'),edge('publish-design-baseline','system-ready'),edge('system-disposition','system-revision','revision-required'),edge('system-disposition','system-incomplete','incomplete')]),

  graph('design-assurance','pin-review-subject',[
    task('pin-review-subject','design-ops-producer','Pin exact design/code candidate, scope, baseline, and review evidence available.',{produces:['review_subject']}),
    task('visual-review','design-qa-accessibility','Inspect visual quality, brand consistency, content hierarchy, and responsive evidence within declared scope.',{independentOf:['pin-review-subject'],requiredInputs:['review_subject'],produces:['visual_review_findings']}),
    task('behavior-review','design-qa-accessibility','Inspect interaction, state, accessibility, and implementation evidence within declared scope.',{independentOf:['pin-review-subject'],requiredInputs:['review_subject'],produces:['behavior_review_findings']}),
    join('assurance-reviews-ready'),task('disposition','design-director','Combine findings, separate defects from preference, and state verified, revision-required, or unverified scope.',{requiredInputs:['visual_review_findings','behavior_review_findings'],produces:['design_review']}),
    decision('assurance-disposition','design-director','design-assurance-disposition',['verified','revision-required','incomplete']),end('verified','design_verified'),end('revision','revision_required'),end('incomplete','verification_incomplete')
  ],[edge('pin-review-subject','visual-review'),edge('pin-review-subject','behavior-review'),edge('visual-review','assurance-reviews-ready'),edge('behavior-review','assurance-reviews-ready'),edge('assurance-reviews-ready','disposition'),edge('disposition','assurance-disposition'),edge('assurance-disposition','verified','verified'),edge('assurance-disposition','revision','revision-required'),edge('assurance-disposition','incomplete','incomplete')]),

  graph('brand-campaign-assets','read-campaign-brief',[
    task('read-campaign-brief','brand-voice-content','Pin campaign objective, audience, claims, channels, language, and accepted brand baseline.',{requiredInputs:['creative_brief','brand_baseline'],produces:['campaign_brief']}),
    task('campaign-concept','art-director','Create a campaign concept grounded in brand strategy and substantiated claims.',{requiredInputs:['campaign_brief'],produces:['campaign_concept']}),
    task('produce-assets','brand-identity-designer','Produce channel-specific assets, copy variants, alt text, sizing/crop rules, and source/license records.',{requiredInputs:['campaign_concept'],produces:['campaign_asset_package']}),
    task('campaign-review','creative-director','Check brand consistency, claim evidence, accessibility text, and required asset coverage.',{requiredInputs:['campaign_asset_package'],produces:['campaign_review']}),
    decision('campaign-disposition','creative-director','campaign-disposition',['ready','revision-required','incomplete']),
    task('publish-campaign-package','design-ops-producer','Publish the exact reviewed campaign assets, brand baseline, concept, and acceptance decision.',{produces:['campaign_final_package']}),
    end('campaign-ready','campaign_assets_ready'),end('campaign-revision','revision_required'),end('campaign-incomplete','verification_incomplete')
  ],[edge('read-campaign-brief','campaign-concept'),edge('campaign-concept','produce-assets'),edge('produce-assets','campaign-review'),edge('campaign-review','campaign-disposition'),edge('campaign-disposition','publish-campaign-package','ready'),edge('publish-campaign-package','campaign-ready'),edge('campaign-disposition','campaign-revision','revision-required'),edge('campaign-disposition','campaign-incomplete','incomplete')],{compatibility:{requiredCapabilities:{'asset-production':'*'}}})
];

export default graphs;
