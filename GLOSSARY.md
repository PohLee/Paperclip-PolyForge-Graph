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
An owner-approved proposal to align plugin-managed ADLC agents' reporting relationships with the Pack. Existing custom manager assignments are conflicts rather than changes to apply.

**Decision Record**:
An append-only account of a decision's actor, outcome, reason, and supporting evidence. Later decisions can supersede a record without removing it.
