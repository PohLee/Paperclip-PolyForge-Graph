# Decision Register — acceptance brief

Version: REQ-DECISION-REGISTER-1, v1

Build a small local web application for recording product decisions and change requests. This is a real implementation exercise for the ADLC Graph. The UI/UX Graph must produce inspectable design files; the Implementation Graph must produce runnable code and tests; the Verification Graph must execute and report independent checks against the exact candidate.

## Users and workflow

- A single local owner can create a product decision with a question, options, chosen option, reason, and time. The complete record stays readable after later decisions.
- The owner can create a change request that names an existing decision, describes a requested behavior change, and records an approval or rejection with a reason. A pending or rejected request cannot change the protected behavior.
- A user can view decisions, their history, change requests, and the current protected setting in a responsive browser UI. Errors, empty states, and keyboard focus are visible.

## Protected behavior

The application starts with `requireReasonForDecision=true`. An approved change request may set it to `false`; a pending or rejected request cannot. Every setting change must retain its authorizing request ID in persistent history. The UI and API must never silently edit an existing decision. Use server-side checks; hiding a button is insufficient.

## Acceptance checks

1. Create and list decisions; each has an immutable ID, creation time, question, options, choice, and reason.
2. Reject a decision without a reason while the protected setting is true. After a properly approved change to false, a reason may be omitted; the approval and setting change are traceable.
3. Create pending, reject, and approve change requests. A rejected or still-pending request leaves behavior unchanged.
4. Malformed requests return a useful 4xx response. Reloading the server retains decisions, requests, and setting history.
5. Automated API tests cover the protected behavior and persistence. A browser or DOM test covers at least one create/view flow and visible error/empty state.
6. The app runs locally without third-party credentials. Document exact install/start/test commands and the local URL.

## Delivery boundaries

Work only inside `/workspace/decision-register`. Keep implementation small: Node.js built-ins or a minimal dependency set are fine. Do not write to `.probe` or any Paperclip/plugin source. Put design alternatives and final design under `design/`, implementation under `src/`, tests under `test/`, and verification reports under `reports/`. Every Graph artifact should cite a real relative path and SHA-256 (or a git commit/hash) in its `id` and `version` metadata. Read the current file before review; do not claim a test passed unless you ran it. The Graph context provides current node, upstream artifacts, active product decisions, and callback instructions.

This brief is the approved requirement for this isolated exercise. Where it leaves a choice open, record a sourced work decision through the Graph before submitting the relevant artifact.
