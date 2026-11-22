# Product discovery beta acceptance

Run this check on an isolated Paperclip Host before accepting a change to the Discovery graph, supervisor rules or delivery clock. Use the native Paperclip Runner, the default idle limit of 1,800,000 active milliseconds and separate delivery keys for the positive and stalled cases. Graph reads reconcile expired runs. Record the first read that observes expiry as well as the underlying time limit.

## What counts as research progress

ADLC 0.3.9 publishes `product-discovery@0.2.1`. Each milestone is credited when the assigned supervisor accepts the reviewed task with fresh versioned artifacts.

| Reviewed task | Supervisor | Artifacts and acceptance boundary |
| --- | --- | --- |
| Internal research | Product Manager | `internal_evidence` records a sourced observation or a concrete investigation result, including the sources examined and implications. |
| External research | Product Manager | `user_research_record` and `external_evidence` are reviewed together. A documented access limitation may affect the decision. Claims about customer behavior need supporting evidence. |
| Discovery synthesis | CPO | `evidence_ledger`, `discovery_options`, `discovery_brief` and `versioned_intent` connect the findings, alternatives and remaining uncertainties. The human disposition determines the next step. |

The supervisor requests rework for empty records, unsupported claims and revisions with no material change. Core checks artifact identities and versions; the supervisor assesses the content. Framing, self-review, the join, the routing decision and reuse of unchanged artifact references earn no milestone.

## Repeatable acceptance

For ADLC 0.3.10 and later, also exercise the synthesis citation check on the same run. Submit a substantive first brief with one of its direct research citations missing. Let the native CPO independently review the candidate and record its disposition. The run must retain that attempt and both prior PM acceptance decisions. Resubmit a new brief version with both accepted references in `output.discovery_brief.researchRefs`, and obtain a new native CPO review. From Graph runs, open **Discovery brief → Cited research** and follow each reference to the accepted source attempt. Match the source ID, version, review decision and recorded research content. Verify the rejected attempt earned no synthesis milestone.

1. Start an assisted run with a versioned source request. Give the test researchers attributable source material and state which inputs are synthetic. Record a production claim only when its source supports it.
2. Have native producers and independent native supervisors complete the framing plan, both research branches and the synthesis. Include the substantive work in the versioned Graph output or give the reviewer access to the exact artifact body. An artifact ID alone can be insufficient when the author's Paperclip child issue is outside the reviewer's scope. Verify that both branches join, and inspect the eligible candidate, actual evidence and self-review occurrence for each review. Preserve rework and retries.
3. Observe the same run after **more than 30 active minutes** from its start. Confirm the original idle limit, three milestone records with the correct artifacts, and the human gate's final decision and terminal node. If the work reaches the human gate early, disclose the active gate wait separately. Paused time does not count.
4. On another delivery, withhold fresh research after native framing. Leave the run active. Capture a running observation shortly before the boundary and the reconciled terminal record after it. Verify `idle_progress_limit`, the clock and the absence of accepted research. Confirm that a clock with a previously accepted research milestone also enforces the same boundary using `node --test tests/core/adlc-delivery-milestones.test.mjs`.
5. Retain the company, issue, Graph run, reviewer and terminal decision IDs, Host and Pack versions and clock observations. Restore temporary operator grants, role bindings, agent settings and test budget allowances.

## November 22, 2026 candidate

The isolated Host on port 3326 loaded ADLC 0.3.9 with release digest `sha256:ae427d571c77112541a03f728223a1fae0178108490b71f5e7e02dab00bd7630`. The Host snapshot's digest for the complete Pack was `sha256:c0d19f999bceb635727cb87d0db15c159c49e80f611b54cad7563b8fb34f2882`. The deployed Graph worker SHA-256 was `4a32ae71969028fc667faf2e76f5b473f700531d52e886878898d771fc62cfc2`.

The Pack suite passed 135 tests. The Graph suite passed 734 and skipped 14 opt-in tests. The exact-boundary test uses the real Discovery graph and a controlled clock: internal research is accepted at minute 20; an external submission and self-review at minute 31 leave its supervisor review pending. The run remains active one millisecond before minute 50 and expires at minute 50. The live Docker cases below use the Host clock.

### Native cases on port 3326

