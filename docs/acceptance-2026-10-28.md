# MVP acceptance — 2026-10-28

This report tracks the follow-up request to close the gaps identified after the initial MVP. It supersedes the coverage summary in `e2e-validation.md` only where a completed check below supplies newer evidence. Earlier failed runs and earlier validation reports remain part of the history.

## Target

- Core plugin: `pohlee.polyforge-graph@0.3.0`.
- ADLC Pack: `adlc@0.1.6`; Design and Implementation Graphs: `0.1.2`; Verification Graph: `0.1.1`. The Pack also includes four lifecycle Graphs at `0.1.0`, added in the separate user-requested chat **补充 ADLC pack 参考实践**; their compatibility is checked separately from the original three-Graph MVP matrix. The completed `0.1.5` matrix is retained and supplemented with focused `0.1.6` regressions.
- Paperclip: pinned `2026.1023.0` image from the Compose files.
- Mechanism acceptance: existing authenticated Docker instance on `http://localhost:3310`.
- Actual model acceptance: separate authenticated Docker instance on `http://localhost:3311`, using `codex_local`, GPT-6 Sol, High reasoning.

## Acceptance ledger

Statuses are deliberately evidence based. A passing source test is not a passing Docker run, and a deterministic fixture is not evidence of model-generated product work.

| Requirement | Required evidence | Status |
| --- | --- | --- |
| Core and domain Pack remain separate | Separate repositories, versioned Pack import, unchanged old run snapshots | Verified in source and Docker; old `0.1.0` and `0.1.4` runs retained |
| Three Graphs complete an actual project | Actual Design, Implementation, Verification runs; runnable artifacts; independent reviews; executable tests | **Blocked** by Paperclip accounting receipts; real host Codex probe/file output verified, full project not accepted |
| Design major route | Research, two wireframes, independent filters, eight candidates, frozen versions, QC, two finalists and prototypes | Pack 0.1.5 Docker fixture passed; 72 successful host heartbeats |
| Final design selection | Explicitly choose exactly one current frozen finalist; reject multiple, stale and non-finalist artifacts | Source and Pack 0.1.6 Docker checks passed; explicitly selected the second finalist |
| Decision modes | New-run default and pinned run mode; manual/assisted/higher automation gates | Source tests and earlier Docker checks passed; final installed versions verified |
| Version pinning | Old run retains its Pack and Graph after upgrade; new run receives new versions | Docker matrix passed: old `0.1.0` run resumed/completed, new run pinned `0.1.5`; final deployment also retains real `0.1.4` run |
| Important artifact review | Self-review evidence, five-round ceiling, separate supervisor execution, unresolved P0/P1 causes escalation/rework | Docker fixture passed: five open-P1 reviews → independent rework → accepted second attempt |
| CPO/CTO disagreement | Separately attributed positions in one run, negotiation dossier, unresolved pause, authenticated human resolution | Docker human rework, continue and stop passed |
| Product decision memory | Active decision context; explicit behavior impact; proposal and approved successor; retained history; stale/unauthorized changes rejected | Source and Docker matrix passed |
| Versioned handoffs and invalidation | Specific Design/Implementation identity passed onward; old reports rejected after change; history retained | Docker matrix passed; Pack 0.1.6 Implementation continued with the explicit unique Design winner |
| Explicit decisions are traceable | Work choices bound to actual actor, run, node and attempt; persistent reasons, sources, options/rules; searchable run/company records | Browser checks passed; all 36 new major-run work choices have the correct feature and run association |
| Original role responsibilities | Eleven role instructions and bundled methods, with unavailable external tools identified as capability requirements | Pack source and tests passed |
| Organization structure | Two Board roots, nine correct reporting edges, same agent IDs, no-op repeat, recorded alignment plan/result | Old POLAA and current POLAAAAAAA organization repaired/checked; fixture now aligns before dispatch |
| Historical Product Owner failure | Preserve original failure; diagnose exact stderr; recover via a new audited attempt | Verified on Docker with a deterministic recovery fixture; original failure retained |
| Source and running versions match | Installed manifest version, deployed bundle hashes, passing suite and final smoke | Core 44 pass/1 Docker skip, Pack 20 pass; both final Docker installations ready with matching bundle hashes |

