# Multi-Pack company operations enhancement

Status: implementation and verification in progress. This document is a requirements baseline, not an acceptance claim.

## Confirmed scope

- Keep Core runtime in its own repository. Rename the official collection to `Paperclip-PolyForge-Graph-Packs`; each Pack has an independent version, artifact, compatibility declaration and release.
- Install multiple Packs per instance, enable selected versions per company, and coordinate multiple enabled Packs within one project and work plan. Preserve company isolation and immutable release identities.
- Deliver enhanced ADLC and a minimal second Pack. Marketing is the implementation default for the second Pack; full SRE, SEO and Operations Packs are outside this delivery.
- Validate Core version ranges, versioned contracts and actual required/optional capabilities before activation and execution. Check all company activations and unfinished runs before a Core upgrade.
- Company hierarchy is Board / human -> CEO -> CPO, CTO, CMO and domain reports. CEO coordinates intake, delegation and cross-Pack priorities; it may resolve disagreements within authority. Mandatory human matters, excess authority and unresolved disagreements escalate to a human.
- Demand intake channels are Paperclip chat and Telegram. Requests can address CEO or a domain Agent. Out-of-role requests are rejected with a reason and forwarded to CEO for reassignment. Preserve original message, sender, attachments, routing and decision history.
- Company/project setup guides Pack selection, Agent/model/tool/repository bindings, automation, budget and notifications, with truthful readiness checks.
- Graphs or Agents may request Shadow tasks. A Shadow has an independent execution context, bounded role permissions, explicit parent task and auditable lifecycle. Independent review must not inherit author conversation. Implementation default: close the task session after completion and retain records.
- Display full Graph definitions, current run node states, branches, joins, rework and execution details. Use each run's pinned Graph definition.
- Packs declare their own Dashboard layout and metrics. Core renders a company overview and Pack-specific views. Implementation default: declarative views rather than arbitrary Pack frontend execution.
- Use Paperclip's existing Decision UI for artifact review and authorized human choices. Candidate and review versions remain explicit.
- Allow recorded feedback, explicit human takeover and resumption; preserve prior artifacts, decisions and attempts.
- Query product rules and historical decisions with sources. Missing evidence remains unknown.
- Provide cross-Pack work plans, dependencies and priorities, linked to native Paperclip work where supported.
- Provide proactive progress/outcome notifications with channel controls for Paperclip chat, email and Telegram. External providers require actual configuration and authorized identities. Test delivery uses clearly labelled local fixtures.
- Review post-delivery results against baseline, target, source and observation window. Missing data is unknown; task completion is not business outcome achievement.
- Version company and subordinate OKRs. CEO may decompose goals and adjust subordinate strategy within authority. Actual measurement and source evidence drive the review. Company targets and authority constraints remain explicit.
- Goal edits affect new tasks only. A Graph Run, its child work, retries and Shadows retain the goal context selected at start. Explicit intervention is a separate recorded action.
- All human, Agent and system decisions are recorded with actor, reason, evidence, related versions and supersession links.
- Preserve self-review until no P0/P1 or five rounds, followed by an independent supervisor review. Reaching five rounds is not approval.

## Delivery and verification

- Work is isolated in new `codex/multi-pack-enhancement` worktrees for Core and Packs.
- Development and independent verification use GPT-6 Sol / High sub-agents.
- Verify domain invariants, host permissions and replay handling, Pack conformance and cross-Pack contracts, then real Paperclip/plugin integration in Docker and browser behavior.
- Report deterministic fixture execution separately from actual model execution and actual external-provider delivery. Never substitute simulated evidence for live acceptance.
- Existing model accounting holds must be repaired through supported host mechanisms; no new identity or fabricated receipt may bypass a hold.

## Acceptance evidence — 2026-10-29 candidate

This is a partial delivery checkpoint, not a declaration that all requested enhancements have passed. Work is isolated on `codex/multi-pack-enhancement` in both repositories. No release tag has been created. The user authorized local deterministic Agent execution, official development Docker reinstall without backup, and local channel verification. No paid model or real email/Telegram delivery was used.

### Executed verification

- Core/plugin regression suite: **145 passing tests, 0 failures, 1 Docker-only test skipped**. The Docker acceptance harness runs separately.
- Packs: **31/31 tests passed** against an immutable Core contract snapshot, tree digest `sha256:6241292cc678ef7c877fbc3578d298f399a399090e43d12f6671d03dafcf4dad`. This snapshot contains `src/core/` and `src/plugin/review-context.mjs`; it is not a published Core release or a digest of the whole plugin.
- Pack payloads: ADLC `0.2.0`, digest `sha256:d138a969666124fc0da62c2750aa75f3fc019124bb95725fae9c3498c7a27e12`; Marketing `0.0.1`, digest `sha256:d5dac8b69b1983c0ae94e92d142523db90746e6b1299478827afe87ec20ac260`. Both require Core `>=0.8.0 <0.9.0`.
- Docker: **28 acceptance cases passed**. Paperclip `2026.1023.0` with separate PostgreSQL/data volumes on **3312**, real authenticated host routes, process Agent heartbeats, SDK sessions, native Decisions and scheduled jobs. The 3310/3311 instances remain separate.
- Browser: authenticated Docker pages at desktop and **390px** width; notification receipt states, Pack views, pinned Graph diagram, full definition, fit-to-width and human takeover/resume. No horizontal page overflow in the checked mobile views.

