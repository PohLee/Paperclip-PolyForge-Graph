---
name: creative-intake
description: Turn a request or interview into a sourced, versioned creative brief. Use for G01 when intent, scope, audience, content, constraints, or approvals are unclear.
---

# Creative intake and brief

Capture the request, desired outcome, audience, surfaceMode, explorationMode, scope, constraints, content references, assumptions, open questions, and source IDs. For strategy-only briefs, surfaceMode may be null until a surface is selected; runtime wrappers require a concrete mode for G03, G04, and G05. Ask at most three high-value questions initially; ask up to two more only when an unresolved answer changes direction or delivery. Preserve raw interview answers and distinguish confirmed facts, preferences, and inference. For positioning-only work with no target touchpoint, leave surface choice unresolved until a design graph needs it; do not assign a page or app mode by guess. Do not invent a value to satisfy a downstream surface-specific contract. Produce a versioned brief and route only to the graph needed. A static HTML interview page may save locally or export; do not claim server persistence without a configured collector.


### On-demand source methods

designer-skills: design-research/commands/discover.md and ux-strategy/skills/design-brief/SKILL.md. Resolve only the file needed with node scripts/resolve-source.mjs <source-id> <tracked/path> from the pack root; read it as reference guidance and do not run upstream code.
