# Workflow composition Pack release

Status: ACCEPTED. All five workflows completed on the unmodified official Paperclip Host through Kiri. Core: 375 passed, 9 skipped; Packs: 134 passed. The verified archives below are the release artifacts.

The user authorized GPT-6 Luna subagents to update all three Packs, run Docker E2E, and publish if verified. The exact CLI model `gpt-6-luna` with `model_reasoning_effort=high` passed a live readiness request. Separate agents own ADLC, Marketing, Creative Team, and the Docker acceptance harness. The lead owns Core/Host integration and release assembly.

## Candidate scope

- PolyForge Core/plugin 0.8.10: workflow contracts, runtime, Agent tool, atomic child lifecycle, trusted adapter child binding, explicit evidence input source.
- ADLC 0.3.3: contracted architecture and code delivery entry points and architecture composition.
- Marketing 0.0.5: acquisition brief and composed readiness review, without granting campaign/spend authority.
- Creative Team 0.3.3: contracted brand foundation and composed parent, retaining artifact and human decision validation.
- Pack collection 0.2.3: catalog and release packaging.

Legacy graphs keep their input contracts. Published release payloads are not rewritten. The new graphs require the workflow-composition capability. Business inputs cannot overwrite trusted company, project, issue or actor fields.

## Acceptance gate

Run full Core/Host and Pack test suites, verify deterministic Pack digests, build and verify the plugin artifact, and run the new workflows against the unmodified official Paperclip 2026.1106.0 Docker image. Use a uniquely named disposable container and a single temporary database. Report synthetic fixtures separately from model quality or external execution evidence. No public release is permitted if any required check remains failed or unverified.

The trusted child adapter must validate the original initiator and preserve the mapped input. Interrupted adapter binding must prevent dispatch and repair the same child on retry. Evidence validators may explicitly read workflowInput, but no trusted envelope fields are copied from business input.

## Results

- Core/Host suite: 384 tests, 375 passed, 9 skipped, zero failures.
- Complete Packs suite: 134 tests passed, zero failures.
- Built worker initialized successfully through official SDK JSON-RPC.
- Extracted plugin artifact matched its archive; the extracted Core registered all three extracted Pack releases successfully.
- Docker attempts exposed fixture integration errors (incorrect ADLC input names and missing Agent checkout/self-review). Failed attempts were stopped and their evidence retained locally. These attempts do not satisfy acceptance. The harness is being corrected before another isolated run.
- At approximately 17:48 MYT on 2026-11-18, Docker Desktop exited. Subsequent read-only checks found no `docker.exe`, no Docker processes, and an empty original installation directory. No reinstall, reset, or removal was performed by this task. The lead asked whether the user was updating/reinstalling Docker. Acceptance must resume once Docker is available; unit tests cannot substitute for it.
- The user confirmed switching to Kiri. Its Docker API is available through context `kiri` (Kiri 0.2.1, API 1.47). A disposable Alpine probe confirmed the candidate's read-only Windows bind mount and tmpfs with network/resource isolation parameters. The same pinned official Paperclip image is being pulled into Kiri for acceptance; this probe alone is not acceptance.

Verified release archives:

A subsequent Creative run found that ordinary incoming edges could activate independent review after only one parallel product completed. The child now uses an explicit ALL join for identity and voice, with regression coverage for both completion orders. The fixture also uses longer bounded HTTP and Process Agent deadlines so a committed submission's downstream dispatch is not mistaken for a failed task. The new final archives below supersede earlier candidates; the complete five-workflow acceptance suite is rerunning against these exact bytes.

The current candidates supersede the initial archives after actual Host execution exposed a Marketing human-review classification error and a parent output mapping error. The new Marketing lifecycle regression covers Agent rejection, owner review, and the exact projected child output. The parent now explicitly requires its mapped `constraints` field. Official Paperclip's worker environment isolation also required an operator-owned Creative gateway secret-file option; no Paperclip Host fork or image modification was introduced. Targeted independent GPT-6 Luna review found no concrete blockers in these fixes. Kiri's initial cold image materialization and read-only nested-mount behavior were handled in the test harness.

| Archive | SHA-256 |
| --- | --- |
| `pohlee-paperclip-polyforge-graph-0.8.10.tgz` | `f991dee76565c4647ef162beaa59749e826b4ae1075d3409b5c6062bc117a8be` |
| `paperclip-polyforge-packs-0.2.3.tgz` | `808c48577a306bbc572464c26555ba1cc7d411b27eb42adddef1220d45a9eeff` |