### Added lifecycle workflows

Pack `0.1.5` registers seven Graphs successfully with the current core. Discovery and release start/outcome decisions require a human in all modes. Monitoring requires a human in manual mode and permits the assigned CTO agent in assisted/autonomous modes.

The four additional lifecycle Graphs declare host prerequisites in the Pack's `runtimeRequirements` and `docs/ADLC_BEST_PRACTICES.md`. The current core validates required input structure and applicable product references. It does not authenticate external deployment events, verify that release inputs identify the same actual candidate, or collect and establish the freshness of production telemetry. These flows coordinate supplied evidence; they are not validated production deployment or automatic monitoring integrations. The original three-Graph Docker matrix does not certify them as such.

## What the decision guarantee covers

The plugin records explicit product, engineering, process, configuration and authorization choices through its command boundary. New Pack artifact tasks require prior Decision Record IDs from the same trusted actor and execution attempt. Applying an existing rule can be recorded with one option and a reference that resolves in the pinned Pack; agents are not required to invent alternatives.

The record is a concise decision, rationale and evidence trail. It is not a transcript of private model reasoning. External work must be reported through the contract; the plugin does not intercept every arbitrary tool invocation. The product behavior declaration and independent review are safeguards, not a claim of automatic semantic detection of every possible behavior change.

## Reproduction and private evidence

- Deterministic acceptance runner: `node scripts/e2e-acceptance.mjs` after deployment and the existing owner bootstrap; focused final regressions: `node scripts/e2e-acceptance-regressions.mjs`. The full runner uses versioned checkpoints/results and verifies actual run versions. Running it from the current `0.1.6` Pack creates a separate full matrix; it does not relabel or overwrite the historical `0.1.5` result.
- Real runtime: `compose.real.yml`, with secrets prepared by `node scripts/prepare-real-env.mjs`; local credentials remain under ignored `.env.real` and `.e2e/`.
- Preserve Docker volumes and original host run records. Retrying creates a new attempt and an audit decision; it does not rewrite a failed heartbeat to success.
- Never publish owner cookies, invitation URLs/tokens or Codex credentials with this report.

Private local result files are `.e2e/acceptance-result.json` (the completed `0.1.5` matrix) and the versioned regression result/checkpoint files for `0.1.6`. They are ignored because the local evidence directory also contains authentication material. Relevant non-secret identities and results are recorded below.

## Corrections found during acceptance preparation

- An early upgrade registered `adlc@0.1.2` before the final policy changes. A semantic comparison found changes in skills and policy documents, so the final Pack was advanced to `0.1.3`; persisted `0.1.2` snapshots were retained. The three Graph definitions were unchanged from their published `0.1.1` versions.
- The separate user-requested chat **补充 ADLC pack 参考实践** subsequently added method adaptations, feature/defect classification, readiness, root-cause investigation and a failing reproduction in Pack `0.1.4`. A later explicit request in that chat added discovery, release preparation, release observation and production monitoring in Pack `0.1.5`, with 20 passing Pack tests. These changes were preserved. The matrix below identifies its exact `0.1.5` snapshot. The existing real Design run retains its original `0.1.4` snapshot.
- Rechecking the original **Paperclip agents** requirements exposed an implicit-first-finalist assumption in the acceptance harness. Pack `0.1.6`/Design `0.1.2` now require an explicit, unique winner from the current frozen finalist shortlist. Both normal and human approval reject multiple, stale, or non-finalist selections. Other Graph versions remain unchanged; old snapshots are not rewritten.
- The first real Paperclip Codex probe returned a successful heartbeat but could not create an artifact because the inner Linux sandbox failed with `bwrap: No permissions to create a new namespace`. This probe was classified as failed product execution despite its process status. A subsequent probe used Paperclip's supported CLI mode within the isolated Docker boundary and created the expected file. The host Codex configuration was not changed. The Compose service retains loopback exposure, read-only plugin/Pack mounts, and a writable test-project mount.
- The old POLAA organization had eleven agents reporting to Board. The owner plan/PATCH/confirm procedure restored nine reporting edges while retaining the two intended Board roots and all eleven agent IDs. Host configuration revisions recorded only `reportsTo` changes; a repeated alignment was a no-op. Derived `orgChainHealth` is excluded from configuration preservation comparisons because it necessarily changes with the reporting chain.

