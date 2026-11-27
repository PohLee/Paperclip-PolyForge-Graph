# Beta recovery acceptance

Verified on November 20, 2026, with Node.js 25.2.1 on Windows. The new regression runs the Graph engine, native Decision reconciliation and dispatcher with a controlled Paperclip issue fixture and in-memory ledgers shared across dispatcher instances.

| Scenario | Observed result |
| --- | --- |
| An authorized owner answers a native Decision. Paperclip creates the downstream issue, then loses the create reply. | The Graph resumes and records one resolution. Dispatch reports `effect_unknown`, leaves the issue unattached and sends no assignment. |
| The same answer is processed again by a replacement dispatcher. Paperclip first returns no origin match, then returns an issue with the wrong parent. | Dispatch stays unresolved and reports `effect_mismatched` for the wrong parent. All responses reference the same create operation. No additional create or assignment is sent. |
| The exact created issue becomes visible by origin. The same Decision is processed again before a fresh run read. | The existing issue is attached and assigned. The ledger confirms one create and one assignment. The fixture observes one native card, one Graph resolution, one dispatch-intent record, one host create call, one host assignment call and zero explicit wakeups. |
| The host loses an assignment reply, whether or not it already applied the assignment. | A replacement dispatcher reports `assignment_pending`. An assigned issue readback alone leaves the assignment unresolved. The owner retry is blocked and the fixture observes one assignment call. |
| A node retry commits while assignment guard cleanup is unavailable. | The response identifies pending cleanup. Repeating the request with the same key clears the guards and keeps the same next attempt. |

The existing regression cases also cover malformed create receipts, duplicate origin matches, stale or unauthorized decision answers, and an owner retry that checks the database grace window before settling an absent create and requesting a distinct attempt.

```sh
node --test tests/e2e/dispatch.test.mjs tests/e2e/native-decision.test.mjs tests/e2e/product-decision-handoff.test.mjs tests/e2e/ui-host-support.test.mjs tests/e2e/ui-review.test.mjs tests/e2e/ui-dispatch-notice.test.mjs tests/plugin/effect-ledger.test.mjs tests/plugin/assignment-ledger.test.mjs tests/plugin/workflow-dispatch.test.mjs
```

The focused run passed 185 tests with zero failures. Four opt-in PostgreSQL tests were skipped in this invocation. The injected loss covers a replacement dispatcher against the same fixture persistence. It did not exercise an actual Paperclip transport interruption or PostgreSQL restart. The assignment reply case proves the recovery fence and leaves assignment confirmation unresolved.

The human dashboard reads the current attempt's stored receipt. Tests exercised a fresh dashboard read after a lost create or assignment reply, including historical snapshots with no delivery key. The read returned the unresolved status without triggering a send. After reconciliation, the same read returned the linked issue and cleared the warning. A missing issue link alone does not establish that a send is in flight. [Full candidate and separate PostgreSQL verification](beta-freeze-acceptance.md)

## Browser smoke

The in-app Chromium browser rendered the current Graph Runs component against a synthetic SDK and API on `127.0.0.1:18794`. The tests exercised browser interactions and captured the commands received by the fixture. Paperclip's native issue page, durable storage and authorization were outside this browser fixture.

| Scenario | Observed result |
| --- | --- |
| Review artifact `design-candidate@v1` while the fixture also includes evidence for `v2`. | The decision section links the exact `v1` artifact and its proof, excludes `v2` proof, and points to `#interaction-card-a`. |
| Advance the fixture host to snapshot B while A is still displayed and submit A. | The fixture rejects A with a stale response. The page removes the native action, disables advanced submission, and offers **Refresh run**. After refresh it links only the `v2` artifact and proof and shows **Open new Paperclip Decision**, targeting `#interaction-card-b`. A fresh advanced submission sends snapshot B with the same decision request ID and a new idempotency key. The run resumes after the one accepted command. |
| Load a native Decision projection that already reports a stale answer. | The action for card A is hidden. Refresh displays card B and its `v2` proof. |
| Dispatch returns an unknown issue receipt. | The warning survives the data refresh and the dispatch record reads **Awaiting confirmation**. A later confirmed result replaces the pending issue display with the linked child ID. |
| Open the run after an automatic dispatch already lost its create or assignment receipt, then reload the entire browser page. | An independent browser verifier saw **Issue creation is awaiting confirmation** or **Assignment is awaiting confirmation** on first load and again after reload. After the fixture host confirmed the receipt, Refresh removed the warning. Another full reload kept it cleared and showed the existing child issue. The verifier sent no dispatch or retry command. |
| Retry returns a committed result with cleanup pending. | One status message asks the owner to submit the same node and reason. The form retains both. The two captured requests use the same idempotency key, and the successful reply displays **Node retry recorded**. |

To repeat in this workspace, run `node .e2e/beta-recovery-browser/server.mjs` from the repo root. The ignored fixture builds the current component using installed React. Set `BETA_REVIEW_REACT_MODULES` to an alternate directory containing `react` and `react-dom` if needed. Use `/graph-runs?reset=1&scenario=review`, `native-stale`, or `dispatch` on the fixture server. **Advance fixture host** changes the served snapshot without refreshing the Graph UI. `/fixture/state` reports the command bodies and whether a decision was applied.
