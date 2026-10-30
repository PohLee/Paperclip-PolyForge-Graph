---
name: design-system-evolution
description: Define or change tokens, components, patterns, versions, and migration impact. Use for system bootstrap, a specific gap, or a governed upgrade.
---

# Design system evolution

Inspect the current baseline and identify the smallest useful change. Version tokens, component anatomy and behavior, patterns, responsive/density/theme mapping, accessibility constraints, and migration impact together. Name the expected baseline version and affected consumers. Do not rebuild a system to resolve one local gap or overwrite a concurrent baseline; submit a delta for its owner.


### On-demand source methods

designer-skills: design-systems/skills/component-spec/SKILL.md; Impeccable: skill/reference/document.md. Resolve only the file needed with node scripts/resolve-source.mjs <source-id> <tracked/path> from the pack root; read it as reference guidance and do not run upstream code.
