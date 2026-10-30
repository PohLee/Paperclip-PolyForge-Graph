const items = [
['creative-intake','Creative intake and brief','Turn a request or interview into a sourced, versioned creative brief. Use for G01 when intent, scope, audience, content, constraints, or approvals are unclear.'],
['research-synthesis','Design research synthesis','Convert collected evidence into attributable needs, patterns, and open questions. Use when primary user or market evidence exists; do not use to invent evidence.'],
['brand-foundation','Brand strategy and identity','Develop positioning, promise/proof, voice, and a governed identity baseline. Use for new brands or a requested repositioning; skip for an existing brand product page.'],
['concept-sprint','Concept sprint and gallery','Create 3–5 distinct static concept images and package them with descriptions in one HTML gallery. Use when the user asks to compare directions.'],
['web-design-expansion','Concept to full web design','Expand a selected concept into complete responsive page designs and a content/state package. Use after a specific concept version is selected.'],
['saas-feature-design','SaaS feature and BE contract','Design coherent SaaS workflows against product, permission, data, and API contracts. Use for new or changed SaaS features.'],
['design-system-evolution','Design system evolution','Define or change tokens, components, patterns, versions, and migration impact. Use for system bootstrap, a specific gap, or a governed upgrade.'],
['design-assurance','Design QA and accessibility','Review a fixed design or implementation candidate against scoped evidence. Use for critique, accessibility, fidelity, or regression checks.'],
['brand-campaign-assets','Brand campaign assets','Adapt an approved brand baseline into a campaign asset set for named channels. Use for marketing and cross-touchpoint packages.'],
['decision-and-versioning','Design decisions and versioning','Write durable decisions and keep artifact lineage, stale references, and superseded work traceable. Use whenever a selection, acceptance, exception, or baseline change occurs.'],
['design-handoff','Design handoff to engineering','Prepare a version-pinned handoff of design, requirements, states, assets, and API contracts. Use when moving an accepted design into ADLC or implementation.'],
['visual-direction-adapter','Upstream visual direction adapter','Apply pinned Taste and Impeccable source methods according to explorationMode and surfaceMode. Use only at concept, art direction, implementation, or review nodes that need those methods.']
];
const upstreamSources = {
  'creative-intake':[{sourceId:'designer-skills',path:'design-research/commands/discover.md'},{sourceId:'designer-skills',path:'ux-strategy/skills/design-brief/SKILL.md'}],
  'research-synthesis':[{sourceId:'designer-skills',path:'design-research/skills/user-persona/SKILL.md'},{sourceId:'designer-skills',path:'design-research/commands/discover.md'}],
  'concept-sprint':[{sourceId:'designer-skills',path:'prototyping-testing/skills/parallel-concepts/SKILL.md'},{sourceId:'designer-skills',path:'prototyping-testing/skills/concept-selection/SKILL.md'},{sourceId:'designer-skills',path:'prototyping-testing/commands/explore-options.md'},{sourceId:'impeccable',path:'skill/reference/visualize.md'}],
  'web-design-expansion':[{sourceId:'designer-skills',path:'ui-design/commands/design-screen.md'},{sourceId:'taste-skill',path:'skills/taste-skill/SKILL.md'},{sourceId:'impeccable',path:'skill/reference/new-work.md'}],
  'saas-feature-design':[{sourceId:'designer-skills',path:'interaction-design/commands/design-interaction.md'},{sourceId:'taste-skill',path:'skills/taste-skill/references/app-screens.md'},{sourceId:'impeccable',path:'skill/reference/operate.md'},{sourceId:'impeccable',path:'skill/reference/harden.md'}],
  'design-system-evolution':[{sourceId:'designer-skills',path:'design-systems/skills/component-spec/SKILL.md'},{sourceId:'impeccable',path:'skill/reference/document.md'}],
  'design-assurance':[{sourceId:'designer-skills',path:'visual-critique/commands/critique-screen.md'},{sourceId:'impeccable',path:'skill/reference/critique.md'},{sourceId:'impeccable',path:'skill/reference/audit.md'}],
  'brand-campaign-assets':[{sourceId:'taste-skill',path:'skills/taste-skill/SKILL.md'},{sourceId:'impeccable',path:'skill/reference/visualize.md'}],
  'visual-direction-adapter':[{sourceId:'taste-skill',path:'skills/taste-skill/SKILL.md'},{sourceId:'taste-skill',path:'skills/taste-skill/references/app-screens.md'},{sourceId:'impeccable',path:'skill/SKILL.src.md'},{sourceId:'impeccable',path:'skill/reference/new-work.md'},{sourceId:'impeccable',path:'skill/reference/critique.md'},{sourceId:'impeccable',path:'skill/reference/audit.md'}],
  'design-handoff':[{sourceId:'designer-skills',path:'design-ops/commands/handoff.md'},{sourceId:'designer-skills',path:'design-ops/skills/handoff-spec/SKILL.md'},{sourceId:'impeccable',path:'skill/reference/document.md'}]
};
export const skillCatalog = Object.fromEntries(items.map(([id,name,description])=>[id,{id,name,description,triggers:description.split(' Use ')[1]??description,...(upstreamSources[id]?{upstreamSources:upstreamSources[id]}:{})}]));
