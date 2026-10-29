# Architecture deepening

## Approved scope

The user approved all three candidates from the architecture report on
2026-10-30. The implementation baseline is Core `43c960a` and Packs `f3e4b59`
on `codex/multi-pack-enhancement`. GPT-6 Sol / High subagents implement the
three modules; separate reviewers examine Standards and Spec after integration.

This is an internal refactor. Existing command names, authority checks,
Decision Records, immutable Pack identities and pinned Graph Run goals remain
part of the contract. It does not authorize model spending or external messages.

## 1. Shadow Task durable execution

- Preserve the current runtime interface used by company operations, Graph
  dispatch and scheduled recovery.
- Concentrate legal lifecycle progression, lease ownership, persistence and
  uncertain native-call recovery behind an internal durable launch seam.
- Keep Core authoritative for permissions, stop intent and final review
  acceptance. A stopped review cannot approve work, even after native success.
- Preserve one open launch per parent task, company isolation, request identity,
  candidate and goal pinning, legacy recovery and no blind duplicate execution.
- Test through the runtime interface with the production SQL adapter and a real
  local PostgreSQL database. Include concurrency, expired leases, stale writes,
  restart recovery and stop/completion behavior. Test schemas are disposable and
  separate from the development plugin schema.

## 2. Cross-Pack Work Plan state ownership

- Core owns exact Graph Run association, status derivation, idempotent
  reconciliation and dependency interpretation.
- Host callers request reconciliation without duplicating Graph status mapping
  or company/project/Pack/Graph identity rules.
- Preserve reconciliation during company reads and before starting a planned
  item. Graph Run creation and plan linkage stay in the same state transaction.
- Preserve Decision Records, version increments only on change, foreign or
  ambiguous run rejection and the completed-item intervention rule.
- Verify through existing Core and company interfaces using real Core behavior.

## 3. Pack loading and company registration

- Concentrate catalog snapshots, registration concurrency, immutable release
  checks and reload failure recovery in one Pack module.
- Keep instance catalog, company Pack Activation and pinned Graph Run snapshots
  distinct. Core compatibility and authority checks remain authoritative.
- Keep filesystem and store seams internal; no remote registry, new publication
  mechanism or new domain contract is introduced.
- Verify concurrent registration, changed published content, reload failure,
  retained catalog/health state and old run snapshots using temporary Pack files
  and the actual Core engine.
- At the baseline, the observed host initialization timeout had no established
  root cause. Improved loading structure alone is not evidence of a fix; any
  startup claim requires a measured reproduction and the same host check.

## Acceptance plan

1. Focused behavior tests for each module, including real PostgreSQL Shadow tests.
2. Full Core/plugin regression and build.
3. Packs compatibility against a fixed snapshot of the updated Core contract.
4. Real development Docker checks of company reads, Pack reload, a new automatic
   and same-Agent Shadow Graph, stop handling and recovery while executing.
5. Independent Standards and Spec review from the fixed baseline; repair P0/P1
   findings and repeat review of the repair.

## Decisions

- User: proceed with all three reported candidates.
- Implementation: preserve reconciliation timing, public commands and pinned
  contract versions; concentrate internal knowledge instead of changing behavior.
- Verification: reuse the existing development PostgreSQL and deterministic
  process Agents. No paid model or real email/Telegram delivery is used.
- Review repair: a candidate catalog must register as one Core transaction.
  `GraphEngine.registerPacks` provides the batch boundary; `registerPack` retains
  its existing interface. Failed batches must not change revision, audit, Pack
  eligibility or the in-memory immutable-release ledger. Company registration
  failures remain visible until the affected company recovers.
- Health distinguishes company registration from catalog reload. A successful
  ordinary company read can recover that company's error but does not clear a
  failed reload: it only proves the previous catalog works. The failed candidate
  remains unapplied until a subsequent reload succeeds.

## Results

- Core/plugin regression: **173 passed, 0 failed, 4 skipped**. The skips are three
  opt-in PostgreSQL tests and one Docker-only test; the PostgreSQL suite was
  separately executed against the real development database: **3/3 passed**.
- Build and actual built-worker JSON-RPC startup check passed. An independent
  reviewer also ran the startup check successfully in 2.55 seconds.
- Packs compatibility: **33/33 passed** against fixed Core 0.8.1 contract snapshot
  `sha256:c3e90057e2e42dcb989b388886c26d45068e5e7bc07b312e32cbc3bfd05f6793`.
  Snapshot scope is `src/core/` plus `src/plugin/review-context.mjs`. ADLC 0.2.1
  and Marketing 0.0.1 payloads and declared compatibility are unchanged.