## Historical Product Owner recovery

The original user-reported heartbeat `ee456a15-8b67-45e4-b76c-6af78ec54c15` remains failed with exit code 1. Its Graph run `390d6271-8d60-48fd-89fd-adee8657b770` retains Pack and Graph `0.1.0`.

An authenticated owner retry recorded Decision `07f3e381-fe14-4f4a-9462-a20cd1a9341d` and the `node.retry_requested` audit event. Attempt 1 remains `abandoned_before_submission`. Attempt 2 created child issue `997f66fd-aa7e-467a-b4f8-ea54f2e122f6` and heartbeat `a6a33c43-93f2-4cb7-8d8b-053703b4afed`, which succeeded with exit code 0. The new classify decision's execution identity matches that heartbeat, and the Graph completed. This verifies audited recovery using the deterministic fixture; it does not count as real model product acceptance.

## Interrupted real-model execution

Docker Desktop stopped while the real Design run `cec44417-b219-4b8f-b22b-be02d25ad6db` was at its first classify node. Existing containers and volumes were started again on 28 October; the original heartbeat became `failed/process_lost`. Paperclip then blocked the original agent because completed provider work had no accounting receipt. The Graph retry history is preserved, but the full real-model chain remains unverified.

A temporary role reassignment started an additional heartbeat on another agent. It was cancelled and the original binding restored because using a different agent would evade the accounting guard. No host database or accounting values were edited. Work must resume through a supported accounting recovery, with the original failure and all retry decisions retained.

Read-only host diagnostics show two `waiting_for_receipt` runs with missing acknowledgments marked `repairable:false`. The persistent receipt spool is empty; database usage receipts are partial and none is complete. The original NDJSON contains no `turn.completed` or usage event. The official accounting retry cannot account for provider work without its complete receipt; no supported operator write-off was found. The final real validator correctly exits 1 because the Design Graph is still running, and produces no downstream handoff.

The original Codex sessions were on tmpfs. The real Compose service now persists `/paperclip/.codex/sessions` in its own named volume while keeping authentication under the original tmpfs/read-only credential arrangement. This prevents the same session-file loss on a future restart; it cannot reconstruct the missing historical receipt. Both accounting holds, original agent binding and existing database/data volumes remain intact.

The successful earlier adapter probe wrote `.probe/PROBE.txt`, SHA-256 `ea081d67ef7192a4e6e22d86205275587391cc6e4abd8392cafaec147d34eb0e`, using the actual OpenAI `gpt-6-sol` provider through `codex_local`. High reasoning is verified only in the current agent configuration; the historical heartbeat receipt does not independently prove its reasoning setting. Probe files are explicitly excluded from real deliverables.

## Browser check of the decision-history UI

The existing authenticated owner session at `http://localhost:3310/POLAAAA/graph-runs` loaded the deployed `0.3.0` UI. The historical Implementation run still displayed Graph `0.1.0`, confirming that the UI did not relabel old runs as the new Graph version.

- Run history displayed 24 decisions, initially 20; **Show more records** displayed all 24.
- Searching `rework` reduced that run to one matching decision. Expanded evidence showed the candidate IDs and versions.
- Company history displayed 17 records including product decisions, organization changes and configuration changes. Searching the exact product-baseline rationale reduced it to one record.
- At a 390 × 844 viewport, the plugin content measured 350 pixels wide and the page 382 pixels, with no horizontal overflow. Viewport override was reset after checking.
- Browser warning/error logs were empty.

