# Shadow-Agent snapshot acceptance — 2026-10-30

## Delivered scope

Core **0.8.5** provides `temporary-agent-snapshot:1.0.0`. ADLC **0.2.4** and Marketing **0.0.4** require Core `>=0.8.5 <0.9.0` and declare the optional snapshot capability. Both Packs include the complete delegation guide as a skill assigned to every role.

- **Sub-Agent / fresh:** a new session with an explicit bounded brief; required for independent review.
- **Shadow-Agent / snapshot:** a new session of the same organizational Agent with a frozen, structured account supplied by the parent. It creates no organization position or additional Agent.
- Core adds authoritative Decision Records and matching company context from trusted state. Approved baselines and proposed, rejected, deferred and superseded history remain distinguishable. An advisory summary cannot replace a recorded approval or rejection.
- The snapshot is persisted before native session creation. Its company, parent execution, issue, available Graph scope, capture time and SHA-256 digest are bound together. Replay and restart reuse and verify that packet.
- Snapshot mode supports research and analysis on the current host. Native fork and Shadow-Agent independent-review requests are rejected before launch. No native fork interface was implemented.

See [Temporary Agents](temporary-agents.md) for the request format, authority model and host limits.

## Verification

| Check | Result |
| --- | --- |
| Core build, including worker initialization | Passed |
| Full Core suite | 215 passed, 6 opt-in tests skipped, 0 failed (221 total) |
| Real PostgreSQL temporary-agent tests | 2 passed |
| Real PostgreSQL Shadow launch recovery tests | 3 passed |
| Packs suite against this Core | 34 passed |
| Final catalog and collection checks | 6 passed |
| Independent GPT-6 Sol / High review | No remaining P0/P1 findings in the reviewed implementation |
| Docker snapshot session, replay and worker restart | Passed |
| Docker fresh Sub-Agent regression | Passed |

The independent review found and the implementation corrected three issues before acceptance: cross-feature product history leaking through a broader project match, snapshot state being read before subsequent native authority checks, and replay not comparing the receipt's capture time. Tests cover those cases, malformed and oversized input, digest/provenance tampering, and rejected replacements preserving the approved baseline.

### Docker snapshot scenario

Environment: `http://localhost:3312`, Compose project `polyforge-graph-enhancement`, with real Paperclip sessions and PostgreSQL persistence.

| Evidence | Value |
| --- | --- |
| Company | `102d94df-b5e6-432f-af03-57440e026124` |
| Existing parent and child Agent | `dd618a1d-cacf-42ab-b921-f1cff84ff1ec` |
| Issue | `3289b7c3-4070-4d84-aa93-b236f3419301` |
| Parent execution | `8ff6046d-dbe5-48e6-8b7c-29803ac9cd14` |
| Temporary launch | `89a7b450-726d-4d5b-b3e3-065f923fd296` |
| Child execution | `56a3b0f6-c277-41c8-bb48-ddca78b35ff1` |
| Captured at | `2026-10-30T07:42:37.488Z` |
| Snapshot digest | `sha256:c17b21249ec1e9e8ea7f45abeefe84e510a0d1e16f7bb44e5416921896559e94` |

The fixture supplied a deliberately conflicting advisory claim that changing subtraction to addition was approved. The child received both the original approved baseline (`818173fa-e978-4a1d-bd3f-7bd3ce7be472`) and rejected replacement (`a009a915-1ed8-4b6c-9f01-fcab912de0b5`) with their actual statuses. A later decision (`be293713-00aa-43d3-805b-c5e2d983b94b`) was added while the child was active and did not alter the frozen packet. Reloading the plugin during execution preserved the child identity and digest. Idempotent replay reused the existing delegation. The launch ended `closed` with outcome `completed`.

The fixture also checked that child company/Graph mutations, Shadow-Agent independent review, and native fork requests were denied. Company Agent IDs were unchanged.

The first snapshot attempt failed in the test harness: the plugin restart interrupted a negative policy probe, returning `Worker process exited` instead of the expected policy error. Its child completed, and the runner cancelled the parent issue and restored configuration. The harness now retries known transient worker errors only for reads or requests with an idempotency key. The complete snapshot scenario then passed on rerun.

### Fresh regression

Issue `79f25baa-eb28-4499-9f20-beb3bfb25298`, launch `569730c5-ccdf-40c1-813c-42354f6311b8`, child execution `ef7cd145-753b-4613-9297-db76af979e30`: fresh mode completed and closed successfully.

### Pack catalog and final environment

The final plugin reports **0.8.5 / ready**. Its catalog loads ADLC `0.2.0`, `0.2.1`, `0.2.3`, `0.2.4` and Marketing `0.0.1`, `0.0.3`, `0.0.4`.

Reconstructing the previous source releases initially exposed mixed LF/CRLF document bytes, and the immutable-version guard correctly refused the mismatched content. The prior release files were restored with their original document bytes and compared against all seven registered company copies before installation. No database Pack record or immutable-version check was changed. The restored release digests are:

- ADLC 0.2.3: `sha256:3a893af3d47f2a63441fa485b4eecbb972932587a68225552491281ed27732b1`.
- Marketing 0.0.3: `sha256:908eb32ae197852518ddc10505d53b6a565de2292a501284d7953948b970fb98`.

Installed historical release files remain deployment artifacts under ignored `dist/`; preserve those exact artifacts when moving environments. Regenerating an old version from a checkout with different line endings can change its digest.

The fixture restored the company's original disabled temporary-agent policy and existing process Agent configuration. The Agent is idle and there are no active temporary launches. Enabled company Pack versions remain ADLC `0.2.0` and Marketing `0.0.1`; installing new releases does not upgrade existing company bindings. The real calculator rejection `77585a35-9512-4f49-96b0-3bc26a838c71` remains `rejected` in its separate company.

## What this evidence establishes

The Docker checks use deterministic process fixtures. They establish real session creation, same-Agent identity, packet transport, policy enforcement, persistence, idempotency, restart recovery and cleanup. They do **not** establish that a live language model will always recognize a semantic contradiction or follow every instruction. No live LLM quality experiment was performed in this acceptance run. UI changes were compiled and their backing API data checked; no visual screenshot acceptance was performed.

The parent supplies its compact account; the plugin does not fetch or clone the full native conversation. The advisory account is limited to 8 KiB and the full packet to 256 KiB. Missing or oversized authoritative context blocks launch rather than silently dropping history.

The host still lacks session-scoped native tool permissions, native cancellation, delegated implementation writes and metered child cost enforcement. Read-only delegation is enforced at plugin authorization and prompt boundaries; the native Agent retains its configured operating-system permissions. Ambiguous native side effects require explicit owner repair. Scheduled reconciliation alone cannot finish native session cleanup without company invocation scope. These limits prevent treating this result as approval for unrestricted unattended production use.

## Reproduce

```powershell
node scripts/build.mjs
node --test tests/core/*.test.mjs tests/e2e/*.test.mjs tests/plugin/*.test.mjs
```

In the Packs checkout, set `PINNED_CORE_ARTIFACT` to the Core checkout and run `node --test test/*.test.mjs`. For Docker, use the configured authenticated development client with `scripts/e2e-temporary-agent-docker.mjs`, `POLYFORGE_TEMPORARY_MODE=snapshot` and `POLYFORGE_TEMPORARY_RESTART=1`; repeat with mode `fresh` and restart `0`. The runner requires an idle fixture Agent and restores its configuration and company policy.
