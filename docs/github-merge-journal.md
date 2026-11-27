# GitHub contract merge journal

PR-B1 provides the repository journal, scoped App credentials and host transport. The worker schedules discovery only. Contract publication, graph and queue fencing at intent, receipt projection, and the owner recovery command require PR-B2. The transport readiness check reports `blocked-config: transport-redirect-unsafe` until a trusted attestation can identify the tested deployment pair.

## Deployment invariants

- Assign each GitHub repository write lane to one plugin database namespace. Within that namespace, all companies using the repository must share the same GitHub App and installation. Config validation checks existing registrations. That check is advisory: the host runs it only from the config test route, not on save. The journal's execution-time binding predicate is what enforces this constraint, including when config changes race. A repository rename requires an operator rebind that verifies both stable repository IDs.
- Give the contract publisher sole write access to `main` while strict base pinning is required. GitHub's `force: false` ref update enforces fast-forward. The REST call has no expected-old-SHA parameter.
- Reserve `refs/heads/polyforge-merge-*` for the journal. An unresolved operation blocks its repository slot and retains its temporary ref. Only proof that main contains the saved merge SHA can resolve it. The cleanup path for proven operations deletes a ref only after reading its exact saved target. If GitHub has already removed the ref, cleanup succeeds.
- PR-B1 has no recovery or cleanup scanner. The PR-B2 scanner must rotate each row it selects from `due('unresolved')`, or from `pendingCleanup()`, before it attempts recovery. A failed identity lookup, observation or DELETE must never leave the oldest rows at the head of a bounded scan.

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

The probe pairs Core's installed plugin SDK with that server. It uses stubbed DNS and sockets and a synthetic bearer to check same-host and cross-host redirects, binary blob round-tripping, and empty-204 handling. With SDK and host version `2026.1106.0`, the SDK throws on DELETE's empty 204. The durable cleanup path then reads the ref again. Deployment acceptance also requires testing the shipped worker and exact deployed host against a controlled public HTTPS fixture and binding the result to the deployed pair.
