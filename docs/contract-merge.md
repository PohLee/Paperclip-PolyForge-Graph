# Contract merge Host action

Trusted Host code calls `mergeContract` from `dist/host/contract-merge.js` with its configured project, run and PR identifiers, gate decision ID, and the approved manifest's artifact ID, immutable revision ID and bytes. The project supplies `id`, `repository`, `ownerId`, and optionally `contracts_root` (default `docs/contracts`). The technical path also requires a configured `ctoId`.

Product publication requires the current human `requirements-acceptance` decision with outcome `accept` from the configured owner. Technical publication requires the current CTO `technical-contract-approval` decision with outcome `accept`. The action matches the decision to the current completed gate attempt and checks its evidence for the manifest artifact ID and revision. Configured G2 gates collect the decision through a revision-bound Paperclip confirmation. Product publication may include `design/interaction.md`, because G2 approves the interaction design with the PRD. Design publication requires the current human `g3-visual-approval` decision with outcome `approve` from the configured owner, as produced by the Creative `g3-visual-contract` graph. It may change any `design/` file except `design/interaction.md`, because a behavior change returns to G2. Assisted-mode G3 approval by design-audit is not supported yet.

## GitHub adapter

WP0.2 must wire the dedicated GitHub App and the trusted main-side CI-equivalent validator. The action uses these injected methods. Blob values are raw bytes or UTF-8 strings. Digests are lowercase SHA-256 hex.

- `getRef({ repository, ref })` resolves `refs/heads/main` to a commit SHA.
- `getPullSnapshot({ repository, pullNumber, baseSha })` supplies `baseRef`, `baseSha`, `headSha` and the complete diff between those SHAs as `changes`. Each change includes `path`, `mode`, `status`, `bytes`, and `previousPath` when applicable. Establish that the pinned main commit is an ancestor of the proposed head. The action permits regular-file additions and modifications.
- `loadValidator({ repository, ref })` selects trusted, installed Core or Pack code and pins repository project data to the supplied main SHA. Its `recompute({ repository, baseSha, headSha, contractsRoot, section, manifest })` method reads Git content at the pinned revisions and treats the head as data. It validates Pack formats, deliverable mappings, project-specific CI paths, file types and lock and index semantics. It returns the validated lock's `contractId` and `supersedes`, the active immutable `currentRevision` from main (null for initial publication), a `deliverables` map from manifest key to proposed published bytes, and a `changes` map from repository path to independently recomputed bytes. Include every required publication change, including generated criteria, lock and index changes where applicable. Generate those bytes from approved immutable revisions and trusted main state. Throw on validation failure.
- `merge(request)` merges the given pull request at the pinned head and main SHA. Serialize operations on a target and reject a changed head or base. Return the merge commit SHA. Make the operation idempotent for the full publication identity, including the run, decision and manifest digest. Recheck main immediately before the merge and verify the resulting commit parents.
- `getMergeReceipt(request)` recovers a successful operation by its full publication identity. It returns `{ baseSha, headSha, mergeCommitSha, contractId, supersedes }` or null. The adapter authenticates the receipt as its own successful merge for the same request. This supports retries after a failed run write.

The action records the receipt and a `contract.merged` audit event in one Core store update. The event carries the run ID and receipt fields, including `mergeCommitSha`. Downstream consumers use that event as the publication signal. The technical publication event carries the fields used to start G-T2.

GitHub Free private organization repositories lack branch protection and rulesets. The bot enforces the checks before its merge. Other users and tokens with write access can bypass the bot.

### GitHub App adapter

`createGitHubAppAdapter` takes a repository-scoped installation token provider, an installed validator and a durable receipt store with `get`, `set` and `delete`. The validator reads project data at the pinned main SHA. Repository merge calls serialize within one process. Deploy one writer per repository.

GitHub checks the requested head SHA. The adapter reads main before submitting the merge and verifies both parents afterward. Main can still move between the read and the merge, including through an external writer. A parent mismatch is persisted as a failed receipt and requires operator reconciliation. Set `mergeActorLogin` to the App bot login so the adapter can attribute a merge to the App when the response is lost. The journal preserves that uncertainty until reconciliation. An unresolved attempt requires operator reconciliation.


### Implementation merge

G5 binds an implementation PR head SHA and verification manifest revision to the current Decision Record. The Host evaluates the installed Pack judge, checks both names of renamed paths, and checks the run's contract pins before requesting a merge. Manual mode requires the configured owner. Automated modes require trusted Pack risk data for the verified head, including `authorAgentId` and any `neverAutoMerge` hits. Assisted mode requires `riskLevel: "low"` and full-auto requires `evidenceComplete: true`.

The contract merge receipt and event carry the permanent contract ID and superseded commit from the trusted validator. Core tracks effective commits by project, contract ID and section. Freezing a contract holds all of its sections. After PE reassessment the Host calls updateContractPins with the paused run digest. An owner can then resume the run after the freeze is lifted and all pins are current.
