# ADLC model seats and confirmations

## Approval manifests

Set `adlcProjects[projectId].ownerId` in the company plugin configuration to the Paperclip user ID. A configured project uses confirmation for the `requirements-gate` in `requirements-baseline@0.1.2`. Other gates opt in through `confirmationGates[decisionType]`. Set `documentKey`, `acceptOutcome` and `rejectOutcome` there when the defaults differ from the gate's outcomes. The defaults target `approval-manifest`, map acceptance to `accept`, and map rejection to `hold` if present or `rework` otherwise.

The plugin requests a `human_only` confirmation against the latest issue document revision and rechecks the revision and owner membership before recording a decision. The interaction ID serves as the decision idempotency key. A replacement revision gets a fresh confirmation. For G2, the reviewed Pack artifact must reference the same document ID and revision before Core creates the confirmation. Approval requires the candidate to remain current. A rejection can still be applied when the candidate no longer matches. The existing Core human gate is available for projects and decisions without confirmation configuration.

## Model seats

A project can configure `seatGroups[graphId]` as a list of groups keyed by node ID. Put arena candidate A, candidate B and judge in one group. Use named declarations for Goldfish and Council nodes when the Graph exposes them as dispatchable nodes. The pinned Graph's seat declaration sets its name, vendor constraints, minimum seats and unavailable policy. The dispatch resolver calls the installed Pack's constraint checker. A declared seat requires a matching project group. A configured group blocks if the installed Pack lacks these helpers.

`adlcProfiles[profileName]` supplies company defaults. `adlcProjects[projectId].profiles[profileName]` supplies project profiles. `seats[nodeId]` can select a profile by name or contain a `profile` name and node overrides. An owner-started run can set `input.seatOverrides[nodeId]`. The dispatcher applies these layers in increasing priority above the Paperclip Agent's settings.

A harness and its fallbacks choose among Agents bound to the node's role. Model and reasoning overrides go in the new issue's adapter configuration. Set `effortFields[adapterType]` for the deployed adapters. The default fields `claude_local.effort`, `codex_local.modelReasoningEffort` and `opencode_local.variant` are unverified. Use `modelVendors` to identify the provider for routed models and `adapterVendors` for adapters with a single provider. A vendor-constrained seat with unknown provider blocks.

The dispatch record captures requested configuration and fallback reason. Runtime completion events add the harness and model when reported. Missing runtime values are recorded as `unverified`. The dispatcher tries only ordered infrastructure fallbacks, rechecking the Pack constraints against other bound seats. A wait uses the first recorded unavailability for the current attempt and resume count as its start time. Set `waitDeadlineMs` for a wait policy. Reconciliation pauses the run for an owner once that deadline elapses.

Automatic runtime retry requires both a current dispatch receipt and a node explicitly listed under `sideEffectFreeNodes[graphId]`. The plugin checks the existing Paperclip issue before retry. For effectful nodes, retry remains held for operator reconciliation because the worker has no trusted head-specific PR or merge absence lookup. Live verification of Paperclip event fields and task-level adapter overrides is pending.

## Merge automation modes

Projects select `manual`, `assisted` or `full-auto` with `automationMode`. Core defaults to manual. A request for full-auto without `allowFullAuto: true` resolves to manual and emits `automation.mode_downgraded` for the run and decision. Merge receipts record the effective mode. The trusted Host executes authorized design, technical, and G5 merges. The G2 GitHub App verifies product proposals and observes merges performed by a human or GitHub auto-merge.

## Automation baselines

`engine.getAutomationMetrics({ projectId, from, to })` reports a half-open time window. The company overview displays the last 30 days for projects with Graph Runs.

- Gate wait time averages the elapsed time between a decision attempt becoming ready and its recorded decision. Samples enter the window at decision time. Historical attempts without a readiness event are omitted.
- Rework rate counts gate-triggered stage reworks and supervisor rework requests divided by those events plus node completions. The report also groups counts by graph and node.
- First CI pass rate counts passes among the first recorded terminal CI results for distinct repository and PR pairs. The trusted Host calls `recordCIResult({ runId, repository, pullNumber, headSha, executionId, result, actor })` for each observed CI execution.
- Auto-merge revert rate counts agent-approved implementation merges in the window with a recorded revert before its end, divided by all agent-approved implementation merges in the window. The trusted Host calls `recordRevert({ runId, mergeCommitSha, revertSha, actor })` after observing the revert.

Rates with no observations return a null value and include their sample counts. CI and revert baselines depend on the Host reporting those observations.
