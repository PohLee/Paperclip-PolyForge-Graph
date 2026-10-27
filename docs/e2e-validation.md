# ADLC Pack and Paperclip validation — 2026-10-27

## Environment and build

- Paperclip Docker image: `ghcr.io/paperclipai/paperclip:2026.1023.0@sha256:40f46940c4612ead131aebe6079cd4651f8cd1434af49f7c621887f4a452a62e`; PostgreSQL `16.10-alpine`; authenticated private host at `http://localhost:3310`.
- ADLC Pack `adlc@0.1.0` is mounted from the separate `Paperclip-PolyForge-Graph-ADLC` repository. SHA-256 of its `index.mjs`: `4de29130f97b185d1d6c3659cdf91fd84f8b4e80c0d2c621b34cc67cd606dbee`.
- Full three-Graph Docker run used the plugin worker before the company default-mode change. A focused upgrade then installed plugin `0.1.1` and migration `002_default_mode.sql`. UI and tool-schema upgrades subsequently installed `0.1.2`, corrected `0.1.3`, and task-panel link fix `0.1.4`; the worker bundle did not change. Final built `dist/worker.js` SHA-256: `2a5960c32e04710b1914f43f07ffa965b863a2f0b1b25fbdf77088c9892d2038` (built 2026-10-27 07:38:11 UTC); final `dist/manifest.js`: `5d24c912a9eefd094febedfbdfc8803e8c5b888e4bb45c0e3af12084ef5cf95a` (built 2026-10-27 07:52:12 UTC); final `dist/ui/index.js` SHA-256: `5bc516d536aab3f529c825c26802ccc529f2be97c2c1c4fab3983edecf9717be`.
- The final worker source SHA-256 is `ae69e155e1c5da1d62edc6aca3475bb6b3d7600bd1924b8851ab26efeca0da83`; migration 002 SHA-256 is `7b55a3c37a4a7d6f89336727df2d31e3248232f4ba4956a68dea4926b3c639ae`.

## Automated checks

| Check | Result |
| --- | --- |
| `node --test tests/core/*.test.mjs` in the plugin repo | 19 passed |
| `node --test` in the ADLC Pack repo | 10 passed, including major Design branches, both visual lanes, prototypes, Implementation rework, and Verification outcomes |
| `node --check` for `scripts/e2e.mjs`, `scripts/e2e-fixture-agent.mjs`, `scripts/e2e-upgrade.mjs` | Passed |
| `node scripts/e2e.mjs` against Docker | Passed; restarted Paperclip and read durable Graph state |
| `node scripts/e2e-upgrade.mjs` against Docker | Passed; upgraded the installed plugin, applied migration 002, and restarted Paperclip |

The Docker fixture created its own company and root issue (`f86b26ce-01fa-4057-8e77-7119026bdea2`, `27f33722-cb94-4d38-960c-6e9cd20fff5a`). Paperclip itself spawned process agents with run-scoped API credentials. Each fixture process checked out its assigned child issue, read its pinned Graph context through the scoped API, and submitted deterministic artifacts or decisions. The harness checked the corresponding Paperclip heartbeat records had status `succeeded`.

| Graph route | Run | Result | Successful heartbeats |
| --- | --- | --- | ---: |
| UI/UX Design → minor → accept | `31a7cd01-8826-486f-8708-ec02490226fd` | Completed; four authenticated agent actions, duplicate submit/self-review callbacks had one effect | 5 |
| Implementation → gate rework → plan again → accept | `06c37ab7-54f7-4dbd-a730-18c801455672` | Completed; ten authenticated agent actions; plan had two retained attempts | 16 |
| Verification → fixed candidate → QA/security/regression ALL → accept | `c19450a5-0a17-4d0b-8dc9-4fd751edce22` | Completed; five authenticated agent actions | 5 |

The Design artifact identity was passed explicitly into Implementation; Implementation candidate artifact versions, test evidence, and acceptance decision were passed into Verification. The harness also retried an identical start command and checked that it returned the same run. Agent callbacks included a forged human actor in their bodies; stored decisions and attempts used the trusted Paperclip agent and run identity.

## Human decisions, retry, and durability

- A manual Design run remained at `classify-design` with no agent attempt. A separate manual run (`931dfb7e-b065-4757-b215-a81e6d519658`) recorded a human `none` classification with a reason, then completed. Decision `48dee5d6-47b4-4aa2-b0b6-962999c4a72f` retained the authenticated owner's identity after restart.
- Assisted Verification run `5be71931-41ee-4f6c-b7d9-c204cff3a916` waited at the human acceptance gate. The owner retried completed `qa` with a reason. Decision `bb439376-ba56-4ea2-9528-14846f1acb66` retained human identity and reason; QA attempt 1 and its artifact remained in history, attempt 2 produced a distinct artifact through a successful Paperclip heartbeat, and the run returned to the acceptance gate. Both attempts and the retry decision survived restart.
- After upgrading the installed plugin to `0.1.1`, company `defaultMode` was set to `manual` while preserving role and user bindings. A start command omitting `mode` created manual run `8875c08c-5e1f-4b3a-b2b0-1d7291c93298`. The default then changed to `assisted`; a restart preserved that setting. The earlier manual run remained manual, the completed autonomous run remained autonomous, and a new omitted-mode start created assisted run `fea7b479-1224-4999-ad28-c6c0e3e23108`. All retained Pack/Graph version `0.1.0`.
- The later `0.1.4` manifest upgrade returned HTTP 200 and plugin status `ready`. The existing completed Implementation run remained readable, completed, pinned to Pack `0.1.0`, and retained its two planning attempts. The full three-Graph run preceded the default-mode worker change; the focused upgrade test exercised that change, and the `0.1.2`–`0.1.4` UI and manifest upgrades left the worker unchanged. Browser UI smoke for the new slots is recorded separately below.

Ignored local evidence: `.e2e/result.json`, `.e2e/upgrade-result.json`, Paperclip's company/issue/run/heartbeat records in the Docker volumes. `.e2e/auth.json` and `.e2e/bootstrap.txt` contain test credentials and must not be published.

## Scope of this validation

The process agents are deterministic test fixtures; this run does not claim LLM reasoning quality. The Docker run followed the Design **minor** branch. The Design major branch, both four-candidate lanes, filtering, and optional prototypes were exercised through the 10 core-driven Pack tests, not through Docker. Market research, scheduling, and release execution are outside this MVP validation.

## Browser UI smoke

Chrome signed in through Paperclip's normal owner login at `http://localhost:3310` after the trusted-origin configuration was applied. In the fixture company (`POLAAAA`), the Graph runs sidebar link and the root task's **Open Graph** link both opened the routed page. The task link resolved to `/POLAAAA/graph-runs?issueId=27f33722-cb94-4d38-960c-6e9cd20fff5a` after the `0.1.4` fix; the page loaded eight saved runs for that issue, including the completed Implementation run `06c37ab7-54f7-4dbd-a730-18c801455672` pinned to `adlc@0.1.0`, with decision history and completed node statuses.

A running manual Design run displayed its pending `classify-design` decision with outcome, reason, and evidence fields, plus the node retry selector and reason field. The controls were inspected without submitting a second decision or retry; their authenticated actions were exercised in the Docker test above. The Graph start form displayed **Company default (assisted)**. Graph settings loaded **Assisted** with 11 agent role bindings and one human user-role binding. The browser recorded no warning or error logs during the final routed-page check.

Screenshots: `.e2e/browser-issue-graph-v0.1.4.png` (issue-scoped saved runs) and `.e2e/browser-ui-smoke.png` (manual decision and retry controls). These ignored local images contain no credentials.