- Real Docker architecture checks: **4/4 passed** — no-op company reads, failed
  Pack selection followed by valid reload, per-company activation preservation,
  and historical ADLC 0.2.0 run/candidate/goal snapshots retained after reload.
- Real Docker Shadow checks: **6/6 passed** — automatic Graph trigger, same-Agent
  independent execution, owner request/replay, worker restart during execution,
  stop intent followed by native success, and full-host interruption recovery.

The new Graph Run is `589883d1-a348-4574-8d36-cdc4e0769136`. Worker recovery kept
execution `b7179756-3b1c-4823-ae8a-bf7ad3e7bb33` and its accepted result. Stopped
execution `c950a4e7-98d5-4b9f-a17a-759ee01ffcac` succeeded natively but closed as
cancelled without a review result. Full-host interrupted execution
`df6634a6-1c49-4bdc-9e76-9076b33ef586` closed as failed without a replacement.
A scoped PostgreSQL query confirmed exactly **one native execution per task key**
for all six cases. Final host state: worker ready, zero open Shadows and launch
rows, temporary process delay removed.

### Independent review

GPT-6 Sol / High reviewers evaluated the implementation from the fixed baseline.
Standards passed with no actionable findings, including a separate check of the
batch registration repair and startup build fix. Spec review identified three
P2 issues: partial registration after reload failure, a different company masking
registration health, and duplicate registration audit during concurrent read and
reload. All were repaired, covered by actual Core tests and independently
re-reviewed. Final Spec review passed with no remaining findings.

### Verification limits

These results establish control flow with deterministic process Agents. Paid
model execution and review quality were not tested. Real email/Telegram outbound
remains disabled. The full-host test preserves Paperclip's actual interrupted
result; it does not claim an in-process Agent survives container death.

After restart, Paperclip's persisted plugin `ready` status briefly preceded an
active worker. An early job trigger was rejected as not running. Waiting for a
successful company API read, then resuming verification of the same execution,
passed. No replacement Shadow was created.

## Reproducing verification

- Run `node --test tests/core/*.test.mjs tests/e2e/*.test.mjs` and
  `node scripts/build.mjs` for the default regression and bundle gates.
- The three tests in `tests/e2e/shadow-launch-recovery.test.mjs` require
  `POLYFORGE_RUN_POSTGRES_TESTS=1`, an absolute path to the installed `postgres`
  module in `POLYFORGE_TEST_POSTGRES_MODULE`, and a local test database URL in
  `POLYFORGE_TEST_DATABASE_URL` (or the development container's `DATABASE_URL`).
  They apply production migrations 007/008 inside a generated disposable schema,
  including foreign keys to isolated fixture companies. They never insert into
  Paperclip's public company table. The helper matches the host's Drizzle JSON
  parameter binding; PostgreSQL performs the actual constraints and updates.
- With the existing enhancement fixture and authenticated development host,
  run `node scripts/e2e-architecture-deepening.mjs` for company-read and Pack
  reload checks. Use `scripts/e2e-shadow-production.mjs` for a new Shadow Graph,
  stopping, worker recovery and host-interruption phases, following its phase
  arguments and the [Shadow record](shadow-runtime-2026-10-30.md). After a host
  restart, wait for a successful company API response before triggering recovery;
  HTTP health or persisted plugin status alone may precede worker initialization.
- Pin the updated `src/core/` and `src/plugin/review-context.mjs` into a new
  immutable directory, then run the Packs repository's
  `scripts/test-compatibility.mjs` with that path, digest, Core version and
  `--full-suite true`. Keep earlier snapshots intact.

## Worker startup diagnosis

Docker acceptance reproduced the host's `initialize` timeout three times and
after a container restart. Importing the unmodified built worker alone took
34.9–38.5 seconds inside the container; its external SDK import alone took 17.8
seconds, beyond the host's 15-second initialization limit. The development
container loads `node_modules` from a Windows bind mount.

Bundling the worker's pinned SDK and semver dependencies reduced the import at
the same mounted path to 0.64 seconds. The previously failing official enable
request then returned HTTP 200 in 3.2 seconds. Manifest and UI build settings,
host timeouts and permissions were unchanged. The build now runs
`scripts/check-worker-rpc.mjs`: it starts the actual built worker and requires a
successful JSON-RPC initialization within the host's deadline.