| Requirement | Evidence / current result | Limits or remaining work |
| --- | --- | --- |
| Pack collection and per-company enablement | ADLC + Marketing provisioned together; another company retains separate activation; namespaced roles and immutable payload checks pass | Full SRE, SEO and Operations are outside this delivery |
| Core compatibility and upgrade checks | Version/contracts/capabilities checked; built artifact bytes verified; official instance-admin enumeration and preflight passed for six companies | Upgrade wrapper dry run only; no native veto hook; apply requires the exact host-local installed path |
| Organization and CEO | Native Board → CEO → CPO/CTO/CMO hierarchy; delegated process CEO identity and operation boundaries pass | Actual model judgment is not tested by a process fixture |
| Demand intake | Native Paperclip comment automatically wakes CEO and delegates to product leader; direct rejection-to-CEO covered by Core tests; local Telegram webhook authentication and duplicate rejection pass | No live Telegram-server message; no semantic model routing claim |
| Setup readiness | Actual native adapter/budget/workspace checks, links to native configuration, Pack compatibility and provider unknown states | A configured model name does not verify its credentials |
| Shadow review | Real independent local SDK session, pinned candidate/goal context, execution binding, closure and idempotent replay; namespaced owning Agent creation, isolated result read and continued Graph execution passed on Docker | Production adapter, same-Agent clone, declarative Graph auto-trigger and active-session restart recovery remain unfinished |
| Graph and Pack dashboards | ADLC and Marketing views, pinned run map and complete workflow, node details, branch/join/rework rendering; actual desktop/mobile browser checks | Only declared Core-supported dashboard metrics, no arbitrary Pack UI execution |
| Artifact review | Actual native Board Decision resolves a mandatory release gate; unauthorized answer rejected; exact candidate version and supervisor rules covered | Synthetic artifacts establish control flow, not production quality |
| Feedback / takeover / knowledge | Source-backed decision lookup, feedback audit; browser takeover → Docker restart → resume preserves Pack, Graph, goals, candidates and completed Shadow records | Does not establish recovery of a Shadow that was still executing at restart |
| Cross-Pack plans | Dependency guard, native run completion, authenticated release evidence and completed ADLC → Marketing acquisition plan | Campaign launch/publication/spend not executed |
| OKRs and strategy | Native versioned company/subordinate goals; old runs keep prior snapshot; scheduled sourced review causes actual CEO fixture revision of a subordinate target | Company target changes remain Board-only; no invented measurements |
| Delivery outcomes | Authenticated metric/release receipts; signature, freshness, scope, candidate digest and target-version rejection tests; missing evidence stays unknown | Local synthetic provider data, not real commercial impact |
| Notifications | Actual Paperclip comments, scheduled outcome reminders and completed-run notices; preferences and durable channel receipts; email/Telegram simulation clearly labeled | Real external outbound remains unavailable |
| Decision traceability | Human/Agent/system audit, exact provider-config before/after, idempotency, supersession, intake provenance, goal and run versions | Final independent review still outstanding |

Private reproducible evidence is in ignored `.e2e/enhancement-result.json`, `.e2e/enhancement-checkpoint.json`, `.e2e/runtime-preflight.json`, and local screenshots. Development failures remain in native history. A passing later fixture does not relabel failed attempts. See the [operations guide](enhancement-operations.md) for scripts and exact runtime restrictions.

### Open completion gates

1. **Production Shadows:** automatic approval review rejected generalizing local fixture execution to production billable sessions. The implemented path only permits the exact local process script, existing remaining budget, a distinct idle reviewer and native timeout of at most 15 minutes. Same-orchestrator cloning and declarative Graph auto-trigger are not delivered. SDK session close is not heartbeat cancellation. Active-session terminal result recovery after worker restart is not implemented; the timeout reconciler must not invent success.
2. **Real external notifications:** automatic approval review rejected adding generic outbound-network authority to the worker. Hooks and local verification are complete, but `externalDeliveryEnabled: false` remains enforced. Email and Telegram outbound are disabled or simulated. No live external delivery is claimed.
3. **Independent final review:** development used the requested GPT-6 Sol / High subagents. They are now quota-blocked; the parent continued integration and repair. Final independent standards/spec review has not run. Do not describe parent review as independent review.

The official uninstall without purge and reinstall succeeded after user authorization, preserving the plugin ID. No permission table or accounting hold was edited. These remaining gates must be resolved before declaring the full enhancement complete or releasing it for production use.
