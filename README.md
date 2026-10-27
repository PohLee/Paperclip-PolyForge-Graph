# Paperclip PolyForge Graph

A versioned Graph engine and [Paperclip](https://github.com/paperclipai/paperclip) plugin. The core executes Pack rules and records decisions; Paperclip supplies company scoped issues, agents, run identity, durable plugin storage, and the UI. The separate [ADLC Pack](../Paperclip-PolyForge-Graph-ADLC) provides the first three Graphs and 11 role definitions.

## First access to the local demo

The Docker demo at [http://localhost:3310/auth](http://localhost:3310/auth) requires a Paperclip login. If you ran the E2E harness, its synthetic owner login is saved locally in ignored `.e2e/auth.json` (`email` and `password`); read that file on your own machine and do not share its contents. After signing in, open [Graph runs](http://localhost:3310/POLAAAA/graph-runs) for the validated demo company. The latest harness company and root issue IDs are in ignored `.e2e/result.json`.

A newly registered personal account has no organization access until an existing company owner or admin invites it. In Paperclip, use **Settings → Members → Invites** to create a single-use invitation link, then accept the link with that account and complete any required approval. Seeing **No organization access** after sign-in means that account has no active company membership; signing in with a different account does not transfer membership.

## What is included

- `src/core`: host independent Graph engine with pinned Pack snapshots, bounded review and rework, versioned evidence, product memory, human escalation, and append only decision records.
- `src/plugin`: Paperclip SDK v2026.1023.0 adapter. It installs managed skills and agents, binds roles to real actors, creates child issues for ready nodes, requests host wakeups, and accepts callbacks from the authenticated Paperclip actor/run context. Agent callbacks must own the matching issue checkout and current Graph attempt.
- `migrations`: company scoped PostgreSQL state with compare and swap revision writes, dispatch reservations, and the company default decision mode.
- `src/plugin/ui.jsx`: a routed Graph page with a sidebar link, a task detail Graph panel, run list, decisions, waiting work, explicit failed-work retry, and company settings inside Paperclip.
- `compose.e2e.yml`: isolated local Paperclip and PostgreSQL at `http://localhost:3310`, using named volumes and a pinned Paperclip image digest.

The Graph engine never pretends to perform model work. The Docker E2E uses deterministic process agents to prove host dispatch, checkout, callback, persistence, and three Graph paths. Those fixture results are infrastructure evidence, not LLM quality validation. Outside E2E, provisioned agents default to paused `codex_local` adapters with zero budgets until an operator configures a genuine runtime.

## Build

Requires Node 24.11 or newer. Install the exact SDK dependency, then build:

```sh
npm ci
npm run build
npm run test:core
```

The plugin package loads `POLYFORGE_ADLC_PACK_ENTRY` from the separately deployed Pack's `index.mjs`. Publish a changed Pack under a new `id@version`; an existing version is immutable. Build output is `dist/manifest.js`, `dist/worker.js`, and `dist/ui/index.js`.

## Local Docker run

Place the ADLC Pack as the sibling directory named `Paperclip-PolyForge-Graph-ADLC`. The Compose file mounts this repository and the Pack read only. It uses Paperclip release `2026.1023.0`, Git revision `1b4c803816e82b0265c8422e1a804327a7ed8c54`, image digest `sha256:40f46940c4612ead131aebe6079cd4651f8cd1434af49f7c621887f4a452a62e`.

```sh
node scripts/prepare-e2e-env.mjs
docker compose -f compose.e2e.yml up -d
docker compose -f compose.e2e.yml exec -T paperclip node /opt/polyforge/plugin/scripts/write-e2e-paperclip-config.mjs
docker compose -f compose.e2e.yml exec -T paperclip npx --yes paperclipai@2026.1023.0 auth bootstrap-ceo --data-dir /paperclip --base-url http://localhost:3310
```

The config helper writes an authenticated config for the **existing external PostgreSQL** connection. It refuses a mismatched existing config. Paperclip's pinned CLI requires this config to mint the initial invitation even when its server can start from environment variables. Do not run onboarding with embedded database defaults for this Compose project. Save the printed invite under ignored `.e2e/bootstrap.txt` for the E2E harness, or accept it with a real owner account through the UI.

Install/enable the built plugin in Paperclip from `/opt/polyforge/plugin` using the [host's plugin installation flow](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/doc/plugins/PLUGIN_AUTHORING_GUIDE.md). In **Graph settings**, a company owner can select **Provision new agents and align** to create the Pack's 11 managed agents and five managed skills and set their organization links, or **Align existing agents** after an upgrade. The returned role bindings can be edited with `configure`; Paperclip owner/admin membership grants the trusted `human-owner` role. All mutations use a real Paperclip user session or agent run token.

The pinned Paperclip managed-agent SDK does not declare or update `reportsTo`. The plugin records a durable owner-approved organization plan before changing anything. The owner's authenticated browser then uses Paperclip's normal `PATCH /api/agents/:id` route with only `reportsTo`; the plugin re-reads the managed agents and records a linked applied decision only when every link matches. If a PATCH or confirmation fails, rerun alignment: the plugin reuses the incomplete approved plan and applies only remaining links. The two Board roots remain unset and the other nine roles report to CPO or CTO+CAIO as defined by the Pack's `reportsToRole` field. The Graph's `supervisorRole` controls independent artifact review and does not define the organization chart. A nonempty custom manager that conflicts with the plan blocks alignment instead of being overwritten. For a local CLI equivalent, run `node scripts/reconcile-adlc-reporting.mjs` with the E2E owner session in ignored `.e2e/auth.json`; add `--provision` for a new company and set `POLYFORGE_ORG_COMPANY_ID`/`POLYFORGE_ORG_ISSUE_ID` when selecting a company other than the saved E2E fixture. Keep that session file private.

Run `node scripts/e2e.mjs` after the host is bootstrapped; the harness installs the plugin if needed. The harness keeps its owner session and output under ignored `.e2e/`; open the local `/auth` page and read `.e2e/auth.json` on your own machine for the synthetic test login, and use `.e2e/result.json` for company, issue, and run IDs. Never paste those credentials into a report. The harness uses real Paperclip agent executions with a deterministic fixture script at `scripts/e2e-fixture-agent.mjs`. The fixture adapter is selected only when `POLYFORGE_FIXTURE_AGENT_SCRIPT` is set in the E2E host. A normal deployment must configure genuine agent runtimes and authorize budgets deliberately.

The Graph settings page lets a company owner choose the default mode for **new** runs. It starts as `manual`; `assisted` and `autonomous` are available after the operator reviews the Pack's gates and agent configuration. A start request that omits `mode` uses the current company default, and each run stores its chosen mode so a later settings change cannot alter an active run. The run form may override the default for one run. The settings page also shows the current role bindings and human roles; saving a change records the previous and requested values in the decision history.

If a Paperclip heartbeat fails or is interrupted, inspect the host run ID shown in the Graph run detail, then use **Retry node** with a reason on the root issue. This requires an authorized human owner, records the abandoned attempt, and creates a new dispatch attempt while retaining prior records. The worker does not silently replay a failed callback.

For an installed development plugin, rebuild the current v0.2.4 package and use Paperclip's plugin upgrade endpoint (`POST /api/plugins/pohlee.polyforge-graph/upgrade`) to preserve Graph data. Migration `002_default_mode.sql` applies when upgrading from v0.1.0. Restart the local Paperclip service before upgrading a mounted local plugin if it has cached the old manifest module. The Graph runs page uses a compact run list and puts current work and human decisions above the expandable node and decision records. It also adds a sidebar contribution and an issue task detail panel because Paperclip's current task chat shell does not show legacy detail tabs.

## API and operation boundary

For issue `<issueId>`, the plugin registers:

```text
GET  /api/plugins/pohlee.polyforge-graph/api/issues/<issueId>/graph?runId=<runId>
POST /api/plugins/pohlee.polyforge-graph/api/issues/<issueId>/graph
```

The POST body has an `operation` and relevant Graph fields. Operations include `provision`, `org-reporting-plan`, `org-reporting-confirm`, `configure`, `reload-pack`, `start`, `submit`, `self-review`, `review`, `decide`, `escalate`, `resolve-human-gate`, `pause`, `resume`, `open-conflict`, `resolve-conflict`, `resolve-rework-limit`, `retry-node`, `invalidate-evidence`, `product-decision`, and `dispatch`. A standalone approved product decision can be recorded before starting a feature run, then its ID is supplied in `input.product_decision_refs`. A run uses `manual`, `assisted`, or `autonomous` mode; omitted `mode` uses the company default. Its start input must include versioned requirements and product decision references; implementation and verification also require the preceding Graph's final versioned identity.

The body does not supply actor identity. The host's authenticated user or agent run is mapped to core `actor`; company membership and configured role bindings are checked. Agent node callbacks are restricted to their current child issue, checkout owner, dispatch phase, attempt, and Paperclip run ID. All mutations support `idempotencyKey` for retries. Decision and review evidence can include `subjectRefs:[{artifactId,version}]` bound to the exact candidate version.

The core's full Pack and runtime contract is in [src/core/contract.md](src/core/contract.md). Domain terms are in [GLOSSARY.md](GLOSSARY.md). The baseline scope and acceptance requirements are in [docs/requirements-baseline.md](docs/requirements-baseline.md). Upstream API references: [Plugin authoring guide](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/doc/plugins/PLUGIN_AUTHORING_GUIDE.md), [SDK README](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/packages/plugins/sdk/README.md), and [process adapter](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/server/src/adapters/process/execute.ts).

This repository retains its LGPL-2.1 license. The ADLC Pack is a separate repository with its own licensing decision.

See [Docker and browser validation](docs/e2e-validation.md) for the pinned host build, exact fixture results, restart checks, and UI screenshots saved in the ignored local `.e2e/` directory.
