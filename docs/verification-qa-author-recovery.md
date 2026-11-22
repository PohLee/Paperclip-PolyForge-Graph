# QA author completion after a document creation race

On Paperclip Host `2026.1117.0`, a QA author’s self-review can commit the report and then dispatch its supervisor. If two dispatchers both read an absent issue document, the first can create it before the Host handles the second create-only upsert. The Host then requires a base revision. The previous Graph worker propagated this error to the author even when the already-pinned text matched. The supervisor could still accept the committed report.

Graph now handles both Host conflict messages by reading the document again through the same company, issue and key. Matching text lets dispatch continue. Conflicting text or an unrecoverable read fails the callback. The code never sends an update to the winning revision. The same protection applies to pinned research citations.

## Isolated Docker experiment

The regression used Paperclip process agents, a real PostgreSQL store and the `verification@0.1.7` graph from ADLC `0.3.11`. For the controlled comparison on port 3332, a test-only scheduler let the security and regression branches settle before the QA self-review. After Graph had read an absent supervisor `GOAL.md`, a second authenticated client created the exact run-pinned body through the Host API. The normal worker then issued its original upsert. The test collected the document revision, native author and reviewer heartbeat states, report version, approval decision and acceptance-matrix citation.

The process fixture supplies synthetic QA evidence. This experiment validates dispatch, report retention and traceability.

| Controlled run | Graph run | QA author heartbeat | Supervisor | Winning document revision |
| --- | --- | --- | --- | --- |
| Old worker, QAD-2 | `8a2d4a85-124e-4954-add6-f1aab02e3852` | `4f7d2967-4f22-4b43-be92-f5fd4ac12ba1` failed with the missing-base-revision error | Accepted | `ac20e912-fbdc-4a6f-ade2-3bf5a3158009` |
| Fixed worker, QAD-14 | `a2cb53ef-0a55-4094-af31-e578e6bbe258` | `303b7085-569f-4302-9768-0f390db58372` succeeded | Accepted | `3b5e4e36-2458-4dbe-b4de-c372a3b8fb70` |

Both graphs reached the final acceptance gate. Both still cited their QA report and source receipt in the matrix. On the fixed run the later create attempt did not add a revision or change the first writer’s document. The default Graph suite passed 761 cases with 14 opt-in tests skipped. The Docker exercises above ran separately.

The release build then completed a third isolated run with the production worker and the original process fixture. QAD-26 used run `fb4da6fd-1715-4a40-8447-9856af0f7924`. QA issue QAD-30 finished as `done` and heartbeat `ba4767f3-31ce-467d-8939-31d4b69badac` printed its completion marker and exited with code 0. The tested worker SHA-256 is `754451be1165e32b79f454b9b3161bb26e6fba057dbf261633fe45c7fc34ca93`. The ADLC catalog retained SHA-256 `19485176107d13cb4497391c65dfb12f4f2315bde4b6c0f125cc307f1e158218`.

## Deployment on 2026-11-22

The worker was hot-loaded on port 3310 after checking the backup, both company preflights and the container’s mounted file hashes. The instance kept its original Paperclip and PostgreSQL containers and named data volumes. Readback confirmed both companies, all 26 prior agents, their reporting and role bindings, the existing project, 27 prior issues and two prior Graph runs. The isolated Docker stack on port 3332 was returned to its initial stopped state.

The new check used the original implementation candidate `3310-smoke-candidate@A` in the same project. The QA author on POLA-32 printed its completion marker, exited 0 and finished the issue as `done`. Its heartbeat was `6bb4cec0-ceb4-4a63-a61c-387c77cb7eb0`. The supervisor accepted the report in decision `173b8f06-d5d9-4a64-baa6-0c3caa040eff` and the final gate accepted. The matrix cites QA attempt 1, its exact report version `v1` and its execution receipt. [POLA-28 Graph run](http://localhost:3310/POLA/graph-runs?runId=7a74904e-d6c1-40a8-90e8-2d53d729cfd9)

The original A report retained decision `f793340b-10ab-48f2-9122-a1cc3ea158c2` and its historical failed author heartbeat. Before-and-after comparisons matched the original A and B report artifacts, receipt references, author and supervisor identities, decisions, full QA attempt histories and acceptance matrices. [Original A run](http://localhost:3310/POLA/graph-runs?runId=113a99d1-1fa6-4272-957d-516de8d2607f) · [Original B run](http://localhost:3310/POLA/graph-runs?runId=3ebf6459-926d-433b-9ae1-079d1aff3fd0)

## Native Runner beta recheck on 2026-11-22

**Passed on port 3334.** ADL-26 ran ADLC `0.3.11` and `verification@0.1.7` on Paperclip Host `2026.1117.0`. The QA author and the CTO/CAIO supervisor each used `paperclip_runner` with the native `codex_app_server` driver. This run used a fresh candidate checkout and a separate Docker PostgreSQL instance. [Open ADL-26 in Graph runs](http://localhost:3334/ADL/graph-runs?runId=7c2ed147-3303-495e-ba63-3a1a93269e50)

| Acceptance check | Observed result |
| --- | --- |
| Two clients create the same supervisor `GOAL.md` | After Graph read the key as absent, an independent authenticated client created it through the Host API. Graph's pending create received the real `baseRevisionId` error during the QA author's tool call (events 162–166). The Host revision history contains exactly one revision, `bd9a01c7-3622-4c17-8038-e3a15201beb0`, with the first writer's original body digest. |
| QA finishes its own checkout | QA attempt 1 produced `qa_report@ef72afdd2d98df83209cd310e5312df1d872848e`. The same heartbeat completed `paperclip_finish` at event 175, reached `succeeded`, and closed ADL-34 as `done`. |
| A separate supervisor accepts the report | The CTO/CAIO independently checked the pinned candidate and recorded `accept` in decision `2cd9cef2-b95b-488a-a612-9dd3284761e8`. The supervisor completed `paperclip_finish` at event 240. |
| Graph runs leads back to the original command receipt | In a signed-in browser, opening **QA → Attempt 1** showed the exact report version and author heartbeat. Searching **Decision history** for the supervisor decision and expanding its evidence showed the relative receipt path and SHA-256. Hashing the 155 original bytes from the candidate checkout reproduced `bba30c38a27cc9f37c68d3e222d3780db9987c483d9cd96b780917cd8923e545`. |

The isolated worker added a scheduling barrier and conflict logging to the release build so that the competing create landed in the QA callback. Paperclip supplied the document response, revisions, terminal events and review decision. The review instructions asked the supervisor to cite the checked receipt. The first freeze-supervisor launch failed workspace validation before QA started. Giving the new parent workspace a Git HEAD allowed that same task to resume. The evidence file includes both worker hashes, the original receipt text with its line endings, and the values observed in the browser. [Native acceptance evidence](evidence/verification-qa-native-finish-2026-11-22.json)

The matrix author received a read-only copy of the three accepted report outputs. The accepted matrix cited the same QA attempt, artifact version, observation, locator and receipt digest. Its review decision was `6b7e669f-6d50-424f-84b6-4066784d7236`. The operator paused the test run at the pending human gate, restored the five test agents and reloaded the release worker on port 3334. A second browser check at 10:40 MYT reproduced the receipt lookup after the reload.
