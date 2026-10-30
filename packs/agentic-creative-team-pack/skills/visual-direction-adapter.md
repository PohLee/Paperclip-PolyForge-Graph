---
name: visual-direction-adapter
description: Apply pinned Taste and Impeccable source methods according to explorationMode and surfaceMode. Use only at concept, art direction, implementation, or review nodes that need those methods.
---

# Upstream visual direction adapter

Load source methods only when the current node needs them. Resolve a pinned path with `node scripts/resolve-source.mjs <source-id> <tracked/path>` from the pack root and read the printed file as reference guidance. Discovery metadata lists the same source ID and path. Never run upstream installers, scripts, binaries, hooks, or services.

First interpret the pack modes. `explorationMode` decides what is fixed and what may vary:

- `brand-territory`: hold audience, positioning, promise, content, and dimensions fixed; vary visual language.
- `product-structure`: hold brand, task, content, data, and viewport fixed; vary information and interaction structure.
- `surface-composition`: hold selected concept and function fixed; vary hierarchy and composition.

`surfaceMode` is the request taxonomy, not a Taste profile name. Map `persuade` to Taste's public page profile. Map `operate` to Taste's work-app profile. Map `read` to the profile of the existing surface being inspected: use page guidance for a public page, app guidance for a work screen. Map `experience` to the target surface from the brief; use app guidance for task-driven interaction and page guidance for a primarily editorial or public-facing experience. Record the resolved profile in the brief when ambiguity affects the design.

Use the Taste canonical method `skills/taste-skill/SKILL.md`; read `skills/taste-skill/references/app-screens.md` for the app profile. For Impeccable, use `skill/SKILL.src.md` as the router, then load only the relevant method such as `skill/reference/new-work.md`, `visualize.md`, `critique.md`, or `audit.md`. Use designer-skills methods such as parallel concepts and concept selection only in the corresponding graph stage.

Resolve conflicts in this order: confirmed requirements and approved brand promise; platform, accessibility, and business constraints; approved design baseline; exploration and surface profiles; specialized craft methods; optional taste preferences. An approved project brand overrides house-style opinions. Treat taste preferences as optional. Do not apply page-only motion or imagery guidance to an app screen unless the brief calls for it and it improves the task.
