# GitHub contract merge journal

The `adlc-contract-publish` worker runs every minute. It reconciles durable operations and processes due G2 publication requests. It projects proven receipts into the queue and records the existing Core `contract.merged` event before releasing the repository slot. See [G2 enablement](contract-merge.md#enable-g2-publication) for project and App configuration.

## Deployment invariants

- Assign each GitHub repository write lane to one plugin database namespace. Within that namespace, all companies using the repository must share the same GitHub App and installation. Config validation checks existing registrations. That check is advisory: the host runs it only from the config test route, not on save. The journal's execution-time binding predicate is what enforces this constraint, including when config changes race. A repository rename requires an operator rebind that verifies both stable repository IDs.
- Give the contract publisher sole write access to `main` while strict base pinning is required. GitHub's `force: false` ref update enforces fast-forward. The REST call has no expected-old-SHA parameter.
- Reserve `refs/heads/polyforge-merge-*` for the journal. An unresolved operation retains its temporary ref and blocks the repository slot until proof permits recovery.
- The scanner rotates `intent`, `patched`, `recorded`, and `unresolved` rows under their fences before each attempt. It respects the observation grace period for intent. A failed read or record goes behind older unattempted work. Durable recording uses saved journal evidence, including when the gate is disabled. GitHub observations still require the original App and installation and a verified transport.
- Migration 022 adds `cleanup_attempt_at`. The cleanup scan attempts the oldest unattempted receipts first and advances this timestamp before looking up the repository. Cleanup deletes only a temp ref pointing to the saved merge SHA. It re-reads the ref after an ambiguous DELETE and accepts an absent ref as complete. A different target is recorded as `ref-changed`.

## Owner recovery

Use the authenticated issue Graph command with `operation: contract-publication-recovery`, `runId`, `nodeId`, `attemptIndex`, and `kind` from the issue's publication request. Set `recoveryAction` to `view` to inspect the scoped journal operation or `reschedule` to retry the existing occurrence. The caller must be an active human member of the company and the configured project owner.

For an unresolved operation, `reschedule` can produce two audited outcomes.

- `ancestry` means the saved merge SHA is contained in main. The original operation moves to `patched` and the worker records its exact receipt.
- `abandoned` requires proof that the operation never reached the PATCH send boundary and that main is a descendant past the operation's base. A saved merge SHA or a verified merge commit found at the temporary ref must be absent from main. The worker confirms the temporary ref is already absent or verifies its deletion under a GET guard. If a SHA was saved by an older writer that did not record its send boundary, ancestry remains the available recovery path. Where the publisher is main's sole writer, an operator must advance main with a descendant commit before abandonment is possible. Abandonment releases the repository slot, archives the operation and leaves the request requiring fresh approval.

Recovery refuses to clear an operation when proof is incomplete. It never replays the PATCH or grants this occurrence another send. The audit table `github_merge_recovery` retains the owner and proof after slot turnover. The `github_merge_recovery_attempts` table records owner reschedules and refusals with their reason codes.

Operators with database access can inventory unresolved operations and their temporary refs with this read-only query. Treat the results as company-scoped operational data.

```sql
SELECT repository_node_id, company_id, run_id, pull_number, operation_key,
       temp_ref, merge_sha, missing_fact, updated_at
FROM plugin_polyforge_graph_ff7d84e8bb.github_merge_journal
WHERE state = 'unresolved'
ORDER BY updated_at, repository_node_id;
```

## Installed-pair transport probe

From Core, pass the installed Paperclip server package directory that contains `package.json` and `dist/services/plugin-host-services.js`. A pnpm cache installation can supply that directory.

```text
node scripts/check-github-host-transport.mjs "<path to installed @paperclipai/server>"
```

The probe pairs Core's installed plugin SDK with that server. It uses stubbed DNS and sockets and a synthetic bearer to check same-host and cross-host redirects, binary blob round-tripping, and empty-204 handling. With SDK and host version `2026.1106.0`, the SDK throws on DELETE's empty 204. The durable cleanup path then reads the ref again. Deployment acceptance also requires testing the shipped worker and exact deployed host against a controlled public HTTPS fixture. After acceptance, put the exact tested `hostVersion`, `sdkVersion`, and UTC `probedAt` into the company-scoped `githubTransportAttestation` object. Repeat the procedure for either version change.

Paperclip sends `instanceInfo.hostVersion` during JSON-RPC initialization. SDK `2026.1106.0` consumes initialization internally and does not expose the running host version to plugin setup. The worker reports `blocked-config: transport-redirect-unsafe` with that SDK even when the configured attestation matches the probe output. Enable writes only when a trusted runtime source supplies both exact versions.
