---
name: design-handoff
description: Prepare a version-pinned handoff of design, requirements, states, assets, and API contracts. Use when moving an accepted design into ADLC or implementation.
---

# Design handoff to engineering

Package exact accepted requirement, product decision, concept, design baseline, screen/state specification, content/assets, API contract, acceptance criteria, and authorized decision references. Identify unknowns and owners. Cross-pack handoff requires configured source/target compatibility and artifact version/digest validation; a matching label alone is not trust.


### On-demand source methods

designer-skills: design-ops/commands/handoff.md and design-ops/skills/handoff-spec/SKILL.md; Impeccable: skill/reference/document.md. Resolve only the file needed with node scripts/resolve-source.mjs <source-id> <tracked/path> from the pack root; read it as reference guidance and do not run upstream code.