Screenshots saved locally: `.e2e/graph-audit-desktop-v0.3.0.png` and `.e2e/graph-audit-mobile-v0.3.0.png`.

The Pack `0.1.5` run `fe0ae91a-685b-44e1-9530-4932261c32f0` subsequently produced a browser-verified work choice at `qc-b4`. Searching its exact question returned one record, `6619d7c7-d0e9-47f4-a94a-05654fabe460`. The expanded record showed the actor's host execution identity, attempt 1, Pack `0.1.5`, Graph `0.1.1`, `node:qc-b4` rule reference and active product Decision ID. Screenshot: `.e2e/work-choice-v0.3.0.png`. This check exposed a missing denormalized feature label; the source fix inherits it from the run for new decisions and retains historical records.

After the final scope/checkout correction, the owner clicked **Dispatch ready work** in Design run `d8f8d871-b86e-4d8c-bf3d-145081a2ef05`. Searching the submitted reason returned exactly one new `paperclip_dispatch_recovery` Decision, `733035f3-bc78-462d-bdc9-5ad605eda247`. The browser displayed its human actor, reason, feature `acceptance-feature-71eec5ce`, Pack `0.1.6` and Graph `0.1.2`. Existing attempts remained intact. Screenshot: `.e2e/dispatch-recovery-v0.3.0.png`.

The final conflict form was checked against a real waiting conflict `7dc703c1-790a-40d9-b0af-a9ffc709fde3` in run `16723d28-9cce-4c82-b2da-892177fb3077`. It displayed separately signed CPO/CTO positions, all five comparison dimensions, required constraints, unresolved risk and negotiation evidence. Its actual `proceed`, `replan` and `stop` options showed the correct effects: resume normal gate checks, restart Implementation Plan and invalidate downstream evidence, or stop the Graph. **Attach conflict dossier** inserted the exact escalation Decision `da9a90b8-1dd7-4b60-9be0-26fc9655b1b3`. The browser only inspected the form; the authenticated fixture owner subsequently recorded stop Decision `cd7b7485-96a7-4c8f-9819-ae47b5ed5798`, leaving no ready/work items or new dispatches. Screenshots: `.e2e/conflict-dossier-v0.3.0.png` and `.e2e/conflict-dossier-full-v0.3.0.png`.

The stopped-run check exposed historical dispatches being shown as current Ready work. The final UI limits current work to running Graphs and displays an explicit stopped message. After the final Docker upgrade, browser reload confirmed that message, no Ready work or retry/dispatch action, and the retained historical issue/heartbeat in the expandable dispatch section. Screenshot: `.e2e/stopped-run-v0.3.0.png`.

## Completed deterministic matrix — Pack 0.1.5

Company `97f49e4e-0bb3-4780-9ded-4e5458bbc594` (`POLAAAAAAA`), root issue `3189c918-c23b-47ac-aba8-7a93a970bba1`, feature `acceptance-feature-71eec5ce`. The full runner exited 0. These are real Paperclip process executions with deterministic output, not model-produced business artifacts.

