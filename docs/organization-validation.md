# ADLC organization validation — 2026-10-27

## Requirement and fix

The original numbered “Paperclip agents” roles and [BASE-011](requirements-baseline.md) require **two Board roots and nine direct reports**. CPO manages Internal Product Analyst, External Product Analyst, Product Manager, Product Owner, and UI/UX Designer Lead. CTO + CAIO manages Principal Engineer, Lead Engineer, QA Engineer, and Security Engineer. Pack `0.1.1` declares these relationships with `reportsToRole`; its separate `supervisorRole` still controls artifact review. An independent reviewer must use a different execution identity from the producer.

The initial read-only Paperclip check reproduced the defect: all 11 existing ADLC agents had `reportsTo: null` and appeared directly under Board. The pinned Paperclip plugin SDK can provision managed agents but does not expose a `reportsTo` update in its manifest or `ctx.agents` API. Plugin `0.2.3` therefore uses an authenticated company owner/admin plan, supported Paperclip `PATCH /api/agents/:id` for only missing managed relationships, and a confirm step that re-reads and audits the actual result. The worker resolves ownership with `ctx.agents.managed.get`, validates company and role identity, and records an append-only requested/blocked plan before any patch and an applied result linked to that plan after verification. Existing nonempty custom managers are conflicts and are not overwritten.

## Independent verification

| Check | Result |
| --- | --- |
| Pack and focused tests | Pack `0.1.1` defines 11 `reportsToRole` values: two `null`, five CPO reports, four CTO reports. `node --test tests/e2e/reporting-plan.test.mjs` passed all three cases, including custom-manager preservation, cycle rejection, and cross-company rejection. |
| Existing fixture | Authenticated live `GET /api/companies/f86b26ce-01fa-4057-8e77-7119026bdea2/agents`, compared role-by-role with the Pack and saved 11 bindings, returned exactly two Board roots and nine correct parent IDs. All 11 binding IDs remain those of the prior Graph fixture. |
| New isolated fixture | Live company `065a79b6-bfa8-4e80-8439-3e33b7228f2e` likewise returned 11 bound ADLC agents with exactly two roots and nine correct parents. A separately created unmanaged sentinel `836a0b3d-695e-4732-b620-629a78b1f2e5` remained outside the role bindings and has no reporting parent. |
| Repeat and profile preservation | The reconciliation CLI's fresh repeated runs in both companies reported zero PATCH operations, and its immediate before/after comparisons passed for every managed profile field except `reportsTo` and the host edit timestamp, plus the complete unmanaged sentinel profile. The old company's browser **Align existing agents** action then returned **“0 reporting links applied; existing agent profiles preserved.”** The Settings default remained Assisted and bindings were not saved or changed. |
| Audit | Integration's read-only decision-store check found requested plans with linked applied/aligned results for both companies. The browser action used the owner session and the real `org-reporting-plan` / `org-reporting-confirm` action path. |
| Host UI | In `http://localhost:3310/POLAAAA/agents`, the real Org chart showed CPO and CTO + CAIO side by side, with their respective five and four direct reports. Plugin Settings showed version `0.2.3` ready and the ADLC organization controls. No browser warning/error logs were captured during this check. |

Browser evidence (ignored local files): `.e2e/organization-chart-v0.2.3.png` and `.e2e/organization-noop-v0.2.3.png`. Neither contains credentials. The first shows the actual Paperclip hierarchy; the second shows the no-op success message.

## Limits

The host can later change unrelated agent lifecycle fields. The unmanaged sentinel's older 13:21:50 UTC hash no longer matches after a separate Paperclip lifecycle verification at 13:23:56 UTC; host logs and the lack of an agent configuration revision attribute that later change to lifecycle verification, not this reporting PATCH. The fresh reconciliation snapshots compare profiles immediately before and after each run, which is the supported preservation claim. This validation checked organization and its audit path; it did not rerun the three Graph workflows.
