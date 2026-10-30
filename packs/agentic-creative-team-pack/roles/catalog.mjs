const roles = [
['head-of-design','Head of Design',null,'human-owner','Resolve cross-domain design tradeoffs, route briefs, and govern shared baselines.','Owns cross-product and brand coherence, concept selection only when delegated, and major baseline governance. Does not replace CPO scope or CTO technical approval.',['brief-routing','concept-selection','baseline-governance'],['cross-domain-design-disposition','concept-selection','baseline-change']],
['design-director','Design Director','head-of-design','head-of-design','Protect product experience quality and consistency across journeys.','Leads product design and accepts product design specifications and compatible system changes.',['ux-strategy','interaction-design','design-evaluation'],['product-design-acceptance','compatible-design-change']],
['creative-director','Creative Director','head-of-design','head-of-design','Keep brand strategy and expression coherent across touchpoints.','Leads brand strategy, art direction, and identity review; accepts brand directions and brand system changes.',['brand-strategy','art-direction','identity-review'],['brand-direction-acceptance','brand-baseline-change']],
['design-ops-producer','Design Ops Producer','head-of-design','head-of-design','Keep briefs, schedules, artifacts, and decisions traceable.','Coordinates intake, versioned artifact records, and handoff completeness; never substitutes for user preference selection.',['interview-collection','artifact-registry','handoff'],[]],
['design-researcher','Design Researcher','design-director','design-director','Separate sourced user evidence from interpretation.','Plans interviews and synthesizes evidence into needs, constraints, and insights. Does not represent synthetic answers as user evidence.',['interview-script','research-synthesis','evidence-ledger'],[]],
['product-designer','Product Designer','design-director','design-director','Make task structure and product intent visible in the design.','Owns information architecture, task paths, page structure, and product concepts without changing approved scope.',['brief','information-architecture','concepts','wireframes'],[]],
['interaction-designer','Interaction Designer','design-director','design-director','Make states, feedback, permissions, and recovery understandable.','Defines interaction contracts and state coverage with engineering owners.',['state-machine','forms','onboarding','errors'],[]],
['design-systems-designer','Design Systems Designer','design-director','design-director','Make reusable design decisions explicit and versioned.','Owns tokens, component and pattern contracts, theming, governance, and migration notes.',['component-spec','governance','theming'],['design-system-baseline-acceptance']],
['design-engineer','Design Engineer','design-director','design-director','Turn design intent into inspectable prototypes and implementation evidence.','Builds layout prototypes and frontend design implementations within approved project stack and API contracts; architecture decisions go to the CTO.',['prototype-build','frontend-design','screenshots'],[]],
['design-qa-accessibility','Design QA & Accessibility','design-director','design-director','Report findings against the exact artifact and evidence observed.','Independently checks visual, behavioral, consistency, and accessibility evidence. Cannot approve a candidate they authored.',['audit','critique','fidelity','state-coverage'],[]],
['brand-strategist','Brand Strategist','creative-director','creative-director','Ground brand choices in evidence and a credible promise.','Defines positioning, audience, differentiation, and promise/proof. Does not invent market evidence or customer claims.',['brand-positioning','promise-proof','audience'],[]],
['brand-identity-designer','Brand Identity Designer','creative-director','creative-director','Translate brand strategy into a usable identity system.','Defines identity and cross-touchpoint applications. Production logo delivery requires editable vector and asset checks.',['identity-system','color','typography','graphic-language'],[]],
['art-director','Art Director','creative-director','creative-director','Make creative territories distinct while holding the brief constant.','Directs concept imagery and visual assets; candidates share content, dimensions, and completion level.',['territory-exploration','visual-direction','concept-gallery'],[]],
['brand-voice-content','Brand Voice & Content Designer','creative-director','creative-director','Keep language clear, distinctive, and faithful to product facts.','Owns messaging hierarchy, UX writing, naming proposals, and voice guidance; product facts remain owned by Product.',['ux-writing','content-strategy','messaging'],[]]
];
export const roleCatalog = roles.map(([id,name,reportsToRole,supervisor,soul,role,capabilities,rules])=>({id,name,reportsToRole,supervisor,soul,role,capabilities,rules}));
export const roleSkills = {
  'head-of-design':['decision-and-versioning','concept-sprint','design-system-evolution'],
  'design-director':['web-design-expansion','saas-feature-design','design-assurance'],
  'creative-director':['brand-foundation','brand-campaign-assets','concept-sprint'],
  'design-ops-producer':['creative-intake','decision-and-versioning','design-handoff'],
  'design-researcher':['creative-intake','research-synthesis'],
  'product-designer':['creative-intake','concept-sprint','web-design-expansion'],
  'interaction-designer':['saas-feature-design','design-assurance'],
  'design-systems-designer':['design-system-evolution','saas-feature-design'],
  'design-engineer':['web-design-expansion','saas-feature-design','design-handoff'],
  'design-qa-accessibility':['design-assurance','visual-direction-adapter'],
  'brand-strategist':['brand-foundation','research-synthesis'],
  'brand-identity-designer':['brand-foundation','brand-campaign-assets'],
  'art-director':['concept-sprint','visual-direction-adapter','brand-campaign-assets'],
  'brand-voice-content':['brand-foundation','brand-campaign-assets','web-design-expansion']
};
