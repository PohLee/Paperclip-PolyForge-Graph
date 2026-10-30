# PolyForge Graph

PolyForge Graph executes versioned domain processes and retains the decisions and evidence behind each run.

## Language

**Pack**:
A published version of Graphs, roles, and decision rules for one domain. A run keeps the Pack version with which it began.

**Graph Run**:
One execution of a Graph using a pinned Pack and Graph version. Its node history remains available after completion, retry, or rework.

**Work Item**:
An action currently eligible in a Graph Run, including automatic transitions, agent work, and human decisions. Its eligibility follows the run's pinned decision rules.

**Dispatch Attempt**:
One assignment of a Graph node's work or independent review to a Paperclip agent execution. A retry creates another attempt while preserving the earlier one.

**Organization Plan**:
An authorized proposal for company reporting relationships, with the CEO coordinating domain leaders. Existing custom manager assignments are explicit conflicts to resolve.

**Decision Record**:
An append-only account of a decision's actor, outcome, reason, and supporting evidence. Later decisions can supersede a record without removing it.

**Pack Activation**:
A company's choice to use a particular installed Pack version. Different companies can choose different combinations of Packs.

**Pack Catalog**:
The versioned Packs available to a Paperclip instance. Availability in the catalog does not activate a Pack for any company.

**Shadow Task**:
An independently executed assignment created by a Graph or Agent for a bounded purpose. Its parent work and independent review responsibility remain traceable.

**Temporary Agent**:
A bounded execution delegated by an Agent for a specific task. The parent Agent remains responsible, and the execution does not become a new organizational Agent.

**Sub-Agent**:
A Temporary Agent started in a clean session from an explicit parent brief. Independent review uses a Sub-Agent so the reviewer does not inherit the author's conversation.

**Shadow-Agent**:
A Temporary Agent that starts with a fixed snapshot of its parent's work context and continues in an independent conversation. Later parent conversation is not automatically added.

**Context Snapshot**:
A recorded handoff of a parent's current objective, progress, conclusions, unresolved questions and supporting references, together with the authoritative decisions that constrain the delegated task. The handoff preserves the distinction between the parent's summary and recorded decisions.

**Goal Revision**:
One recorded version of a company or Agent objective and its measurable key results. Existing work retains the revision under which it began.

**Cross-Pack Work Plan**:
A coordinated set of work across enabled Packs, with accountable owners, priorities and dependencies.

**Plan Item**:
A piece of work in a Cross-Pack Work Plan, with a chosen Pack and Graph version, priority and dependencies. Its progress follows its associated Graph Run.

**Outcome Review**:
An assessment of observed results against a stated baseline, target and observation window. An unavailable measurement is an unknown result.
