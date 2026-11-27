# Verification report lineage

The original failure let candidate B submit the same QA report ID and version previously used for candidate A by changing the candidate named in the submission. The verification graph then lacked a durable check tying the report and its proof to the candidate that was actually verified.

ADLC `0.3.11` publishes `verification@0.1.7` and requires the Core capability `verification-report-lineage`. The older graph remains pinned for existing runs. The new QA, security and regression nodes check the exact implementation candidate and require fresh report identities. Reusing an earlier candidate’s recorded proof under a new report ID is also rejected within the project.

Each report observation carries an immutable execution receipt in `receiptRef: {id, version}`. A fresh check may publish at the same display URL as an earlier check. The recorded receipt identifies which execution produced the result. The acceptance matrix binds to all three currently accepted reports. Each observation cites the exact run, node, attempt, artifact ID and version and matches the source report’s receipt, proof kind, locator and observed result. The final gate binds its decision evidence to the frozen candidate, all three reports and the matrix. An unverified criterion still requires the existing human exception procedure.

## Isolated exercise

The canonical test uses the official Paperclip Host on port 3334 and two Git commits in one isolated project. Candidate A is `bff81250c3e48b85401d4fef7a3f3d5f07887b35`. Candidate B is `5dcb5aa822c22dd1a289ee9b070eb50beef79425`. The Pack release digest is `sha256:60ef7aaa70d0a1cfdd9a67a219e9ae9a21944c230d8b12701f0c0d4b8518301b`. The test deliberately submits A's report on B before collecting B's evidence. To repeat it, keep the frozen candidate identities separate and retain the native callback, its rejection reason, the original QA report, the new QA observation, the acceptance matrix and the gate decision.

The distinguishing behavior is observable with one input. Candidate A accepts negative zero. Candidate B rejects it while still accepting positive zero. Each fixture has its own requirement, executable check and pinned checkout.

An earlier rehearsal on port 3326 used a candidate with identical graph definitions and earlier verification instructions. Paperclip rejected the required QA pre-review because a plugin session with only a prompt has no runnable task on Host `2026.1117.0`. The Runner transport now gives that pre-review its own plugin-owned standard issue and separate execution. It pins the candidate snapshot, checks the assigned QA agent and validates the structured native terminal reply. The preliminary failure stays on its original run.

### Acceptance procedure

1. Start both runs in the same project. Wait for A’s QA supervisor to accept its report and retain its artifact identity, candidate reference and execution receipt.
2. From B’s assigned QA issue, try A’s unchanged report, then a new report naming A, then a new report naming B but carrying A’s receipt. Check the callback result and B’s node after each submission. A rejection must leave B’s report slot open.
3. Run the same signed-zero probe on B’s pinned checkout. Submit the new observation and receipt through the same QA issue, obtain supervisor acceptance, and reconcile B’s QA, security and regression reports against its acceptance matrix.
4. At the final gate, check that A’s evidence cannot approve B. Use B’s frozen candidate, accepted reports and matrix for the authorized decision. Retain both Graph run IDs so reviewers can compare the accepted reports.

### Candidate A

