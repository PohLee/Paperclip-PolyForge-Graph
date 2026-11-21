# Graph review beta freeze

November 20, 2026. This record covers the Graph runs review guide, recovery from a stale decision, and the status shown after a dispatch loses its receipt. The [post-beta backlog](beta-backlog.md) records the six deferred features, their rationale and the signals for revisiting them.

## Work packages and review

Three GPT-6.2 Sol coding agents used high reasoning for the review UI, recovery regression and backlog. The team lead reviewed the combined changes, fixed misleading dispatch and retry feedback, and checked the packaged plugin against the existing Paperclip installation. The PostgreSQL verification ran in its own database.

| User promise | Exercise | Expected result | Evidence and disposition |
| --- | --- | --- | --- |
| The three PolyForge destinations share one workspace. | In the authenticated POLA workspace, click Company operations → Graph runs → Graph settings, go Back, and follow the old plugin administration entry. | Back returns to Graph runs. The administration link opens the workspace settings page. | Live navigation on the existing localhost:3310 instance. |
| An owner can tell what is under review and recover from an outdated answer. | Display A, advance to B, submit A's answer, refresh, inspect B and answer the current request. Also exercise an ordinary transport error. | A cannot approve B. The guide identifies the current artifact and evidence, and the current card can be opened. A transport failure permits retrying the same submission. | Current React component in a browser with controlled responses, plus the Graph engine and native Decision tests. [Recovery and browser evidence](beta-recovery-acceptance.md) |
| Losing a receipt or replaying the same answer cannot silently duplicate work. | Accept the owner answer, lose the downstream issue-create reply, replace the dispatcher, then return first contradictory and finally matching evidence. Separately lose an assignment reply and interrupt retry cleanup. | The user can see which step awaits confirmation. Recovery produces one decision, one issue and one assignment. An uncertain assignment remains fenced. | Dispatcher regression with injected host responses and browser checks. [Scenarios and observed counts](beta-recovery-acceptance.md) |
| A real coding agent can hand a fixed change to an independent verifier. | Pin the review projection and its regression tests in a Git candidate, then check out that commit separately and run its tests. | The independently checked files match the implementation in this plugin byte for byte and the tests exit successfully. | The engineering handoff and package identity are recorded below. |

The shared POLA company had no saved Graph runs at baseline. The stale-answer and lost-receipt scenarios used controlled records outside that company. Paperclip's earlier five workflow runs used process fixtures. Running the entire ADLC implementation and verification graph with native, model-backed Paperclip agents remains a separate beta acceptance exercise. [Host rehearsal coverage](paperclip-host-2026-1117-upgrade.md)

## Candidate and independent verification

The review-guide implementer committed the delivered projection and its five regression tests in the local fixture repository `.e2e/beta-review-candidate` at `5ba794c526a6e8b1338105e5094d2180c90f412b`. The lead cloned it separately at `.e2e/beta-freeze-independent-review`, checked out that SHA detached, and ran `node --test tests/e2e/ui-review.test.mjs`. All five passed with exit code 0. The verifier compared both files with the plugin workspace byte for byte. The projection SHA-256 was `f9cf6dd942541e68a8d2023694db8cc4276a9cac72159be743d874024c92bcd2`. The test SHA-256 was `714e40f877bce2a23a1ad08cb2478572540dbfa4d0a4288eb989a43f0a4c1dba`. This commit identifies the two-file engineering handoff. The complete deployed package is identified below.

The full candidate was built from the Graph working tree based on `33adf8bd82546760daa0b7f053e8e4a48f3a940c`. The runtime artifact verifier checked its declared files and 19 migrations. Both companies passed the candidate preflight. The existing Paperclip installation reloaded the plugin and reported `0.8.10 ready` on Host `2026.1117.0`.

| Deployed item | SHA-256 | Verification |
| --- | --- | --- |
| Runtime manifest | `f6dea6138638a32167bcebf27caabcca9f8023b80a9ffd1faff6982292a64c4a` | Matches the all-company preflight and mounted file. |
| Plugin worker | `433e11f17a50d54736a5aebcca030564a8d000e66462aae44bd9bf7c7299a5f1` | Mounted worker matches the packaged file. The built worker initialized over JSON-RPC. |
| Graph UI | `5c5cadbabeec77cf9ecb038ede8269e02adcf70833d075786fb3211698521a6f` | The official plugin asset returned HTTP 200 and all 239,945 bytes matched the packaged UI. Workspace navigation and Back were checked live before the final receipt wording adjustment. |

The default test command `node --test tests/core/*.test.mjs tests/e2e/*.test.mjs tests/plugin/*.test.mjs` passed 617 tests, failed 0 and skipped 14. A separate selection on a disposable PostgreSQL 16.10 instance passed all 163 tests, including the 13 opt-in database cases. The selections overlap. The remaining opt-in Docker process-agent exercise creates a fixture company and restarts its target Host. It was not run on the shared instance in this freeze.

Snapshots taken immediately before and after plugin reload matched for companies, Pack activation, role bindings, organization, agents, project IDs, issue IDs and Graph runs. PolyForge ADLC had 25 visible agents, one CEO reporting to Board, and 24 verified manager links. Both original Docker volumes remained mounted. Local evidence is in `.e2e/beta-freeze-{before,after,preflight}.json`, `.audit/beta-freeze-tests.log` and `.audit/beta-candidate-postgres.log`.