| Pack | Version | Payload SHA-256 |
| --- | --- | --- |
| ADLC | 0.3.3 | `2bb67b8f5fb64e8d95b8c6866fd932a2d47c052616e3978cb914515e6256a4a4` |
| Marketing | 0.0.5 | `b04b6bc0e46b2f7480a0d62c21a5ed98b33a63f88f48cc8ef3ccf2421e2c2568` |
| Creative Team | 0.3.3 | `7ce4dd7905dae654868c29744808393770e1d53b5f2d3f7af33f61c5f300c2dd` |



The full trusted Creative adapter regression additionally found the package validator reading the legacy decisionRef instead of its declared acceptanceDecisionRef. This is fixed with exact decision ID/version validation. The regression rejects forged reviewer execution IDs and stale approval versions without mutating state. Native Host fixtures supply their actual heartbeat execution ID.

Kiri acceptance attempt 8 completed all three ADLC workflows but exposed the same native dispatch race in Creative and Marketing: automatic issue-assignment wakeups and explicit plugin wakeups can yield different run IDs. The actual checked-out process was rejected against the queued wakeup binding. No release was made. A dedicated GPT-6 Luna high agent is adding a deterministic dispatch race regression and fixing the binding boundary before rebuilding.

The dispatch fix uses the pinned official Host assigned-issue wakeup and removes the duplicate explicit wakeup. Only a verified current checkout can bind an unbound issued/waking dispatch, using an exact-identity compare-and-set. Regression coverage rejects other executions, Agents and attempts. The old explicit-wakeup tests were replaced with coverage of this new boundary (382 total Core tests). Owner retries still create a new Graph attempt and issue; Host execution recovery remains owned by Paperclip.

Attempt 9 confirmed successful first callbacks after the dispatch fix, then exposed a fixture lifecycle omission: the Process Agent left its native Paperclip assignment open after Graph submission, causing Host continuation to replay already completed work. The fixture now closes its checked-out assignment after successful submission/self-review. Attempt 10 reruns the same frozen plugin bytes. Independent GPT-6 Luna review found no confirmed dispatch blockers; callback arrival before dispatch issue-link persistence remains an untested preexisting ordering edge, and interrupted issue-write/duplicate-origin coverage should be expanded separately.

Attempt 10 reached Creative parallel work and correctly rejected a stale validation snapshot after a sibling committed. The fixture now retries only the exact validation-conflict error, at most four times, with the same idempotency key through full server-side revalidation. All authorization, artifact, and other errors remain fatal. Attempt 11 uses unchanged release archives.

Attempt 11 reached the Creative human acceptance gate and correctly denied the synthetic owner because only a namespaced role was configured. The fixture now assigns the explicit creative-director domain role through the normal owner configuration command, alongside its namespaced role. Unauthorized Agent negative tests remain unchanged. Attempt 12 runs all five workflows against the same frozen bytes. Final Core suite after harness corrections: 373 passed, 9 skipped, no failures.

Attempt 12 rejected the unscoped role at the settings boundary, revealing that attempt 11 was a real namespace mismatch rather than merely fixture configuration. The invalid fixture role was reverted. Host settings correctly accepts only creative-team:creative-director, but Core checked only creative-director for the decision node. A dedicated GPT-6 Luna high task is fixing matching against the pinned Pack namespace with cross-Pack rejection tests. Earlier role-configuration interpretation above is superseded by this finding. No release has been published.

The pinned-Pack role fix is complete: Core accepts the current Pack namespace without modifying the trusted actor identity or adding global local-role aliases. Other-Pack same-name roles remain rejected; a namespaced human-owner cannot substitute for global Owner authority. The real Creative adapter lifecycle regression now uses the namespaced Owner role and checks a foreign-Pack role leaves state unchanged. Final suites: Core 375 passed/9 skipped (384 total), Packs 134 passed. Attempt 13 runs the rebuilt archive above.

## Final acceptance

Attempt 13 completed all five workflows in one isolated Kiri container with the exact archives above: Creative brand foundation composition, ADLC standalone architecture, ADLC composed architecture, ADLC code delivery, and Marketing acquisition readiness. Invalid inputs and wrong versions were rejected without state changes; wrong Agent human-gate requests were denied; authorized owners completed the required gates. All three parent workflows returned completed child outputs. The official Host image was unchanged. The container was removed after evidence capture.

Machine-readable evidence: [workflow-composition-2026-11-18.json](evidence/workflow-composition-2026-11-18.json). It includes exact archive hashes, Host image digest, workflow handles, child links, output references, and negative authorization checks. The fixture uses synthetic Process Agents; completion does not establish real external CI, merge, marketing publication/spend, or model-quality outcomes.
