# Core 0.8 enhancement operations

This is an unpublished implementation candidate. The [scope and acceptance ledger](enhancement-2026-10-29.md) distinguishes implemented code, executed tests, and outstanding host approval. A passing unit suite does not establish Docker, model, or external service acceptance.

## Repositories and installation

Core remains `Paperclip-PolyForge-Graph`. Official Pack sources are in [Paperclip-PolyForge-Graph-Packs](https://github.com/PohLee/Paperclip-PolyForge-Graph-Packs), with independently versioned `packs/adlc` and `packs/marketing`. The collection entry exports `packs`; its legacy `pack` export selects ADLC for existing consumers.

Set `POLYFORGE_PACK_ENTRIES` to one or more deployed `index.mjs` entries, separated by the operating system's path delimiter (`;` on Windows, `:` inside the Linux container). A collection entry can provide several Packs. `POLYFORGE_PACKS_ENTRY` accepts a single collection entry. Explicit collection configuration takes precedence over the legacy `POLYFORGE_ADLC_PACK_ENTRY`.

The instance catalog installs releases. A company separately enables an exact Pack version. Provisioning uses namespaced role and skill keys such as `adlc:lead-engineer`; the company CEO is shared across the company's Packs. Enabling a Pack does not grant a model account, budget, or external service connection.

Pack releases declare a Core range, schema/contracts, and required/optional capability versions. Activation and execution validate these declarations; selected operations also check their optional capability. Released `id@version` and payload digest are immutable. Active runs keep the Pack, Graph, mode, and goal revisions captured at start. Changing a company activation or goal affects future work.

The build writes `dist/runtime-artifact.json`, which identifies the runtime contracts and SHA-256 hashes of the package metadata and built Core, manifest, worker and UI. `scripts/runtime-preflight.mjs --candidate <root>` verifies these bytes without executing the candidate, verifies the caller is a native instance administrator, lists all companies through the official API, and checks every company's enabled Packs and unfinished pinned runs. A raw `--runtime` metadata file with repeated `--company` IDs is a legacy diagnostic mode; it does not establish artifact identity or instance coverage.

`scripts/upgrade-runtime.mjs` requires a reviewed report and repeats the artifact, complete company-set and compatibility checks. Its default is a dry run. Explicit `--apply` calls the official upgrade route only when the host's installed `packagePath` is exactly the verified candidate path. Run it on the Paperclip host; a Windows path cannot attest bytes at a different container path. The real Docker instance-wide preflight passed for all six companies; actual application by this wrapper was not performed. Paperclip has no plugin upgrade veto hook, so the wrapper cannot intercept an administrator using the native upgrade route directly. The hashes establish local candidate identity, not publisher signature or provenance.

## Company setup

Open **Company operations → Packs & setup**:

1. Enable and provision the selected Pack versions.
2. Align Board → CEO → domain leaders. The plugin records the plan, the authenticated browser applies native reporting links, and the plugin verifies the result. Conflicting custom managers require operator review.
3. Follow each role's native Agent settings link to choose an adapter/model, configure its connection and tools, authorize a budget, and activate it.
4. Configure project repositories and primary workspaces through the native project settings.
5. Choose the decision mode for new work and inspect per-Graph compatibility/readiness. Missing provider verification is shown as unknown.
6. Configure notification preferences separately from provider credentials and exact recipient bindings.

The setup view reads actual native configuration. It cannot prove provider credentials from a model name alone. A synthetic `process` fixture is explicitly labeled; it provides no model-quality evidence.

## Authenticated interfaces

```text
GET  /api/plugins/pohlee.polyforge-graph/api/company?companyId=<id>
POST /api/plugins/pohlee.polyforge-graph/api/company
GET  /api/plugins/pohlee.polyforge-graph/api/graph?companyId=<id>&runId=<id>
GET  /api/plugins/pohlee.polyforge-graph/api/issues/<issueId>/graph?runId=<id>
POST /api/plugins/pohlee.polyforge-graph/api/issues/<issueId>/graph
```

Company mutations include `companyId`, `operation`, a nonempty `reason`, and an `idempotencyKey`. Identity comes from Paperclip. Agent role, company, checkout, and execution checks remain at the host boundary. The company-wide Graph read route is for authenticated human members; Agent callbacks use the scoped issue route. UI reads use authenticated routes because the SDK data callback does not carry viewer identity.

Company operations include Pack enablement/provisioning, reporting plans, execution mode, authenticated chat intake, work plans, goal revisions, source-backed knowledge, feedback/takeover, native Decision synchronization, provider configuration, signed evidence import, and outcome review. CEO delegation requires the exact bound CEO's authenticated execution and an explicit Board operation scope. Company-level goals remain Board-controlled. The actual native chat event automatically woke a local CEO fixture and delegated its declared request to the product leader. Local Shadow restrictions are described below.

Work-plan items pin Pack versions. Starting an item validates dependencies and atomically links its exact project/Pack/Graph run. Completion is derived from the linked completed run. A human cannot mark an unexecuted predecessor complete to unlock downstream work. Reconciliation is repeatable and records changes.

Goal revisions project into native company/Agent goals. Omitted goals are cancelled in the native projection while historical Core revisions remain. Each dispatched task receives an immutable `goal.md` issue document built from its run snapshot. A later revision or replay cannot replace that snapshot.

## Trusted evidence providers

Configure a company provider with `configure-evidence-providers`. Its configuration contains an ID, allowed project IDs, receipt kinds (`metric` or `release`), optional maximum age, and a **Paperclip secret reference**. A `provider` upsert preserves peers; a `providers` array explicitly replaces the set. Changes record exact before/after settings and the authenticated actor. Changed requests cannot reuse an idempotency key, and replaying an old success cannot revert newer settings. Never put a secret value in Pack metadata, a decision, or a browser report.

`import-evidence` receives a receipt and a SHA-256 HMAC signature. The canonical payload is JSON with recursively sorted object keys; array order is preserved. The shared `canonicalEvidence` implementation defines those bytes. The host checks the configured provider, company/project, allowed kind, signature, issue/expiry times and receipt shape before recording a trusted system observation.

A metric receipt identifies the goal revision, goal, key result, measurement source/window, value and observation time. An outcome review selects its `evidenceReceiptId`. Unverified values and URLs remain unknown. Optional `runId` attribution must refer to a completed run in the same project and uses that run's original goal revision. Linking a review to a Pack records its context; it does not prove causal business impact.

A release receipt identifies the source run, execution event, implementation candidate and authorization decision. Its `subjectRefs` must attest the exact release record ID, version and digest. Cross-Pack handoff also checks the completed producing node, the artifact's exact source references, the source Pack's declared contract, and the enabled target Pack/Graph versions. Configuring a provider alone does not establish a release.

## Channels and Shadows

The channel bridge has company-bound sender/recipient configuration, webhook secret validation, durable claims and delivery receipts. Telegram follows the official Bot API secret header and send-message API. Email uses a configured HTTPS delivery gateway. Ambiguous delivery is retained as unknown and is not automatically retried. Provider secret values are resolved only at delivery.

Worker hooks are connected: native Paperclip comment events, the Telegram webhook, channel delivery, outcome reminders and sourced strategy review jobs. Native comment intake, webhook authentication/replay rejection, actual Paperclip comments, scheduled reminders, terminal Graph notifications and a sourced CEO subordinate-goal revision passed on Docker. Notifications use each channel's durable receipt; an outbox item alone is not proof of delivery. Simulated external receipts remain explicitly simulated.

Real email/Telegram outbound is **unavailable in this build**: the worker has no outbound-network capability and passes `externalDeliveryEnabled: false`. The UI offers disabled or simulation mode. Automatic approval review rejected adding generic worker egress authority. Transport helpers were tested with mocks/local HTTP only; no real external messages were sent. Incoming Telegram was verified by a local request to the real registered webhook, not a message through Telegram's servers.

Core 0.8.1 supports a company-enabled native Shadow policy for `process`, `codex_local`, `claude_local` and `opencode_local`. Each review needs an existing bound Agent, remaining native budget, positive adapter timeout within the company limit (at most 15 minutes), and concurrency headroom. Agent-triggered reviews use that same Agent in a fresh session; an owner can select a bound reviewer. The Agent must match its pinned Pack role, current dispatch and native checkout. Shadows cannot exercise parent Graph/company authority. Only deterministic process execution was used in acceptance; configured production model adapters were not invoked.

ADLC 0.2.1 verification Graph 0.1.4 declares a required same-Agent review before QA dispatch. Review packets retain candidate digests and filtered pinned goals while excluding author conversation/assessment and sensitive fields. Durable launches and leases recover exact native terminal results after worker restart. Stop intent prevents acceptance atomically; it does not cancel a running native heartbeat. Ambiguous session creation remains for repair. Full-host interruption records the actual native failure without launching a replacement. See [Shadow execution and recovery](shadow-runtime-2026-10-30.md) for the contract and current acceptance evidence.

## Isolated Docker verification

`compose.enhancement.yml` uses port **3312** and its own database/data volumes. It mounts these two enhancement worktrees and uses a pinned Paperclip image. It does not share the 3310 or 3311 databases.

Build Core first, start that Compose project, initialize its external-database config with `write-e2e-paperclip-config.mjs`, and bootstrap its synthetic owner through the official Paperclip CLI. The ignored `.e2e/enhancement-auth.json` contains test credentials; do not publish it. The enhancement harness is `node scripts/e2e-enhancement.mjs`; checkpoints and results are ignored under `.e2e/`.

The main harness creates synthetic process Agents on the real host. Follow-ups are `e2e-enhancement-followups.mjs shadow`, `e2e-ceo-intake.mjs`, `e2e-enhancement-recovery.mjs` and `e2e-enhancement-final-checks.mjs`. Check plugin readiness after a container restart; HTTP readiness can precede plugin startup. The results include native Decision submission, release receipt rejection cases, completed ADLC-to-Marketing work, bounded Shadows and native channel/strategy jobs. Browser takeover, Docker restart and resume preserve the original Pack/Graph, goal revisions, candidates and completed Shadow records. Failed development attempts remain in native history; successful later fixtures do not turn those failures into passes.

Real browser checks used the authenticated Docker pages at desktop and 390px mobile widths. Notification receipts, Pack views, full/pinned Graph views, fit-to-width and takeover/resume were inspected. The new Shadow policy/status controls were checked at desktop width. Local screenshots and private checkpoints stay under ignored `.e2e/`; the public scope ledger summarizes the evidence. GPT-6 Sol / High independent Standards and Spec review found a P1 stop race, then verified its repair with no remaining P0/P1. Local process results establish control behavior, not model quality, actual market outcomes or external-provider delivery.

The pinned Paperclip 2026.1023.0 upgrade path rejected newly added capabilities before presenting its intended upgrade approval state and stopped the worker. The user-authorized official uninstall-without-purge/reinstall succeeded on 3312 and retained the plugin ID. No backup was made, as requested. No host permission record or model-accounting hold was edited. The rebuilt plugin is running on the isolated enhancement instance.
