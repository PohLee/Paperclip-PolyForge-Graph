# Temporary Agent recovery, Pack Activation and release verification

The 19 November follow-up review began with the working tree at `f998cb9`, including the earlier decision-card, organization and dispatch changes. Each package had a separate GPT-6.2 Sol implementation agent using high reasoning.

| Work package | Owner | Acceptance |
| --- | --- | --- |
| Temporary Agent recovery | `receipt_fix` | Automatic recovery and owner repair agree on native execution and session evidence. A contradictory or ambiguous match cannot issue a Context Receipt. Missing evidence requires the appropriate owner decision. Recovery sends no second message. |
| Pack Activation in New run | `activation_fix` | An explicit empty activation list offers no release or start action. Only an exact installed and enabled version is selectable. Submitting an obsolete choice rechecks current company activation. A response from a legacy host that omits the list has separate compatibility coverage. |
| Pack release digest | `release_fix` | Core registration and composition-host acceptance agree on a legacy JSON digest and a canonical JSON digest even with different object key order. Both reject tampered content. Artifact, archive and adapter checks keep their own identity rules. |

## Completed behavior

**Context Receipt.** Automatic recovery and owner repair now read the same scoped native heartbeat evidence. A unique heartbeat may be attached automatically only when the recorded session matches. A missing session association can be attested by the owner. A contradictory association or multiple matching executions stays unresolved. The direct acknowledgement of a successful send and the existing receipt validation for pinned snapshots still follow their original paths. See [Temporary Agent operations](temporary-agents.md).

**New run.** The form filters installed Packs by exact activated ID and version. An empty activation list opens an enablement prompt linked to Company operations. Older hosts that omit the field retain their catalog fallback. If the company switches versions while the form is open, refreshing clears the obsolete selection and requires a new choice. Worker-side validation checks the current activation on submission; an existing Graph Run remains pinned.

**Release verification.** Core registration and the workflow composition host use the same SHA-256 release check. It excludes the `release` block, accepts either the original JSON serialization or canonical object-key order, and preserves array order. Core accepts a Pack without a release block. Composition-host acceptance requires a valid release. See the [Core contract](../src/core/contract.md).

## Integration evidence

- A headless Chromium fixture rendered the built `IssueGraphTab` with Paperclip's React and simulated Graph responses. Before the fix, an empty activation list displayed two installed versions. The final form displayed no versions or submit action, offered one older version when it alone was enabled, submitted that exact version and preserved the omitted-field fallback. A refresh after a version switch cleared both selected values and disabled Start.
- A PostgreSQL transaction exercised the production evidence query against a session-local heartbeat table. The cases covered another company with the same task key, a missing session association, a matching wake session, contradictory message and wake sessions, and duplicate eligible executions. The runtime tests separately checked receipt creation, owner attestation and the send count.

## Release review and verification

Independent review found two gaps in the first preflight implementation. Structural equality ignores object key order, which matters to the legacy digest. The host now checks the archived and mounted payloads independently. The host also previously read a convenience export that could differ from the Pack the runtime loaded. Preflight now uses the runtime catalog loader, compares the exact ID and version inventory, and checks each mounted Pack against its archived snapshot. Regression fixtures cover changed key order on either side, contradictory module exports, and missing or extra versions.

| Verification | Result |
| --- | --- |
| Full Node test suite | 455 tests discovered, 445 passed, 10 opt-in tests skipped, 0 failed. |
| PostgreSQL integration selection | 37 passed, including all nine opt-in PostgreSQL cases. The selection overlaps the default suite. |
| Independent re-review | All 15 release-candidate tests passed. Core registered each of the three archived and mounted Pack versions. The reviewer confirmed both findings were closed. |
| Build and startup | `node scripts/build.mjs` succeeded and the bundled worker initialized over JSON-RPC. |
| Packaged host preflight | Verified the freshly packed Graph 0.8.10 tarball against the build and the adjacent Packs entry. The archive SHA-256 was `0a137f6b3d4531b9a9998a3a66629709ecc21d44017d326bc417da8b2a7be569`. The matched releases were ADLC 0.3.3, Marketing 0.0.5 and Creative Team 0.3.3. |

The legacy three-Graph Docker scenario and a full workflow composition run were outside this verification. The service on `localhost:3310` was not redeployed.