- A: major Design run `fe0ae91a-685b-44e1-9530-4932261c32f0` completed with eight distinct candidates, two finalists and 72 successful Paperclip heartbeats. Three failed dispatch attempts were preserved and recovered through owner retries.
- B: severe-review run `fa2edd4d-28b3-4514-a6c5-76e1678b93ad` retained five self-review rounds with an open P1, then received independent rework; attempt 2 was accepted. Eight successful host heartbeats support this case.
- Implementation `78646c41-58f9-463e-aa30-127c6362e6bf` completed with 41 successful heartbeats. Separate CPO/CTO position Decisions `6fad1117-2073-4e56-ac75-08c728289b31` / `769ca500-8901-4847-9514-504ecef892d7` led to human rework Decision `6c082f0a-d06a-4cf0-b068-663aca06d320`; the plan and gate advanced through three retained attempts. Final gate Decision: `ffcfae24-80c8-44d5-8b84-a7f5a09a9b7a`.
- Verification `38f19631-046b-4308-8030-8bd7119a8f57` completed with nine successful heartbeats and the specific accepted Implementation identity.
- Defect Implementation `2bbfdc43-6d5f-4e5f-9741-6cc805feeb61` completed with 38 successful heartbeats through root-cause investigation, failing reproduction, readiness and build.
- Product-memory runs `c2984deb-ce2b-420c-8894-d48a8374bb55` / `df11662a-c8cf-45c3-a7d5-415a24826cb0` verified proposal `34206892-6f8d-4c2b-9816-51c944df6b03`, approved successor `981eabaf-9e1f-4a41-9d36-15444d5d1cd1`, active context, retained history and rejected stale/unauthorized changes.
- Old pinned run `55bdaa2b-cd8e-4a4e-99a7-622757dd7b73` resumed and completed with Pack/Graph `0.1.0`. New run `1dc9a45c-0764-45d7-9cf3-fcd7222cabeb` received Pack `0.1.5`.
- Current organization alignment retained all 11 IDs and non-reporting profile hashes, with two Board roots and nine edges. Plan Decision: `0f653ca6-a13d-42bd-92d9-c9d97b8d01ce`.

### Failures retained during this matrix

- During A, concurrent dispatch calls requested the same issue's wakeup twice and overwrote its stored execution ID. Legal callbacks were rejected. Final source adds an atomic `issued → waking → woken` claim and retains uncertain wakeups for owner inspection instead of resending them. Persisted successful wakeups also skip repeated agent/memory reads. The observed cancellations occurred before reporting-line changes; those changes were not their cause.
- The first downstream start correctly rejected an incomplete `final_design_identity` in the test harness. The harness now passes the actual selected frozen artifact ID and version. A rejected malformed test input is retained as validation evidence, not counted as a successful handoff.
- Earlier Verification `a75a27d4-adbd-4ed0-9a15-cf49b67f87ba` reached Graph completion but heartbeat `130a973d-ac5d-4081-88d2-d356bf145a40` failed after a callback HTTP 502. It is excluded from passing evidence. The later Verification listed above requires every recorded heartbeat to succeed. Harness GETs and idempotent callback retries are bounded; unrelated failures are not ignored.

## Final deployment and source tests

- `node --test tests/core/*.test.mjs tests/e2e/*.test.mjs`: 44 passed, one opt-in Docker test skipped, zero failed. Independently rerun after the callback/scope and concurrent-request corrections. Docker acceptance is reported separately above.
- ADLC Pack `node --test`: 20 passed, zero failed.
- Both `3310` and `3311`: host health `ok`, installed plugin `0.3.0` status `ready`, current Pack `0.1.6` with seven Graphs. Final Graph GET requests returned HTTP 200. Quiet samples immediately before the UI-only restart were 546 ms on 3310 and 875 ms on 3311.
- Worker SHA-256 after migration 003 and the concurrency correction: `215bb33bf51e02f497baa25ab2fc8e6d7b95d863fcb482e18df0d8cd05a7d4d2`.
- Manifest SHA-256: `eb984b1592edfdfbb33340c053a87651d015bb36dc1460d26436b31199f3e613`.
- Final UI SHA-256 with owner dispatch recovery and terminal-state display correction: `27277e08da9031916d9647638bdcf64e098cbd0ff02b6a8c58a0ab6dd8aba220`.
- Pack entry SHA-256: `f595dcb91c2bff485747169ad894a4e126276b207e0e77b528658560bb4f369f`.

## Pack 0.1.6 focused regressions

The initial final-build run `d8f8d871-b86e-4d8c-bf3d-145081a2ef05` exposed another host interaction at 25/49 completed nodes: three unique child executions had started while their dispatches remained `waking` without a persisted host run ID. Their legitimate callbacks were rejected after the bounded wait. Host logs identified the cause: background setup timers invoked `issues.requestWakeup` without a valid invocation scope. Paperclip rejected those requests, then its own assigned-todo recovery independently started the child issues.

