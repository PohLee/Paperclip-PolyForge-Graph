# Temporary Agent acceptance — 2026-10-30

## Scope and versions

- Core candidate: **0.8.4**.
- ADLC candidate: **0.2.3**, verification Graph **0.1.5**.
- Marketing candidate: **0.0.3**.
- New Pack Core range: `>=0.8.4 <0.9.0`, with optional `temporary-agents` contract capability v1.
- Implementation and independent review used GPT-6 Sol with High reasoning.

The formal rules are in [temporary-agents.md](temporary-agents.md). Sub-Agent is a fresh native session; Shadow-Agent is a true native fork. Neither creates an organizational Agent. Independent review uses Sub-Agent. Legacy `shadow` declarations and records keep their stored schema and are displayed as Sub-Agent reviews.

Core 0.9.0 was considered during development, then changed to 0.8.4 because this extension is additive and existing immutable Packs declare `<0.9.0`. Earlier development Pack candidates were also assigned new versions after their compatibility metadata changed; the immutable-registration guard was retained.

## Verified behavior

- Local Core/plugin suite: 206 passed, 6 opt-in tests skipped.
- Real PostgreSQL: 5 passed, including atomic slot limits, concurrent claims, company isolation, leases, audit transitions, and the legacy review restart test. These ran in disposable schemas in the development database.
- Packs: 34 passed, including preservation of installed immutable releases.
- Build and worker JSON-RPC initialization passed.
- Independent final review found no remaining P0/P1 after fixes to ambiguous repair, busy stop requests, and child failure outcome handling.

### Docker acceptance

Paperclip `2026.1023.0` at `http://localhost:3312` ran the real plugin, database migration, issue checkout, native session creation, native heartbeat execution, and session cleanup. The child implementation was a deterministic process fixture. This validates host integration; it is **not** a live-model reasoning-quality or inherited-context test.

Successful restart acceptance:

| Evidence | ID/result |
| --- | --- |
| Company | `102d94df-b5e6-432f-af03-57440e026124` |
| Existing organizational Agent | `dd618a1d-cacf-42ab-b921-f1cff84ff1ec` |
| Native parent issue | `6dc561bf-3f50-4fdf-997b-ee182a83e6b0` |
| Parent execution | `d227e5aa-f6eb-4b02-906a-5cf4fff6f0dc` |
| Temporary execution record | `e4ffafb5-7e8b-49de-a63b-43256aef0f6f` |
| Child execution | `4b03188c-bc04-4f82-8343-ce6cd9051613` |
| Terminal result | `closed` / `completed` |
| Plugin reloaded while child active | Yes |
| Repeated identical delegation | One child for that parent execution |
| Organizational Agent IDs before/after | Unchanged |
| Child PolyForge mutation and recursive delegation | Denied |
| Requested Shadow-Agent without native fork | Rejected before session creation |

The fixture restores the original Agent adapter configuration and company policy. The parent finishes its native issue so Paperclip does not schedule an unfinished-task continuation. The pre-existing calculator product rejection remains recorded; this work does not authorize changing subtraction behavior.

Final deployment check: Core reports `0.8.4` / `ready`; the opt-in catalog retains `adlc@0.2.0`, `adlc@0.2.1`, and `marketing@0.0.1` alongside the new releases. Both test and calculator companies pass their existing Pack compatibility checks. All temporary test launches are closed, incomplete earlier fixture issues were cancelled, and company delegation policies were restored to disabled. The calculator rejection `77585a35-9512-4f49-96b0-3bc26a838c71` remains `rejected`.

### Defects discovered and corrected

- PostgreSQL required explicit parameter casts in the JSON audit expression; real database tests caught this.
- Global plugin jobs lack a company invocation scope. They now perform database reconciliation only. Company-scoped terminal events and authenticated reads complete native session operations.
- An interrupted create/send needs an explicit owner repair path. Repair never retries an uncertain host side effect blindly and records abandonment separately from confirmed cancellation.
- Busy stop/repair commands now return a retryable conflict instead of falsely reporting acceptance.
- A native process success containing a failed child report remains a failed delegation.
- The fixture initially caused duplicate parent wakeups/continuations. It now waits for the assignment-created run, waits for its child, and completes its issue.

## Remaining host limitations

1. **True Shadow-Agent execution is unavailable.** The pinned SDK has no native fork API. A contract and capability gate are implemented; a summary in a fresh session is never represented as a fork.
2. **Native permissions are inherited.** PolyForge blocks child Graph/company mutations, but the host does not expose session-scoped native credentials/tools. Read-only delegation is an instruction and plugin authorization boundary, not an OS or native-API sandbox.
3. **No native cancellation, write delegation, or metered child cost caps.** Stop suppresses result acceptance; the actual process ends separately. Unsupported write/cost requests are rejected.
4. **Missed events after restart require a scoped cleanup pass.** Database reconciliation can record `closing`; a later company event or authenticated company read performs native close. Unknown create outcomes require owner repair.
5. **Live UI screenshot QA was not completed.** The available browser had no authenticated Paperclip session. UI compilation and API/read-model behavior were checked.

These are explicit capability limits. This record does not assert that both temporary execution modes are fully operational or that unattended production use is fully validated.