[ADL-1 in Graph runs](http://localhost:3334/ADL/graph-runs?runId=fb1d45de-1772-4e28-a0ca-dad31c96b928) completed with assisted-mode owner decision `1870bb52-6f6b-4326-af9c-dfbbced9ef74`. The QA Runner produced `qa_report@bff81250c3e48b85401d4fef7a3f3d5f07887b35` after observing that both negative and positive zero were accepted. Its receipt was `paperclip://heartbeat/1c6c2093-c479-4358-9bca-d5bf0da36ee5/qa` at `sha256:e5e34edf3b6648a214d55064487315b2d2009a57cba8f79edf1529febcfac44c`. A different supervisor accepted it in native execution `590021d1-99f4-4748-8af1-aa6751dc581c`. The independent pre-QA Shadow also returned an accepted structured review through its own standard issue.

### Candidate B

[ADL-2 in Graph runs](http://localhost:3334/ADL/graph-runs?runId=be5fe167-47f5-494c-832b-acdbba47e03c) used the same project and QA role. QA execution `6d6cf4b3-9d48-40dc-9137-05d80a591dc3` submitted each negative control from its assigned issue.

| Submission on B | Graph result |
| --- | --- |
| A’s accepted artifact ID and version | Rejected because the artifact identity and version had already been submitted. |
| A new version that still declared A as its candidate | Rejected because the evidence did not bind to the current candidate. |
| A new version declaring B but carrying A’s command receipt | Rejected because the receipt was already recorded for a different candidate. |
| B’s version, B’s candidate reference and a fresh command receipt | Accepted by QA’s supervisor. The check ran at B’s full Git SHA, rejected negative zero and accepted positive zero. |

The two preserved command logs hash to different values. B’s QA log SHA-256 is `52e78c913217b7648781aa708cbd2068f6f2c1e5e4f8c723876078cdb1378519`. The sign-of-zero result distinguishes the revisions even if their report names match. The Host transported all three rejected commands over HTTP 200. The native execution transcript records their three distinct Graph errors at response 222 item 1 and response 230 items 1 and 2.

B’s QA review completed in native execution `e2cd858e-5b92-4924-9e55-dae6470b8aed` with decision `12430c73-d39e-4260-ac05-0db54941d899`. Both matrices passed two criteria with four evidence entries each. An independent readback matched all eight entries to their recorded report attempt, source observation and receipt. The six original QA, security and regression command logs matched their report hashes.

On worker `e04fcd8a9efec509e6be0ff508d4f4fedb9eaa45fff432d2bd114c9ffa58f732`, the owner supplied A’s QA version at B’s gate. Graph returned HTTP 400 and named the required B version. The owner then used B’s frozen candidate, QA, security and regression reports, and acceptance matrix. B completed with decision `d1fa5341-7269-4d0e-bf89-d9cf446816dd`. Both runs used real native authors and independent native supervisors. The final gate was deliberately run in assisted mode using the isolated owner account.

### Recovery and evidence retention

The final worker on port 3334 is `527b0824027b3e232709ae39c17a75f4e5ebff013a6a1e2b1f343fb2390ed03f`. An optional owner-requested review exposed a background job without Host issue-read scope. Replaying the identical owner request on this build reconciled the existing terminal receipt after the parent had completed and the policy had been disabled. The optional review closed as cancelled. Its underlying Runner issue remained done, and its original execution remained succeeded. Both required pre-QA reviews had already closed as accepted. Database readback found the same 25 issue IDs and 25 execution IDs before and after replay, no active executions, unchanged A/B run digests, and all five fixture roles paused.

The [sanitized machine-readable evidence](evidence/verification-lineage-2026-11-22.json) includes the submitted negative controls, direct error responses, report and execution identities, gate decisions, worker hashes and cleanup readback. The six entries under `commandReceipts` retain the original command output. Hash the UTF-8 text of each `content` field to validate its receipt. The archived JSON’s SHA-256 is `23e66894cc53c0977cb71fd6d596d359e551fa19f68eae1dd57e3c085174e362`. This isolated exercise did not deploy to port 3310.

## Regression on 2026-11-22

- Graph ran `npm test -- --test-concurrency=4` with real PostgreSQL enabled. Of 771 cases, 770 passed, including all 13 PostgreSQL integration cases. The remaining opt-in case used its own Docker Host. The first run at default concurrency hit the Creative gateway fixture’s one-second local HTTP timeout. That case passed in isolation and in the full four-worker rerun.
- The Packs repository ran `npm test` on the canonical ADLC release candidate. All 137 cases passed with zero skips.
- The separate process-agent Docker test first passed on worker `e04fcd8a…` in 950.7 seconds. It completed triage, implementation with rework, and verification. An authenticated owner requested a second QA attempt, and the rebuilt acceptance matrix and both QA attempts survived a Host restart. An earlier run had hit an expired Host SDK scope during child issue creation. The fixture now serializes its synthetic company’s assignments. The PostgreSQL suite separately exercises concurrent dispatch claims.
- The same Docker test passed again after the native A/B exercise, using the final `527b0824…` worker and the same Pack catalog as port 3334. It ran in a new synthetic company on port 3332 in 891.2 seconds, with one pass and zero skips. The autonomous verification run was `25bc9b11-9835-4cc0-b301-d54cd01067fd`. The authenticated human run was `75f88c7c-6c0e-41cf-abd8-1c4c6b539197`. The assisted QA retry run was `1510d5b4-5e6d-4930-a0ae-0d959fd40e74`. The harness restarted Paperclip and verified both QA attempts and the owner's retry decision on readback. Across the full Graph suite and its separate opt-in run, all 771 Graph cases passed.
- After the restart, an independent API read matched all three current report versions and their observations in each scenario, including the second QA attempt in the assisted run. The worker and catalog hashes still matched the native environment. The disposable services on port 3332 were stopped with their volumes retained. The native runs remain available on port 3334.
