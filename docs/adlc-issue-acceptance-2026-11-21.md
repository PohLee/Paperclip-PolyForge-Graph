# ADLC delivery progress and supervisor review acceptance

This record covers the Graph and ADLC changes for [Graph #1](https://github.com/PohLee/Paperclip-PolyForge-Graph/issues/1), [Pack #1](https://github.com/PohLee/Paperclip-PolyForge-Graph-Packs/issues/1), [Graph #2](https://github.com/PohLee/Paperclip-PolyForge-Graph/issues/2) and [Pack #2](https://github.com/PohLee/Paperclip-PolyForge-Graph-Packs/issues/2).

## Clock and Pack regression

The original reproduction reached 1,805,220 cumulative active milliseconds after a completed intake and a requirements run on the same Paperclip issue. The default idle allowance is 1,800,000 milliseconds. Recorded progress now includes a supervisor's acceptance of the versioned intake, published requirements handoff and architecture baseline. Both architecture entry points record baseline review; the architecture approval gate remains a separate decision.

The controlled-clock regression uses the ADLC Pack, actual Graph transitions and one root issue. A supervisor returns the first intake attempt for rework; the delivery records zero milestones. At 672,000 milliseconds the supervisor accepts the revised artifact pair; the delivery records one milestone. At 1,805,220 cumulative milliseconds the requirements run is still running. A duplicate submission of the same version is rejected. At exactly 30 minutes since the accepted versions, the run stops with `idle_progress_limit`. Run `node --test tests/core/adlc-delivery-milestones.test.mjs` to repeat this check.

## Supervisor acceptance criteria

The assisted ADLC review rule requires `artifact_version`, `review_findings` and `self_review_history`. Each must reference every current candidate by artifact ID and version. The supervisor receives the pinned rule, current subject references and a reference to the self-review occurrence. Initial findings remain independent of the author's self-assessment. The shared review guide is assigned to CPO, Product Manager, CTO/CAIO and Principal Engineer.

The native cases must identify the root issue, Graph run, reviewed node, submitting Runner and independent reviewing Runner, both candidate versions and the first review submission for each supervisor. An accepted Graph decision on its own does not establish which attempt first succeeded. The timed regression above is reported separately from Docker wall-clock measurements.

## Candidate and regression suites

| Component | Verified result |
| --- | --- |
| ADLC 0.3.8 | The release payload digest is `sha256:12b7e01bc446941e658834f565d6c24b19226cd1a4638ffcd93e0f9af1c697e9`. The Host catalog snapshot identifies the complete Pack as `sha256:9759195e3993c4138e9ea3ce0327bc8af7c013ab28fce54d1a28e6460adda38e`. |
| Pack suites | 135 passed. Checks cover both architecture entry points, requirements hold, the triage review boundary and two subject references for every evidence item in the shared guide. |
| Graph suites | 733 passed, 14 skipped on the compact supervisor issue build. The scoped supervisor route excludes unrelated parallel work. Recovery tests check the earlier supervisor issue descriptions with and without the native Runner instructions. |
| Deployed Core replay | An in-memory replay inside the isolated `3326` container loaded the mounted Core bundle and Pack snapshot. One invalid supervisor submission returned both missing evidence kinds and both missing candidate bindings. The same test exercised rework, duplicate versions, cross-stage progress and true idle expiry with a controlled clock. |

## Native environment and first trial

The acceptance project uses a dedicated company (`ef03f20d-cb55-4d39-8e41-d9c8de8f646a`) on localhost:3326. The continuity root is ADLA-6 (`23dc12bb-4323-489c-8e61-886b97664daa`). ADLA-7 exercises Product Manager discovery separately. Both runs use assisted mode and the native Codex Paperclip Runner. Earlier manual-mode setup attempts were retired. The isolated project received a Git workspace, and an idle restart of the isolated Host recovered a native session initialization failure. Task-specific author guidance supplied input schema and synthetic source facts to the producers.

In the [first assisted triage](http://localhost:3326/ADLA/graph-runs?runId=6e570456-7e47-40f7-b8b8-1a0d04820bc6), CPO heartbeat `a5d0f474-8340-40e6-bac1-648a6e316ae6` eventually accepted the report and brief. The milestone was recorded at 15:51:55 UTC. The owner observed 30 idle minutes remaining after the review. The first attempted review had an invalid outcome, and a later request omitted the reason. This trial passes the intake milestone check and fails first-submission acceptance. It prompted a change to the supervisor issue description.

A second CPO on ADLA-21 used the compact form, tried an unsupported `inspect` operation, then submitted a successful `review`. A parallel requirements supervisor tried `status` before reviewing. The final dispatch explicitly tells supervisors to use the scoped GET for reads and submit one `review` write. The final mounted worker SHA-256 was `98928019cba94c52caca3b0139d39e92ad4d0c5371f43475c4bb77655401aba5`.

## Four issue results

Times below are UTC on November 21. All links open the isolated Host.

| Issue | Result | Evidence |
| --- | --- | --- |
| Graph #1 · same-issue clock | Passed | The [completed intake](http://localhost:3326/ADLA/graph-runs?runId=6e570456-7e47-40f7-b8b8-1a0d04820bc6) and [requirements](http://localhost:3326/ADLA/graph-runs?runId=ffa52b92-1abd-48e2-a1ca-9daaed8d4851) share the same company, project, issue and delivery key. At 16:09:38.623 the combined active time was **1,824,049 ms**. Requirements was running with **14 idle minutes remaining**, above the historical cutoff of 1,800,000 ms. A second read confirmed the same outcome at 1,845,281 ms. |
| Pack #1 · accepted milestones | Passed | The native CPO accepted `ADLA-6-TRIAGE@v5` and `ADLA-6-REQUEST-BRIEF@v5`. The requirements run inherited this single milestone. Reviewed requirements publication, the held requirements path and both architecture entry points also passed their Pack tests. |
| Graph #2 · actionable review dispatch | Passed for both target nodes | The [final CPO triage](http://localhost:3326/ADLA/graph-runs?runId=7e76fb85-24d9-4fe0-85d6-a9d87caff722) and [Product Manager external research](http://localhost:3326/ADLA/graph-runs?runId=04c37283-d1c5-454c-bd09-0d163ad3f2b3) each persisted a decision with the first submitted `review`. The Docker negative control reports all missing kinds and candidate bindings together, and the Core suite covers wrong versions and self-review occurrences. |
| Pack #2 · supervisor evidence guidance | Passed | Both named native reviewers bound each of the three required evidence kinds to both current candidates and cited the self-review occurrence. Coverage tests check the role guides for all four assisted supervisors. |

### Native review receipts

| Supervisor | Graph child and heartbeat | Durable decision and evidence |
| --- | --- | --- |
| CPO, `assess-request` | Child `ecf33e86-977d-4610-a433-880f0cd502c3`, heartbeat `163feda4-ab3d-4335-bd02-52f434a3b021` | `fd14ee37-d361-407a-8f4f-fb3acbf1588c`, outcome `accept`. One Graph command at sequence 236. Each evidence item covers `ADLA-34-TRIAGE@v1` and `ADLA-34-REQUEST-BRIEF@v1`. Self-review cites attempt 1, round 1. Native heartbeat succeeded. |
| Product Manager, `external-research` | Child `abf3b361-685c-4342-8426-8b83b972253d`, heartbeat `281d046e-29a7-4462-93d8-f1c97016ebc4` | `c7723caf-9495-4bfb-a8df-087615db0ed0`, outcome `accept` at 16:07:51.307. The reviewed pair was `user-research-e4087b78-v1@v1` and `external-evidence-e4087b78-v1@v1`. Self-review cites attempt 2, round 1. The native finish event completed at 16:08:09.821 and heartbeat finalization succeeded at 16:08:17.366. |

Public receipts alone left one Product Manager tool call unclassified. A read-only audit of the native tool-operation records identified three `workflow-run / inspect` probes followed by the sole `graph-command / review` at sequence 357. CPO likewise sent exactly one Graph command. Both reviews passed on their first submission.

The PM's prerequisite discovery plan was submitted by a native Product Owner. The isolated test owner accepted that prerequisite via decision `567131ca-8b99-4e10-bd61-2eb38cfc5534` after its earlier supervisor exited without a disposition. A native external analyst then produced the two reviewed artifacts (heartbeat `83a8e2de-083c-4d50-af7d-cbc77a01a024`). The PM made its own independent disposition.

The full `product-discovery` run stopped at 16:08:11.996 with `idle_progress_limit`, decision `7f0f6925-94ab-4ceb-8b2b-cc8d1618e5ff`. Its accepted external-research node and evidence are retained. Discovery had no declared progress milestone in 0.3.8. The [Discovery beta acceptance record](product-discovery-beta-acceptance.md) tracks the 0.3.9 follow-up.

The local sanitized proof is in `.e2e/adlc-038/public-review-proof.json` and the clock samples are in `.e2e/adlc-038/live/continuity-evidence.ndjson`. A diagnostic search during the session displayed the isolated fixture's database connection string in local tool output. The shared acceptance records omit it. The fixture database port is internal to its Compose network.

After the live clock check, both requirements drafting and challenge completed. At the human approval gate the two stages had consumed 2,025,660 cumulative active milliseconds. The test owner paused the run at 16:13:01.569 to preserve it for inspection. Requirements publication remains pending. Cleanup restored eight producer instruction files, the test owner's role and default mode, blocked unpriced usage, zeroed the temporary budgets and paused all six isolated agents. No test heartbeat remained active. The original service on port 3310 passed its health check. The combined final record is `.e2e/adlc-038/live/final-evidence.json`.
