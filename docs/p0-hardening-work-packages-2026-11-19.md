# November P0 hardening work packages

Date: 2026-11-19 (Asia/Kuala_Lumpur). Baseline: Core/plugin 0.8.10.
Source: November 4, 11 and 18 PolyForge research briefs and the repository comparison in this chat.

The user authorized implementation, delegation to GPT-6.1 Terra with high reasoning, integration review, verification and completion documentation. No publication or deployment is part of this work.

## Work packages

| ID | Owner | Scope | Acceptance |
| --- | --- | --- | --- |
| WP1 | workspace_security | Resolved workspace identity, durable exclusive writer lease, fencing, expiry, setup/cleanup recovery | Concurrent runs cannot both acquire a writer; aliases cannot bypass exclusion; expired owners cannot act; partial setup remains recoverable |
| WP2 | approval_recovery | Bind direct and native human responses to the specific waiting instance; preserve authenticated identities and atomic consumption | Old answers cannot resolve a later wait at the same node; wrong run/version/instance denied; exact replay has no second effect |
| WP3 | dispatch_effects | Normalize governance, dependency, admission, execution and workspace-finalize facts | Post-review blockers do not suppress review; accepted is not started; failed/unknown finalize preserves decisions and denies privileged progression |
| WP4 | dispatch_effects | Durable effect identity, outcome-unknown reconciliation, monotonic retry budgets and one retry authority | Crash after external request does not cause blind replay; duplicate operation cannot execute twice; successful sibling results survive recovery |
| WP5 | workspace_security | MCP deployment inventory, explicit security minima, bounded validation and repository security boundary | Vulnerable/unknown required services fail policy; malformed/oversized inputs rejected; inventory does not assert that a server was installed or exercised |
| WP6 | lead | Integrate contracts, review cross-package behavior, run regression/build checks and reconcile documentation | Exact commands/results and external Host limits recorded; helper tests are distinguished from enforcement through a real Host |

Agents own separate source areas and communicate required shared-file integration to the lead. Agents must not change branches or commit. The lead reviews the combined diff and repairs integration issues before acceptance.

## Constraints

- Preserve fixed Pack/Workflow versions, company scope, trusted adapter checks, assigned-issue wakeups and authenticated checkout identity.
- Runtime graph mutation remains outside the approved scope. Task revision never silently changes Graph/Gate/Policy.
- Existing merge/deploy integrations must not be invented. Unknown external outcomes block replay until reconciliation.
- A plugin cannot claim to enforce physical workspace fencing if the Host does not provide the required execution boundary. Unsupported capability must be explicitly denied or recorded as unavailable.
- MCP versions are a checked policy snapshot, not a live security-update service. No unused MCP dependencies are added to this package.
- PostgreSQL/real Host acceptance is reported separately from deterministic fixtures and in-memory stores.

## Verification plan

1. Each owner runs focused positive and negative regressions and records exact results.
2. Lead reviews stale approval, alias/lease, phase/finalize and unknown-effect paths across packages.
3. Run the complete Core/plugin/E2E test selection, build, runtime artifact verification and whitespace checks.
4. Record unexecuted integration checks and remaining capability limits in the completion ledger.

## Completion ledger

Repository implementation, review corrections and local verification are complete for this candidate. The [completion ledger](p0-hardening-completion-2026-11-19.md) records 398 passed tests, 9 skipped tests, successful build/artifact verification, and separate remaining Host/deployment work for full P0 closure. WP1, WP3 and WP5 have explicit external integration limits; no live PostgreSQL, physical writer fencing or installed MCP acceptance is claimed.