The [positive run](http://localhost:3326/ADLAA/graph-runs?runId=80ae9f7c-fee1-4b62-8000-083397bd9208) used `assisted` mode and native Codex Runner producers and supervisors. The first framing submission exposed a versioned reference with insufficient body content for independent review. An operator relayed the existing document to the review child with its provenance and provided tool-parameter guidance. The CPO requested rework. The Product Owner submitted a revised plan with structured content in Graph, and the native CPO accepted it. Framing earned zero milestones.

At 00:41:53 and 00:42:04 Malaysia time, the native Product Manager accepted the internal and external research respectively. The internal record distinguishes one operator's report about comparing issue status, review decisions and artifact versions from customer evidence. The external pair identifies the single-operator sample, lack of representative customer interviews and limits of public documentation. Both records explicitly leave customer validation open.

The positive test deliberately scheduled the CPO's synthesis review after minute 30. The operator held only the isolated CPO's availability, then restored it and requeued the same review child. The Graph clock continued running at the default limits. It was running at 1,779,066 and **1,808,727 active milliseconds**, with 20 idle minutes remaining in the second sample. At 00:55:40 the native CPO accepted all four synthesis artifacts (decision `ca09f412-ebfc-42b1-bb65-cfc26d46a466`). The engine recorded the third milestone and the CPO finished successfully. The 30-minute crossing includes waiting for the scheduled reviewer; the post-boundary review itself was a real Graph transition. The synthesis points directly to the request and framing records. It does not directly cite both upstream research artifact IDs, so the operator inspected the accepted branch evidence separately.

The positive case **passed**. The authenticated human owner used the gate's CPO role to record `advance` (decision `89eb7a46-df6d-4e96-952a-903461e550f8`). The authorized next step is a reversible requirements probe. Customer demand, comparative benefit, baseline and implementation authorization remain open. The automatic terminal emitted `accepted_intent` after **2,096,150 active milliseconds (34 min 56.150 s)**. There were three accepted milestones, four accepted native producer submissions, four independent native supervisor dispositions and no delivery-limit stop. All eight accepted-path heartbeats have successful `paperclip_finish` receipts. Local sanitized receipts are in `.e2e/adlc-039/positive/final-evidence.json`.

After the positive run, the operator removed the temporary human CPO grant, restored five managed instruction entries and the test budget, and paused all five test agents. The host reported zero live heartbeats.

The [stalled run](http://localhost:3326/DIS/graph-runs?runId=3865875b-f856-4146-bfa5-4b9a4ac0c196) was started in a separate test company with the same default limit. A native Product Owner produced and self-reviewed `discovery-plan-template-review-status@v1`. A test owner acting as the manual CPO accepted the plan (decision `ae04617e-c9b5-4721-904e-343f9ce1efcb`). Both analyst bindings were deliberately withheld, leaving both research tasks ready without an executor. The run remained active, with zero research milestones.

The negative control was still running at 00:51:59 Malaysia time, about ten seconds before the boundary. The first post-limit read produced `idle_progress_limit` at 00:52:18, with **1,808,420 active milliseconds**, zero milestones and no further work. Decision `c493a7f8-9d59-41cd-b2bb-9a7b325bef61` records the stop. The native author's successful `paperclip_finish` (heartbeat `ed834222-bf3a-427c-89b2-b52e5aef463a`, sequence 270) confirms the plan had completed. The eight-second excess reflects the observation interval. The operator restored bindings, instructions and the temporary budget, paused the test author and verified zero active heartbeats. Clock samples and receipts are under `.e2e/adlc-039/stall/`.

## Discovery brief citations · ADLC 0.3.10

[ADLAAA-1 on the isolated Host](http://localhost:3326/ADLAAA/graph-runs?runId=f52a8366-c0a1-4f69-a7a3-b248a1021b8e) pins `product-discovery@0.2.2`. The Pack release digest is `sha256:65ff2fed2ca7a8cd03a4a2b844bf9c35b693be65024ecaf3cbf208e1fffefb90`. The isolated worker SHA-256 is `61dc91e82cd5e4f7a70c8727b866309e76b9031bf188836717671461e59fa3de`, and the UI bundle SHA-256 is `509d7f964a8ea6bdecb9daafdb99a06c1de183f27ff817f73ad58c73058d2e78`.

The first synthesis author was instructed to omit the direct citation field for this test. The CPO received the Pack rule and its normal review packet, including the exact source versions, their decision IDs and the recorded research bodies. The worker checks the citations against the accepted branch versions before recording an acceptance or crediting a synthesis milestone. All 137 Pack tests passed. The final Graph workspace sweep passed 742 cases with 14 opt-in skips and one failure in a concurrently added standard-verification test. That test expects a QA report for candidate A to be rejected when submitted against B. It exercises a different graph. The discovery citation, dispatch and UI regression tests passed. The [verification lineage follow-up](verification-lineage-beta-acceptance.md) records the repair and its separate acceptance results.

| PM-accepted source | Artifact version | PM decision |
| --- | --- | --- |
| Internal research | `internal-evidence-accepted-status@v1` | `93b2f7f7-2c39-4f5b-80df-29535f631796` |
| External research | `accepted-evidence-external-evidence@v1`, with companion `accepted-evidence-user-research@v1` | `c1dec173-4057-491b-9ae5-a4a910a4a3a9` |

The first native brief, `accepted-status-discovery-brief@v1`, had a substantive body and no direct report citations. The Graph runs page showed “No research versions cited.” The CPO recorded `rework` (decision `04f97eac-b202-4d66-8996-7f1ad54f28da`, native execution `efa2a280-4dce-49f6-b072-8a60b1a072c3`), identified the missing field and named the accepted sources. Both PM decisions remained in place, and only those two research milestones had been credited.

Attempt 2 was published as `accepted-evidence-discovery-brief@v2`. The author changed the brief ID as well as its version. The same run, node, attempt sequence and rework decision link the two submissions. Its first CPO execution blocked because the native issue description abbreviated nested citations and the runner could not fetch the full packet. The fix pins a `research-citations` document on the supervisor child and includes the submitted and expected reference identities in new review descriptions. Normal Graph dispatch created the document on the existing child. The operator reopened that checkout with instructions to read the pinned document. No operator copied source material or wrote a review verdict.

The recovered native CPO read the document and accepted attempt 2 (decision `1556e8f1-e603-4a15-9811-df7b593cabe6`, execution `d068697f-9e78-40e0-9b4c-414b9543e270`). The synthesis milestone was credited once. An authenticated browser opened the accepted brief in Graph runs. Following each citation with Enter opened and focused the original accepted research attempt. The internal source displayed its body and PM decision. The external source displayed both the report and the paired user research record with their shared PM decision.

The run was paused at the human discovery gate. Agent instructions and budgets were restored, and the test company had zero live heartbeats. The exercise ran only on port 3326. Local receipts, source hashes and cleanup evidence are in `.e2e/adlc-040/citations/final-evidence.json`.
