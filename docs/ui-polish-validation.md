# Graph workbench UI validation — 2026-10-27

## Build and scope

Paperclip at `http://localhost:3310` installed plugin `0.2.2` with status `ready`. The UI bundle SHA-256 is `41c7a77e8a6f7db9438c054b23d0ff7f7cf88545ffdc5f9e7a6b27e57ac6c311`; the worker bundle remained `2a5960c32e04710b1914f43f07ffa965b863a2f0b1b25fbdf77088c9892d2038`. Browser checks used the synthetic owner of fixture company `POLAAAA` and its existing eight Graph runs. No Graph decision, retry, settings change, or new run was submitted.

## Browser checks

| Check | Result |
| --- | --- |
| Run list and detail | Eight saved runs loaded. Completed Implementation run `06c37ab7-54f7-4dbd-a730-18c801455672` showed seven completed nodes and 24 decision records. Manual Design and assisted Verification runs showed their human decision forms. |
| Controls | New-run form exposed Graph, company default **Assisted** mode, and versioned JSON input. Decision outcome, reason, and evidence fields; retry node and reason fields; and node/history/technical disclosures opened. No actions were submitted. |
| Traceability | After the `0.2.2` correction, All nodes and current work show original IDs alongside readable names. The Implementation rework decision's history disclosure showed persisted evidence with candidate `subjectRefs`, its decision ID, and an explicit artifact empty state. Pending nodes are not counted as completed or labeled skipped. |
| Responsive and focus | Desktop and `390 × 844` browser viewport were checked. With evidence expanded at phone width, document `scrollWidth` was `382` for a `390` viewport. Keyboard Tab produced a visible 2 px focus outline. The temporary viewport override was reset. |
| Themes and errors | Light and dark views rendered. The host `.dark` class changed the plugin's semantic active/done/attention tokens; light active and done status text measured 6.62:1 and 4.70:1 contrast on white. Browser warning/error logs were empty. The synthetic account was returned to dark mode. |

The first browser pass found missing raw node IDs and stored evidence in the UI, plus inaccurate pending-route copy. These were corrected together in `0.2.2`; one desktop and narrow-screen confirmation pass verified the correction. `impeccable detect --json src/plugin/ui.jsx` returned no findings. This UI check verifies rendering and navigation; authenticated action and persistence behavior are covered in [e2e-validation.md](e2e-validation.md).

Ignored local screenshots: `.e2e/browser-issue-graph-v0.1.4.png` (before); `.e2e/graph-ui-after-desktop.png`, `.e2e/graph-ui-after-desktop-light.png`, `.e2e/graph-ui-after-mobile-dark.png`, `.e2e/graph-ui-after-mobile-light.png`, and `.e2e/graph-ui-after-mobile-action.png` (first polished build); `.e2e/graph-ui-confirm-evidence-v0.2.2.png` (final evidence disclosure). The images contain no credentials.