The final correction removes these background timers. Authenticated Graph commands and callbacks continue to dispatch next work. An owner can explicitly request recovery through **Dispatch ready work**, with a recorded actor and reason. A `waking` callback can bind its run ID only when its current attempt/phase, child issue and agent match the durable dispatch and Paperclip returns the exact checkout run and assignee. Database CAS preserves the first confirmed identity; a late identical wake response is idempotent and a different identity is rejected. New tests cover early and late callbacks, wrong identity/attempt/checkout, and states that must not be rebound.

Three affected nodes were recovered with authenticated owner retries into attempt 2. The run completed and explicitly selected the second finalist, `freeze-b1-frozen_visual_b1-attempt1@v1`. All 36 work-choice records carry the correct feature and run ID. Each of the 72 current-attempt child issues has exactly one successful heartbeat with exit code 0. Five prior-attempt child issues remain in history: three failed and two succeeded before their attempts were superseded by retry. Their outcomes are not substituted for current-attempt evidence. Final multiple/stale-selection negative probes also passed.

The first 12-request dispatch probe (`c85bcd8d-cea6-4043-bc40-1385b076590c`) exposed a separate scaling problem: each request rewrote the 11.19 MB company state document for its audit entry. CAS conflicts and repeated document transfers exceeded the host's fixed 30-second RPC lifetime, so late worker calls again lost their invocation scope. This failed probe remains in the checkpoint.

Migration `003_dispatch_requests.sql` now stores each authorized owner recovery request in a small append-only table, with company/run/actor/version context and an idempotency fingerprint. Exact legacy core idempotency keys still return their original records. The dashboard merges both record sources by ID. Each company shares an engine write queue; simultaneous owner requests for one run share the host dispatch operation while retaining separate audit entries. Host RPC timeouts and scope protections were not changed.

The migration was applied through the official plugin upgrade on both Docker instances. The new table and its unique/query indexes exist, both plugins report `0.3.0 ready`, and existing volumes, Graph history and the two real-host accounting holds are preserved.

The new minor run `16cf8ff3-bb17-4601-b8e8-0d76dbbebb3b` passed the 12-request regression: all 12 first POSTs returned HTTP 200 in 6.210–7.888 seconds, with no HTTP 502/503 or 30-second timeout. Twelve distinct audit entries were persisted in an 86 ms interval. The current child has one successful heartbeat with exit code 0 and the recorded execution identity matches it. The requests exercise already confirmed dispatch reuse; they are not claimed to force the initial wake-CAS window. Initial wake competition is covered by focused source tests and the resumed run's remaining host fan-out.

Implementation run `c043bc43-ba1e-48bd-b3ab-0e8c8d169937` completed after human continue Decision `93694bba-8df7-4fff-a585-56bbe451c7e6`. The subsequent gate acceptance references that exact conflict-resolution Decision. Its Design handoff contains only the explicitly selected frozen winner, retaining the alternatives in the upstream comparison records.

Implementation run `d1c59790-26b1-4584-9505-265e8d4c169a` stopped after human Decision `b23c29ef-79f3-4423-82c9-ee617291e9c9`: no ready/work items, no gate acceptance and no new dispatch after that decision. Its earlier successful gate dispatch remains in history. An initial harness assertion incorrectly required that historical dispatch list to be empty; it was corrected to test the absence of new dispatches without erasing history. The resumed focused runner exited 0 and saved `.e2e/acceptance-regressions-0.1.6.json`.

The concurrent minor run's child issue is `4f5bcea3-0b53-4d8b-a7fb-e7d0c8e298c3`, with one successful heartbeat `d6eb6a7e-968c-4f32-9c9a-d16ef00a90bb`. The final Design Decision is `def83245-d9c4-42c6-b2ed-ae26c1d0a11e`. These identities link the focused result to the actual host executions and unique-winner handoff.
