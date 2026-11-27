# Enable ADLC contract verification

G2 publishes the product section of a contract under `knowledge/contracts`. G3 and G4 publish its design and technical sections. The author opens a proposal PR for one gate from `contract/<type>-<slug>_<contractId>` to `main` and supplies its PR number to the publication node for that gate. PolyForge verifies the proposal and posts a commit status. A human or GitHub auto-merge merges the PR. The worker verifies the landed contract before recording a receipt. The legacy Host contract merge action has been removed.

## Configure the project

1. Install a GitHub App on the project repository with **Metadata read**, **Contents read**, **Pull requests read**, and **Commit statuses write**.
2. Store the App's private key in Paperclip Secrets. Set `githubApp.appId`, `githubApp.installationId`, and `githubApp.privateKeyRef` in the company's plugin configuration.
3. Under `adlcProjects.<projectId>`, set `repository` to `owner/repo`, `githubRepositoryId` to the numeric GitHub repository ID, and `ownerId` to the Paperclip project owner's user ID.
4. All three gates are disabled by default. Set `contractPublication.validatorId` to `adlc-g2-reference-v1` and set each gate you use to `true`. The G2 contract ID prefix defaults to `PRC-`. Override it with `contractPublication.contractIdPrefix` using an uppercase letter, up to nine additional uppercase letters or digits, and a trailing hyphen.
5. Seed the contracts root with `INDEX.json` containing an empty JSON array for a new repository. Set `contractsRoot` or `contracts_root` if the repository uses a custom root. Use the Pack's contract directory layout and English text for published paths and files.

| Gate | Enable flag | Commit status | Approval |
| --- | --- | --- | --- |
| G2 product | `contractPublication.g2` | `polyforge/contract-g2` | Configured owner approves the exact manifest revision through a Paperclip confirmation |
| G3 design | `contractPublication.g3` | `polyforge/contract-g3` | Configured human owner, or a design director in assisted or enabled full-auto mode with a passing frozen audit |
| G4 technical | `contractPublication.g4` | `polyforge/contract-g4` | Configured CTO agent set by `ctoId` |

For G2, the reference profile checks the PRD, `acceptance.feature`, optional `interaction-design`, generated `product/criteria.json`, `contract.lock.json`, and `INDEX.json`. A replacement keeps the original ID and folder. Each Gherkin scenario needs a unique `@AC-<number>` tag. G3 and G4 pin the current product receipt via `run.input.contract_pins` and publish their approved manifest deliverables. G3 preserves the interaction design approved at G2.

## Optional required check

After the App posts its first status, add or edit a ruleset or branch protection for `main`. Under **Require status checks to pass**, select the context for the gate from the table and set the expected source to the PolyForge GitHub App. Require a context directly when every PR covered by the rule is a proposal for that gate. [GitHub ruleset status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) · [GitHub branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

GitHub applies required checks to the target branch. On a mixed-use branch, require an operator-managed workflow check that runs on every PR. The check should pass ordinary PRs and require a successful App-sourced status for the matching gate on the exact head for proposals touching `knowledge/contracts/**`. Include both paths of a rename and use the configured root when it differs. Configure the workflow to re-evaluate when the status changes. A workflow skipped by a path filter can leave the required check pending. [GitHub required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

The worker also verifies merged bytes on repositories without branch protection. See [Contract verification and receipts](contract-verification.md) for queue states, recovery, and the deployment transport probe.

## G5 implementation merges

G5 binds the implementation PR head and verification manifest revision to the current Decision Record. Core combines the trusted Pack risk floor with a head-bound `implementation-risk` evidence item and requires successful CI immediately before the merge. Manual mode requires the configured owner. Assisted agent approval requires an independent CTO/CAIO, low risk, and complete review evidence. The trusted Host supplies the implementation merge adapter, its own credentials, and the PR author identity. Required CI covers the project's named checks, or every reported check if the project has no named checks.

Agent approval uses the latest completed `interrogate`, `deep-review`, `edge-cases`, and `security-review` attempts for that head. The G5 graph can also provide the equivalent combined evidence from `review-head`. Each blocking review must pass. Core forwards configured `ciPaths`, `riskRules`, and `neverAutoMerge` to the Pack's risk assessment. A never-auto-merge hit requires the configured owner. The receipt records the effective mode, risk, matched rules, review completeness, and whether agent approval was used.

Before using contract criteria, G5 checks that the index points to the folder from the latest receipt across all sections. It compares the lock digest and every file listed in the lock. For an older product receipt without a lock digest, G5 compares against the lock at that receipt's merge commit. A missing receipt, moved folder, edited or deleted file, or replayed lock blocks G5 with `contract-drift`. Restore the receipted bytes and index entry on main before opening a new proposal. See [receipt recovery](contract-verification.md).

Freezing a contract holds runs pinned to it. After reassessment, the trusted Host can update pins with the paused run digest. G5 requires a fresh decision, verification attempt, and review after a pin update.
