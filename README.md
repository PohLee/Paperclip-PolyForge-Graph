# Paperclip PolyForge Graph

A versioned Graph engine and [Paperclip](https://github.com/paperclipai/paperclip) plugin. The core executes Pack rules and records decisions; Paperclip supplies company scoped issues, agents, run identity, durable plugin storage, and the UI. This branch contains the unpublished Core/plugin `0.8.0` enhancement with the independently versioned ADLC `0.2.0` and Marketing `0.0.1` candidates in [Paperclip-PolyForge-Graph-Packs](https://github.com/PohLee/Paperclip-PolyForge-Graph-Packs). See the [enhancement operations guide](docs/enhancement-operations.md) and [scope / verification ledger](docs/enhancement-2026-10-29.md) before using it. Core `0.7.0` / ADLC `0.1.10` remain the preceding baseline.

New evidence contracts enforce criterion coverage, human exceptions for unverified criteria, accepted architecture references, and final PR-head report consistency. Implementation can choose backend, frontend, fullstack or parallel and hand off one integrated candidate. Architecture and code delivery are optional graphs. The executable [host check runner](docs/host-check-runner.md) supplies setup, bounded feedback, command/agent checks and logs. Release remains process-only with pipeline unselected. See [implementation and validation notes](docs/evidence-contracts-0.4.0.md) for migration and test limits.

Core 0.5.0 adds an isolated initial review view, dispatch context size inventory, durable handoff snapshots, an adapter-driven behavior comparison harness, an observable human intervention ledger, and background check handles. See the [MCode adaptation notes](../Paperclip-PolyForge-Graph-Packs/packs/adlc/docs/MCODE_STACK_ADAPTATION.md) for the exact scope and host responsibilities.

Core 0.6.0 adds validated request triage and follow-up links, acyclic ticket plans with `readyWorkTickets` and integrated completion proof, optional project-local verification profiles, and evidence requirements before a repeated-error improvement is graduated. See the [ADLC adaptation notes](../Paperclip-PolyForge-Graph-Packs/packs/adlc/docs/MATT_PSTACK_ADAPTATION.md) for payloads and host responsibilities.

Core 0.7.0 adds optional technical design, comprehension, multi-axis audit and pinned-code drift contracts. The design gate requires each finding's disposition; implementation can reference the accepted design version. The host authenticates fresh review sessions, source reads, the repository SHA and code observations. See the [ADLC evidence contracts](../Paperclip-PolyForge-Graph-Packs/packs/adlc/docs/EVIDENCE_CONTRACTS.md).

## First access to the local demo

The Docker demo at [http://localhost:3310/auth](http://localhost:3310/auth) requires a Paperclip login. If you ran the E2E harness, its synthetic owner login is saved locally in ignored `.e2e/auth.json` (`email` and `password`); read that file on your own machine and do not share its contents. After signing in, open [Graph runs](http://localhost:3310/POLAAAA/graph-runs) for the validated demo company. The latest harness company and root issue IDs are in ignored `.e2e/result.json`.

A newly registered personal account has no organization access until an existing company owner or admin invites it. In Paperclip, use **Settings → Members → Invites** to create a single-use invitation link, then accept the link with that account and complete any required approval. Seeing **No organization access** after sign-in means that account has no active company membership; signing in with a different account does not transfer membership.

## What is included

- `src/core`: host independent Graph engine with pinned Pack snapshots, bounded review and rework, versioned evidence, product memory, human escalation, and append only decision records.
- `src/plugin`: Paperclip SDK v2026.1023.0 adapter. It installs managed skills and agents, binds roles to real actors, creates child issues for ready nodes, requests host wakeups, and accepts callbacks from the authenticated Paperclip actor/run context. Agent callbacks must own the matching issue checkout and current Graph attempt.
- `migrations`: company scoped PostgreSQL state with compare and swap revision writes, dispatch reservations, and the company default decision mode.
- `src/plugin/ui.jsx`: a routed Graph page with a sidebar link, a task detail Graph panel, run list, searchable run and company decisions, waiting work, explicit failed-work retry, and company settings inside Paperclip.
- `compose.e2e.yml`: isolated local Paperclip and PostgreSQL at `http://localhost:3310`, using named volumes and a pinned Paperclip image digest.
- `compose.real.yml`: a separate local instance at `http://localhost:3311` for actual Codex agent work, with its own database and project workspace.

The deterministic Docker acceptance proves host dispatch, checkout, callback, persistence and Graph control flow. Actual model acceptance runs separately and requires runnable artifacts and independently checked test results. See the [current acceptance ledger](docs/acceptance-2026-10-28.md) for the evidence and remaining checks. Outside E2E, provisioned agents default to paused `codex_local` adapters with zero budgets until an operator configures a genuine runtime.

The added lifecycle workflows coordinate discovery, release preparation, release observation and production monitoring. They do not deploy code or collect telemetry. Their host prerequisites include authentic candidate/authorization/execution links and fresh observations; the current plugin checks input structure, not the truth of externally supplied release or monitoring evidence. Registering or completing one of these Graphs therefore does not establish a production release or healthy production service.

## Build

Requires Node 24.11 or newer. Install the exact SDK dependency, then build:

```sh
npm ci
npm run build
npm run test:core
```

The plugin loads the separately deployed collection through `POLYFORGE_PACK_ENTRIES` (or `POLYFORGE_PACKS_ENTRY`); the legacy `POLYFORGE_ADLC_PACK_ENTRY` remains a fallback. Publish a changed Pack under a new `id@version`; an existing version is immutable. Build output includes `dist/manifest.js`, `dist/worker.js`, `dist/ui/index.js`, `dist/core/index.js`, `dist/host/experiment.js`, and standalone `dist/check-runner.js`.

## Local Docker run

Place the Pack collection as the sibling directory named `Paperclip-PolyForge-Graph-Packs`. The Compose file mounts this repository and the Pack read only. It uses Paperclip release `2026.1023.0`, Git revision `1b4c803816e82b0265c8422e1a804327a7ed8c54`, image digest `sha256:40f46940c4612ead131aebe6079cd4651f8cd1434af49f7c621887f4a452a62e`.

```sh
node scripts/prepare-e2e-env.mjs
docker compose -f compose.e2e.yml up -d
docker compose -f compose.e2e.yml exec -T paperclip node /opt/polyforge/plugin/scripts/write-e2e-paperclip-config.mjs
docker compose -f compose.e2e.yml exec -T paperclip npx --yes paperclipai@2026.1023.0 auth bootstrap-ceo --data-dir /paperclip --base-url http://localhost:3310
```

The config helper writes an authenticated config for the **existing external PostgreSQL** connection. It refuses a mismatched existing config. Paperclip's pinned CLI requires this config to mint the initial invitation even when its server can start from environment variables. Do not run onboarding with embedded database defaults for this Compose project. Save the printed invite under ignored `.e2e/bootstrap.txt` for the E2E harness, or accept it with a real owner account through the UI.

Install/enable the built plugin from `/opt/polyforge/plugin` through Paperclip’s official plugin flow. In **Company operations → Packs & setup**, enable exact Pack versions, provision roles and skills, and align the native Board → CEO → domain leader reporting links. Use the native Agent/project configuration links to set model connections, budgets and repositories. The plugin records the reporting plan and verifies the applied result; conflicting custom managers are preserved for review. See the [enhancement operations guide](docs/enhancement-operations.md) for configuration and current approval limits.

Run `node scripts/e2e.mjs` after the host is bootstrapped; the harness installs the plugin if needed. The harness keeps its owner session and output under ignored `.e2e/`; open the local `/auth` page and read `.e2e/auth.json` on your own machine for the synthetic test login, and use `.e2e/result.json` for company, issue, and run IDs. Never paste those credentials into a report. The harness uses real Paperclip agent executions with a deterministic fixture script at `scripts/e2e-fixture-agent.mjs`. The fixture adapter is selected only when `POLYFORGE_FIXTURE_AGENT_SCRIPT` is set in the E2E host. A normal deployment must configure genuine agent runtimes and authorize budgets deliberately.

The Graph settings page lets a company owner choose the default mode for **new** runs. It starts as `manual`; `assisted` and `autonomous` are available after the operator reviews the Pack's gates and agent configuration. A start request that omits `mode` uses the current company default, and each run stores its chosen mode so a later settings change cannot alter an active run. The run form may override the default for one run. The settings page also shows the current role bindings and human roles; saving a change records the previous and requested values in the decision history.

If a Paperclip heartbeat fails or is interrupted, inspect the host run ID shown in the Graph run detail, then use **Retry node** with a reason on the root issue. This requires an authorized human owner, records the abandoned attempt, and creates a new dispatch attempt while retaining prior records. The worker does not silently replay a failed callback.

Each node attempt claims its wakeup atomically. If the wake request has not supplied its run ID, a callback may bind that ID only after Paperclip confirms the exact checkout owner and run for the current child issue and attempt. A later response cannot overwrite a different ID. Unconfirmed dispatches remain `waking` and are not automatically sent again. Inspect the agent's host activity, then use an owner retry when appropriate; the new attempt preserves the uncertain attempt's history.

Normal authenticated Graph commands and callbacks dispatch eligible next work. After an interruption leaves ready work undispatched, an authorized owner can use **Dispatch ready work**; this records a recovery request and preserves existing attempts. The equivalent POST operation is `dispatch` with a nonempty `reason` on the run's root issue. Migration `003_dispatch_requests.sql` stores these requests separately so concurrent recovery requests retain individual audit records without rewriting the whole company snapshot. Run and company decision histories include those records. Background timers do not invoke host writes because this Paperclip version requires an active invocation scope.

If Paperclip blocks the agent while completed runs await accounting, resolve that host accounting condition before retrying. Changing the role binding does not resolve a missing accounting receipt.

For an installed development plugin, preflight the enabled Pack versions and active runs, rebuild the package, and use Paperclip's plugin upgrade endpoint (`POST /api/plugins/pohlee.polyforge-graph/upgrade`) to preserve Graph data. Migration `002_default_mode.sql` adds the default mode and `003_dispatch_requests.sql` adds the owner dispatch audit table; the host applies missing migrations in order. Restart the local Paperclip service before upgrading a mounted local plugin if it has cached the old manifest module. The Graph runs page uses a compact run list and puts current work and human decisions above the expandable node and decision records. It also adds a sidebar contribution and an issue task detail panel because Paperclip's current task chat shell does not show legacy detail tabs.

## API and operation boundary

For issue `<issueId>`, the plugin registers:

```text
GET  /api/plugins/pohlee.polyforge-graph/api/issues/<issueId>/graph?runId=<runId>
POST /api/plugins/pohlee.polyforge-graph/api/issues/<issueId>/graph
```

The POST body has an `operation` and relevant Graph fields. Operations include `provision`, `org-reporting-plan`, `org-reporting-confirm`, `configure`, `reload-pack`, `start`, `record-work-decision`, `submit`, `self-review`, `review`, `decide`, `escalate`, `resolve-human-gate`, `pause`, `resume`, `record-conflict-position`, `open-conflict`, `resolve-conflict`, `resolve-rework-limit`, `retry-node`, `invalidate-evidence`, `product-decision`, and `dispatch`. A standalone approved product decision can be recorded before starting a feature run, then its ID is supplied in `input.product_decision_refs`. A run uses `manual`, `assisted`, or `autonomous` mode; omitted `mode` uses the company default. Its start input must include versioned requirements and product decision references; implementation and verification also require the preceding Graph's final versioned identity.

New Pack artifact tasks require a prior explicit work decision. Record its question, chosen option, reason and source evidence through `record-work-decision`, then pass the returned ID in `submit.decisionIds`. The record must belong to the same actor, execution and current node attempt. A single-option application of a pinned rule uses `ruleRef`; it does not need invented alternatives. Feature work also declares its product behavior impact. An unknown impact blocks submission; a behavior change requires a matching approved product decision replacement. Existing pinned tasks without this requirement remain compatible.

The conflict protocol records CPO and CTO positions separately. Human options have an explicit `continue`, `rework` or `stop` disposition. Resolving a conflict executes that disposition; a later gate must cite the human resolution and still satisfy its normal evidence requirements. The company and run decision histories expose the complete records and version context.

Pack `0.1.6` / Design Graph `0.1.2` require the final design decision to name exactly one current frozen finalist. The core validates the selected artifact ID and version against both the current shortlist and completed frozen candidates. The comparison and reasons remain in the experiment artifact and Decision Record. Existing runs keep their original selection contract.

The body does not supply actor identity. The host's authenticated user or agent run is mapped to core `actor`; company membership and configured role bindings are checked. Agent node callbacks are restricted to their current child issue, checkout owner, dispatch phase, attempt, and Paperclip run ID. All mutations support `idempotencyKey` for retries. Decision and review evidence can include `subjectRefs:[{artifactId,version}]` bound to the exact candidate version.

The core's full Pack and runtime contract is in [src/core/contract.md](src/core/contract.md). Domain terms are in [GLOSSARY.md](GLOSSARY.md). The baseline scope and acceptance requirements are in [docs/requirements-baseline.md](docs/requirements-baseline.md). Upstream API references: [Plugin authoring guide](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/doc/plugins/PLUGIN_AUTHORING_GUIDE.md), [SDK README](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/packages/plugins/sdk/README.md), and [process adapter](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/server/src/adapters/process/execute.ts).

This repository retains its LGPL-2.1 license. The ADLC Pack is a separate repository with its own licensing decision.

See [Docker and browser validation](docs/e2e-validation.md) for the pinned host build, exact fixture results, restart checks, and UI screenshots saved in the ignored local `.e2e/` directory.
