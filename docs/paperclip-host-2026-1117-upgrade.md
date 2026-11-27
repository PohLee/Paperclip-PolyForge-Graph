# Paperclip Host upgrade for localhost:3310

The target is the official Paperclip Host `2026.1117.0` image, pinned to manifest digest `sha256:bdf38d10544dc6c831e16dc027f23ad586353ef3be1a1b2c6979e63b956aceb1`. The previous Host used `2026.1106.0`. The plugin SDK and declared minimum Host version retain their existing compatibility baseline.

## Work packages

Three GPT-6.2 Sol agents with high reasoning owned Host configuration and upstream regression tests, dispatch compatibility, and isolated rehearsal respectively. The deployment lead reviewed the changes and verified the live instance independently.

| Owner | Work | Acceptance |
| --- | --- | --- |
| Host configuration | Pin the release across Compose and both Host test drivers. | Verify the registry digest, resolved Compose images and version assertions. |
| PolyForge dispatch | Describe independent child workspaces and native status reporting in the dispatched instructions. | A native agent submits Graph evidence before reporting its Paperclip outcome. An existing dispatch remains reconcilable after upgrade. |
| Isolated rehearsal | Start the target image against separate data and exercise plugin paths. | Record actual Host behavior and distinguish process fixtures from native Runner coverage. |
| Deployment lead | Back up the existing data, review changes and bring up the target on port 3310. | Verify the running Host, plugin, companies, enabled Packs and agent reporting tree. |

## Baseline and recovery

The original Compose containers were absent at the start. Both named volumes existed. The existing PostgreSQL 16.10 volume contained two companies, 78 company skills, four skill versions and 83 plugin-managed resources. PolyForge ADLC had 25 idle agents and one terminated historical agent. No heartbeat was queued or running at the baseline query.

The database archive is `.e2e/local-deploy-3310-before-host1117.dump`. The pre-upgrade Paperclip filesystem archive is `.e2e/host-1117-rollback/paperclip-data.tgz`. These local files contain private instance data. A rollback following skill-package conversion requires the matching database and Paperclip storage. Restore both to separate volumes and verify the old Host there before switching traffic. See the [upstream upgrade guide](https://github.com/paperclipai/paperclip/releases/tag/v2026.1117.0#upgrade-guide).

## Deployment and review

The database dump was restored into an isolated PostgreSQL instance. The rehearsal matched the original companies, skill and agent records, reporting links, Graph configuration and Graph document business fields. The new Host applied its migrations and the plugin applied migration 019. A scheduled Product Decision reconciliation tried to look up members even when no proposals were pending. The fix skips the lookup in that case. The rebuilt plugin passed an explicit reconciliation job on the clone. A global scheduler invocation lacks company authority for certain member or interaction operations. Pending proposals also reconcile through authenticated company or issue requests. The successful empty-queue check covers the state present in the two companies during deployment.

Compose recreated the project network and started the 3310 service with the pinned image. PostgreSQL and the Paperclip filesystem use the two original named volumes. The upgrade used the existing administrator login and plugin installation. Authenticated health returned `2026.1117.0` at `c0f132898d2a2677312d8c72096187b27a3d9a38`, the plugin returned `0.8.10 ready`, and the original database reported 450 Host migration entries. The mounted worker SHA-256 matched the rehearsed worker, `364b078399c27b217d3dc94af9ad342997b9cb400c58fe42927d3412dab33b65`.

Pre- and post-upgrade database checks matched the company IDs, agent IDs and reporting links, skill IDs, activation and organization settings, and run data. PolyForge Local has one visible agent. PolyForge ADLC has 25 visible agents with ADLC and Creative Team both enabled at 0.3.3. Paperclip's native organization API returned one CEO root and all 24 expected manager links, including Head of Design reporting to the CPO. The native SVG endpoint returned HTTP 200.

The full default Node run passed 609 tests, skipped 14 opt-in tests and had zero failures. A separate PostgreSQL selection using the target image passed 157 tests, including the opt-in database cases. The two selections overlap. Host pin tests validate the image digest across all three Compose configurations. The default compatibility check also covers pending plugin issue creation recorded before the dispatch prompt changed.

The live Graph state for both companies matched the restored pre-upgrade dump across every document field except the advancing revision counter. The native organization and SVG checks ran on port 3310. The following functional tests ran separately from the shared instance.

- **Child checkout.** Two real Process heartbeats in the official image realized separate parent and child worktrees. The child saw neither the parent's tracked edit nor its untracked file. It fetched the exact published commit from a local Git remote. The parent retained both edits. Dispatch retains `inheritExecutionWorkspaceFromIssueId` to carry the project and strategy.
- **Native task status.** The tagged upstream native task mutation suite passed 19 focused cases, including refusal of a direct status change while a native run owns its task. Graph dispatch instructions now describe how the Runner submits Graph evidence before calling `paperclip_finish` or reports a blocker through `paperclip_block`.
- **Runner tool behavior.** The tagged Codex semantic-results and completion-result suites passed all 52 cases with a fixture harness, including accepted finish results and deduplication of a block report. This run used no external model account.
- **Usage receipt and budget.** On the released upstream source and a disposable PostgreSQL 16.10 instance, all 58 closed-native-receipt accounting tests and all seven independent-admission tests passed. These cases exercise settlement after provider closure, handling of incomplete cost evidence, and the admission rules for other work. The database-backed run exited successfully.
- **Workflow acceptance.** All five workflows completed on a fresh official Host using synthetic Process agents. The suite covered Creative brand foundation, standalone and composed ADLC system architecture, ADLC code delivery and Marketing acquisition readiness. All three expected child outputs were linked. Six attempts by an incorrect agent were refused and left the protected state intact. The archive SHA-256 was `b3a260feae4b0d99f0456cafc1b07035555dc7c3caa2119f649c4d5b8b5861ae`. Local evidence is in `.e2e/host1117-rehearsal/workflow-composition-evidence.json` and `.e2e/host1117-rehearsal/clone-final-summary.json`.
- **Background dispatch.** In active Graphs, the global scheduled retry also attempted company-scoped Host calls such as `agents.get` and `issues.get`. The Host denied those calls. The company- and issue-scoped paths continued dispatching. The existing retry remains installed. Unattended progress that relies exclusively on this global job has a known limitation. See the [tagged scheduler](https://github.com/paperclipai/paperclip/blob/v2026.1117.0/server/src/services/plugin-job-scheduler.ts#L85).
