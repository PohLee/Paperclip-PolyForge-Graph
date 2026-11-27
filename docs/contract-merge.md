# Enable ADLC G2 contract verification

G2 publishes product contracts under `knowledge/contracts` on `main`. The configured project owner approves the exact manifest revision through a Paperclip confirmation. The author opens a proposal PR from `contract/<type>-<slug>_<contractId>` to `main` and supplies its PR number to `publish-baseline`. PolyForge verifies the proposal. A human or GitHub auto-merge merges it.

## Configure the project

1. Install a GitHub App on the project repository with **Metadata read**, **Contents read**, **Pull requests read**, and **Commit statuses write**.
2. Store the App's private key in Paperclip Secrets. Set `githubApp.appId`, `githubApp.installationId`, and `githubApp.privateKeyRef` in the company's plugin configuration.
3. Under `adlcProjects.<projectId>`, set `repository` to `owner/repo`, `githubRepositoryId` to the numeric GitHub repository ID, and `ownerId` to the Paperclip project owner's user ID.
4. G2 is disabled by default. Set `contractPublication.g2` to `true` and `contractPublication.validatorId` to `adlc-g2-reference-v1`. The ID prefix defaults to `PRC-`. Override it with `contractPublication.contractIdPrefix` using an uppercase letter, up to nine additional uppercase letters or digits, and a trailing hyphen.
5. Seed the contracts root with `INDEX.json` containing an empty JSON array for a new repository. Set `contractsRoot` or `contracts_root` if the repository uses a custom root. Use the Pack's contract directory layout and English text for published paths and files.

The reference profile checks the PRD, `acceptance.feature`, optional `interaction-design`, generated `product/criteria.json`, `contract.lock.json`, and `INDEX.json`. A replacement keeps the original ID and folder. Each Gherkin scenario needs a unique `@AC-<number>` tag.

## Optional required check

After the App posts its first status, add or edit a ruleset or branch protection for `main`. Under **Require status checks to pass**, select `polyforge/contract-g2` and set the expected source to the PolyForge GitHub App. Enable this directly when every PR covered by the rule is a G2 proposal. [GitHub ruleset status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) · [GitHub branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

GitHub applies required checks to the target branch. To enforce G2 only for PRs touching `knowledge/contracts/**` on a mixed-use branch, require an operator-managed workflow check that runs on every PR. The check should pass ordinary PRs and require a successful App-sourced `polyforge/contract-g2` status on the exact head for contract PRs. Include both paths of a rename and use the configured root when it differs. Configure the workflow to re-evaluate when the status changes. A workflow skipped by a path filter can leave the required check pending. [GitHub required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

The worker also verifies merged bytes on repositories without branch protection. See [G2 verification and receipts](contract-verification.md) for queue states, recovery, and the deployment transport probe.

## G5 implementation merges

G5 binds the implementation PR head and verification manifest revision to the current Decision Record. Core combines the trusted Pack risk floor with a head-bound `implementation-risk` evidence item and requires successful CI immediately before the merge. Manual mode requires the configured owner. Assisted agent approval requires an independent CTO/CAIO, low risk, and complete review evidence. The trusted Host supplies the implementation merge adapter, its own credentials, and the PR author identity. Required CI covers the project's named checks, or every reported check if the project has no named checks.

Agent approval uses the latest completed `interrogate`, `deep-review`, `edge-cases`, and `security-review` attempts for that head. The G5 graph can also provide the equivalent combined evidence from `review-head`. Each blocking review must pass. Core forwards configured `ciPaths`, `riskRules`, and `neverAutoMerge` to the Pack's risk assessment. A never-auto-merge hit requires the configured owner. The receipt records the effective mode, risk, matched rules, review completeness, and whether agent approval was used.

Before using contract criteria, G5 checks that the index points to the folder from the latest receipt across all sections. It compares the lock digest and every file listed in the lock. For an older product receipt without a lock digest, G5 compares against the lock at that receipt's merge commit. A missing receipt, moved folder, edited or deleted file, or replayed lock blocks G5 with `contract-drift`. Restore the receipted bytes and index entry on main before opening a new proposal. See [receipt recovery](contract-verification.md).

The legacy trusted Host merge action handles design and technical publication and records the folder and lock digest from the landed commit. It uses the Host's merge credentials. G2 uses the read and status-write App configuration above.

Freezing a contract holds runs pinned to it. After reassessment, the trusted Host can update pins with the paused run digest. G5 requires a fresh decision, verification attempt, and review after a pin update.
