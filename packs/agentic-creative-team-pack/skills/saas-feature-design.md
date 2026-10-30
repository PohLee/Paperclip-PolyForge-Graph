---
name: saas-feature-design
description: Design coherent SaaS workflows against product, permission, data, and API contracts. Use for new or changed SaaS features.
---

# SaaS feature and BE contract

Bind every screen and state to a task, actor/permission, business data, and API source. Agree entities, nullability, enums, pagination, filtering, validation, errors, async behavior, retry/idempotency, tenant scope, and authorization with the BE owner. Show relevant loading, empty, success, validation/server error, denied, stale/offline, and partial-success states. Mark unknown endpoints and name an owner; mocks do not prove integration. Reuse the pinned navigation, tokens, components, terminology, and density across pages. Escalate product behavior changes to Product, architecture changes to CTO/BE, and cross-domain design conflicts to Head of Design.


### On-demand source methods

designer-skills: interaction-design/commands/design-interaction.md; Taste app rules: skills/taste-skill/references/app-screens.md; Impeccable: skill/reference/operate.md and skill/reference/harden.md. Resolve only the file needed with node scripts/resolve-source.mjs <source-id> <tracked/path> from the pack root; read it as reference guidance and do not run upstream code.
