# PolyForge architecture review work packages

This review covers three changes identified on 19 November 2026. The starting point was the working tree at `f998cb9`, including the November P0 fixes and the company Provision button that already applied reporting links. Each implementation owner used GPT-6.2 Sol with high reasoning.

| Work package | Implementation owner | Acceptance |
| --- | --- | --- |
| WP1 · Work Item decision outcomes | `decision_work` | A native decision card offers the same gate outcomes as its pinned Work Item, including implicit rework. Explicit choices, evidence collection, authorization and stale-answer rejection continue to work. |
| WP2 · Organization Plan recovery | `organization_work` | Company and issue entry points apply the same rules for identity, outstanding approval and verified targets. A partially applied company plan can resume. Changing the actor, scope or intended targets cannot confirm an obsolete plan. |
| WP3 · Dispatch Attempt evidence | `dispatch_work` | Normal dispatch and retry use the same evidence to identify an existing assigned Issue. Only one matching Issue can confirm creation. Ambiguous or mismatched evidence blocks replay, while a new dispatch can proceed when its policy permits. |

The team lead owns integration, regression verification, standards review and acceptance review.

## Implementation

### WP1 · Native decisions

Core and Paperclip now read gate choices from `decisionOutcomes` on the same pinned Graph Run. This includes a default or named rework choice; an explicit outcome list retains its original order. The native card still handles question labels, evidence and resolver authentication. A pending legacy card that omitted an option gets a stable replacement. A valid same-snapshot answer to the original card can still resolve the decision. If that incomplete card already received a rejected answer, the current owner can use the replacement. The original interaction remains in Paperclip history.

### WP2 · Organization Plan recovery

The issue and company commands share the reporting lifecycle in `src/plugin/reporting-lifecycle.mjs`. They retain their own rules for computing targets. Issue plans keep the exact Pack version, issue identity and agent profile hashes. Company plans include every enabled Pack version and its applicable cross-Pack reporting lines.

Core selects or appends the approval and confirmation inside its revision-checked state write. This lets workers share an outstanding plan with the same actor, scope and intended reporting relationships, even after some native writes have succeeded. It also rejects a confirmation if the relevant company setup changed during the native Agent reads. A legacy issue plan can resume from its recorded Pack identity. An older company plan without the enabled versions requires a fresh plan.

In an isolated instance of the official Paperclip `2026.1106.0` image, the new plugin provisioned ADLC and Creative Team, each at `0.3.3`. The initial plan contained 24 changes for 25 managed agents. After applying one change, another request returned the original plan ID and exactly 23 remaining changes. Two confirmations with different request keys returned the same decision ID. All 25 agents' reporting relationships matched the original plan in the native organization tree.

### WP3 · Dispatch recovery

Normal dispatch and retry use the same host evidence to identify a previously created Issue. They compare company, origin kind and ID, assignee, parent and project across camel-case and snake-case payloads. Normal dispatch can use an ID-only acknowledgement from its own create call. A malformed acknowledgement or a supplied field that contradicts the request leaves the send outcome unknown. Recovery requires independent matching evidence.

Attaching the Issue now uses a compare-and-set. A delayed sender that attaches the same Issue after checkout preserves its run identity, timestamp and state. A different Issue ID raises a revision conflict. The PostgreSQL test exercises both outcomes against the dispatch table.

## Verification

| Check | Result |
| --- | --- |
| Complete Node suite, `node --test tests/core/*.test.mjs tests/e2e/*.test.mjs tests/plugin/*.test.mjs` | 432 cases, 422 passed, 10 opt-in cases skipped, zero failures |
| PostgreSQL-enabled selection in Docker | 37 passed with zero skips. This includes all nine PostgreSQL cases skipped by the default suite and the delayed Issue attachment regression. The selection overlaps the default suite. |
| Isolated official Paperclip host | Loaded the built worker and verified partial organization alignment, repeated confirmation and the native organization tree using HTTP. |
| Build and artifact verification | `node scripts/build.mjs` initialized the worker over JSON-RPC. `verifyRuntimeArtifact` verified 12 files and 18 migrations for version `0.8.10`. |
| Whitespace | `git diff --check` passed. |

The remaining opt-in case is the legacy three-Graph Docker workflow. That scenario was not exercised. Decision-card verification used a real GraphEngine and a simulated Paperclip interaction. Dispatch attachment was verified against real PostgreSQL. The host acceptance used a separate, temporary Paperclip instance.

## Review

**Standards.** The independent reviewer checked implementation and tests against the pre-task working tree. Review prompted checks for contradictory create acknowledgements, recovery from a rejected answer on an incomplete legacy card, and migration of an obsolete test fixture to the shared lifecycle. The final review had zero open findings.

**Spec.** Review found two races in the intermediate reporting implementation. A different worker could approve or confirm an equivalent request before the first worker recorded it, and the company could change enabled Packs during native verification. The persisted state check now handles both. Regressions also cover reusing a request key with different input. The final acceptance review had zero open findings.
