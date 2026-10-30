# Architecture follow-up — 2026-10-30

## Authorized scope

The user approved all three candidates from the architecture review at Core commit
`d0680c9`, with implementation and verification by GPT-6 Sol / High subagents.
The previous [architecture decisions](architecture-deepening-2026-10-30.md)
remain in effect. This change preserves public commands, authorization,
append-only Decision Records, immutable Pack identities and pinned Graph Runs.

### A. Creative Artifact Lineage

Concentrate the relationships between current, selected, pinned and reviewed
artifact versions behind an internal module used by the Creative host interface.
Retain schema validation and trusted external artifact/image adapters.

The review reproduced a concrete failure through the actual GraphEngine and
public Creative host interface: current campaign assets and review were `v1`,
but a final package referencing valid external `v0` records with the same IDs
was accepted. Fix this with public-interface positive and negative regressions,
including proof that a rejected submission does not advance the Graph or store
the invalid final artifact.

### B. Human Decision Handoff

Concentrate native card identity/reuse, trusted answer processing and provenance
without turning Product, Graph and Company decisions into one configurable rule
framework. Preserve their different recipients, reason requirements, evidence,
deferral keys, invalidation rules, idempotency keys and dispatch timing. Core
continues to decide whether a decision is authorized and applicable.

### C. Context Receipt

Concentrate receipt creation and durable source/snapshot checks across initial
send, recovery, replay and owner repair. Retain the Core contract validator,
fresh versus snapshot behavior and the fixed snapshot digest and capture time.
No native fork, store migration or public contract change is part of this work.

## Design constraints

- Keep Temporary Agent and legacy Graph Shadow Task lifecycle semantics
  separate: their slot, stop and result-acceptance rules differ.
- Keep the existing Pack Registry and Cross-Pack Work Plan modules.
- Test through the existing host/runtime interfaces with actual Core behavior;
  use real PostgreSQL for durable execution and the existing development Docker
  for native-session regression.
- Preserve the calculator experiment's recorded rejection and restore temporary
  fixture configuration after Docker verification.
- Independent final review uses the accepted scope and diff, without relying on
  the implementation agents' conversation.

## Verification results

All three improvements are implemented in Core/plugin `0.8.6`. Public commands,
capability contracts, persisted schemas and Pack payloads are unchanged. The
external Packs repository required no changes.

### Implemented boundaries

- `runtime/artifact-lineage.mjs` owns Creative artifact version relationships.
  Campaign reviews must reference current assets, and final packages must
  reference the current assets and review. Selected concepts, pinned inputs and
  the review-to-assets relationship remain enforced. A rejected submission
  creates no attempt, artifact or Graph advancement.
- `src/plugin/decision-handoff.mjs` owns native issue/card reuse, authenticated
  human answers and provenance receipts. Product, Graph and Company callers
  retain their domain-specific authorization, reason and continuation rules.
- `src/plugin/temporary-agent-receipt.mjs` owns launch context validation and
  receipt construction for send, reconciliation, replay and owner repair.
  Snapshot digest, capture time and native session/execution bindings remain
  immutable; fresh sessions cannot carry a snapshot.

### Automated checks

| Check | Result |
| --- | --- |
| Core, E2E and plugin tests | 221 passed, 6 skipped, 0 failed (227 total) |
| Creative Pack complete suite | 49 passed, 0 failed |
| External Packs against Core 0.8.6 | 34 passed, 0 failed |
| Real PostgreSQL durable execution/recovery | 5 passed, 0 failed |
| Build and bundled worker initialization | Passed |
| Diff whitespace check | Passed |

The six skipped tests in the ordinary Core command are the opt-in full Paperclip
MVP Docker sweep and five PostgreSQL cases. All five PostgreSQL cases were run
separately in Docker and passed. The full legacy MVP Docker sweep was not rerun.

Reproduction commands:

```powershell
node --test tests/core/*.test.mjs tests/e2e/*.test.mjs tests/plugin/*.test.mjs
node scripts/build.mjs
# From the sibling Packs repository root:
node --test packs/adlc-creative-team-pack/tests/*.test.mjs packs/adlc-creative-team-pack/tests/skills/*.test.mjs packs/adlc-creative-team-pack/tests/source/*.test.mjs
# From the external Packs repository, with PINNED_CORE_ARTIFACT set to this Core:
node --test test/*.test.mjs
```

### Development Docker evidence

Verified against the existing Paperclip instance at `http://localhost:3312`
(`polyforge-graph-enhancement-paperclip-1`), running plugin `0.8.6`.

1. **Creative lineage:** the campaign public-host regression ran inside Docker
   using the actual GraphEngine. Stale asset and stale review versions were
   rejected separately; matching current versions completed successfully.
   Result: 3 tests passed, including two subtests.
2. **Human Decision Handoff:** a synthetic issue passed through a native human
   decision card, defer, successor card, reject and repeated reconciliation.
   Exactly two cards, one defer and one rejection were persisted. The baseline
   remained unchanged and replay was idempotent. Issue:
   `482af421-4702-482b-9600-ab275c5b57b9`; rejection:
   `786df236-d6a6-431a-90df-6ac26980a0f9`.
   Runner: `scripts/e2e-decision-handoff.mjs`.
3. **Shadow-Agent / snapshot:** launch
   `2f9c4094-2af0-4a14-9ac8-a99731b175d7` completed after a runtime restart.
   Parent and child used separate native sessions under the same organizational
   Agent. A subsequent decision change did not alter the captured snapshot.
   Digest:
   `sha256:2351dda5f1b5e1d83f6ad0d9e2acd19100fc5a95a6bb9d41deed1c057265a288`.
   The fresh-mode regression also completed: launch
   `b6ba2a54-962b-4d93-a565-ec610db3979b`.
   Runner: `scripts/e2e-temporary-agent-docker.mjs`, using snapshot/restart and
   fresh/no-restart modes respectively.

After verification, temporary policy and Agent configuration were restored:
policy disabled, zero active temporary launches, fixture Agent idle, plugin
ready. The original calculator rejection
`77585a35-9512-4f49-96b0-3bc26a838c71` remains rejected. Calculator code and the
other Docker environment on port 3313 were not changed.

### Independent review and repair

GPT-6 Sol / High agents reviewed changes they did not implement, using the
accepted scope and diff. Review found one P2 issue: rechecking a stored snapshot
against the current wall clock could reject a valid receipt after clock rollback.
A public runtime regression reproduced the failure before the repair.

Temporal validation now compares capture time with the durable request time.
New launches record that time before claiming execution, preserving rejection of
future captures. Existing records without request time remain compatible. The
reviewer reran the focused suite (16 passed) and confirmed the issue closed.
No actionable P0/P1/P2 findings remained in the final reviews.

### Evidence limits

The Docker sessions use deterministic fixture execution; these checks do not
measure live model reasoning quality. The human-card experiment uses synthetic
development data and does not approve a real product change. Creative verification
uses the public host interface with a trusted-source test adapter, not a Creative
Pack organization installation or a live ADLC-to-Creative handoff. Native session
fork remains unavailable and is outside this change; Shadow-Agent uses snapshot.
