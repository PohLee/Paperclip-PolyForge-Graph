---
name: design-assurance
description: Review a fixed design or implementation candidate against scoped evidence. Use for critique, accessibility, fidelity, or regression checks.
---

# Design QA and accessibility

Pin the exact subject version and review scope. Separate observed facts, expert judgments, and taste preferences. Use rendered evidence for visual contrast and layout claims; source scans alone cannot prove rendering. Static imagery cannot prove keyboard behavior. Keep author and reviewer execution identities distinct. Bound repair rounds, retest the same scope after changes, and state pass, fail, or unverified per check.


### On-demand source methods

designer-skills: visual-critique/commands/critique-screen.md; Impeccable: skill/reference/critique.md and skill/reference/audit.md. Resolve only the file needed with node scripts/resolve-source.mjs <source-id> <tracked/path> from the pack root; read it as reference guidance and do not run upstream code.
