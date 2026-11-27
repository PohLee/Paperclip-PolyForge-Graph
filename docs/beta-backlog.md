# PolyForge post-beta backlog

These six items are deferred from beta. During beta, capture the workflow, the difficulty the user encountered and the workaround they used. Revisit each item after beta when its trigger is met. The first slices below are proposals for that decision.

## Inline annotation with version anchors

- **User problem.** Reviewers need to point to the exact passage behind their feedback and recover it when they open the review later.
- **Why defer.** Reliable anchors depend on a stable versioned artifact view, format-specific rendering and a way to handle anchors across revisions. Beta can establish which artifact formats and review tasks need that precision.
- **Beta trigger.** Reviewers repeatedly copy passages into comments or spend time locating feedback on revised artifacts. Record the artifact formats and where the existing feedback path lost context.
- **First usable outcome.** A reviewer can select a passage in a versioned Markdown artifact and leave a comment. Reopening the thread restores its exact artifact ID, version and quoted passage. The next version displays an older-version link when the anchor has no verified match. Scope the first slice to one artifact format and the existing review permissions. Acceptance still requires the existing decision path.

## Decision inbox discovery

- **User problem.** People who review multiple runs need to find the decisions awaiting them and open the right evidence and action quickly.
- **Why defer.** A separate inbox adds another place to check and creates work to reconcile routing, visibility and completion across surfaces. Paperclip's existing Inbox and native decision cards are the starting point.
- **Beta trigger.** Reviewers repeatedly miss or delay a decision after improving how the existing Inbox surfaces and links it. Record the specific gap, such as a cross-project view that the existing surface cannot provide.
- **First usable outcome.** Improve the existing Inbox entry, filters or decision links where the host supports them. If a gap remains, consider a read-only PolyForge summary for the affected group. Each item opens its canonical decision and evidence. The same record governs eligibility, completion and decision authority across surfaces.

## Plannotator viewer and follow-on MCP adapter

- **User problem.** Reviewers want to inspect a published plan alongside the PolyForge run, evidence and decision that refer to it.
- **Why defer.** Plan linking needs a dependable version and access boundary. Connecting an external review tool to agent workflows introduces a separate identity and capability decision.
- **Beta trigger.** Teams repeatedly exchange plans outside PolyForge and report losing track of which plan version they reviewed or where to act on it.
- **First usable outcome.** Open an authorized, read-only Plannotator view from one submitted plan artifact version, with a way back to the PolyForge record and its existing decision controls. Keep the version inspectable after a newer plan is submitted. A Plannotator MCP adapter is a separately scoped follow-on, contingent on a demonstrated agent-side need and a review of identity, offered capabilities and evidence lineage.

## Controlled dynamic graphs

- **User problem.** Some work needs a bounded number of branches or per-item checks based on information discovered during execution. Teams otherwise enumerate those steps manually or split the work in ways that make evidence hard to trace.
- **Why defer.** Dynamic work expands recovery, fan-out, budget and evidence rules. The existing plan predates workflow composition and needs to be reconciled with the current runtime before choosing the increment. [Controlled dynamic workflow implementation plan](controlled-dynamic-workflows-implementation-plan-2026-11-08.md)
- **Beta trigger.** A representative workflow repeatedly needs a runtime-dependent branch or item list that current versioned workflow composition cannot express cleanly. Capture its inputs, expected output, failure and restart behavior, and evidence requirements.
- **First usable outcome.** Prove one bounded conditional or single-level `foreach` in a preapproved, versioned workflow. Freeze any expansion list, preserve stable instance and attempt identities across retries, and retain the reason, limits and evidence for each executed branch or item. Pin the run to the approved definition and apply policy and acceptance gates throughout.

## Scoped human ownership roles

- **User problem.** A company needs to delegate decisions to the people accountable for a release, code area or service without giving each reviewer company-wide authority.
- **Why defer.** Human delegation affects routing as well as server-side authorization, revocation and decision audits. Beta can show which role and scope are needed first.
- **Beta trigger.** Company owners repeatedly proxy decisions or grant broad access so a release lead, code owner or service owner can perform a narrowly defined duty. Record which action, resource and person need delegation.
- **First usable outcome.** Pilot one action with one explicitly assigned human role. Candidate scopes are a project or release for **Release Owner**, a repository or code area for **Code Owner**, and a named service or environment for **Service Owner**. Verify active company membership, grant scope and decision snapshot when the action is taken. Record the named person, role, scope and evidence in the decision history. Role names and organizational reporting alone convey no authority.

## Accepted artifact Git export

- **User problem.** After accepting a plan, design or decision artifact, teams need a reproducible copy in Git alongside the work it governs, with a reference back to the exact approved version.
- **Why defer.** Git writes introduce destination permissions, version matching, secret handling and recovery after an ambiguous write. Beta can establish which accepted artifact teams actually copy and their preferred repository workflow.
- **Beta trigger.** Teams repeatedly copy the same kind of accepted artifact to Git manually, or report drift between the copy in Git and the version approved in PolyForge.
- **First usable outcome.** An authorized operator can preview and export one allowlisted Markdown artifact to a configured repository as a proposed change on a dedicated branch. Verify the accepted version and content digest at export time, and record the artifact version, acceptance reference, destination and resulting commit SHA in PolyForge. A retried export can reconcile the exact proposal. Merge and deployment retain their own independent controls.
