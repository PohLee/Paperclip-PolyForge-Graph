# Agentic Creative Team Pack

Standalone, versioned Core Pack for design and creative workflows. Version `0.1.0` supplies eight Core-compatible DAGs, 14 role definitions, 12 skills, evidence and artifact contracts, offline interview/gallery helpers, and a trusted host wrapper that enforces pack-specific checks against Core run state and real files.

The pack loads and registers locally. It does not install agents, activate itself, generate images, connect to browser/Figma/BE services, publish content, or register an ADLC bridge. A host must provide authenticated identity, capability dispatch, immutable artifact storage, and the trusted evidence services described in [Core integration](docs/integration.md).

## Graph catalog

| ID | Graph | Result |
| --- | --- | --- |
| G01 | `creative-intake` | Sourced brief and explicit route or information gap |
| G02 | `brand-foundation` | Reviewed brand strategy, identity, voice, and accepted baseline |
| G03 | `concept-sprint` | Three to five real static concepts and one comparison gallery |
| G04 | `concept-to-web-design` | Selected-concept-bound page map and full desktop/mobile design package |
| G05 | `saas-feature-design` | Baseline- and BE-contract-bound feature design with handoff and review |
| G06 | `design-system-evolution` | Reviewed design-system update against an existing or explicit bootstrap baseline |
| G07 | `design-assurance` | Independent review of exact pinned artifacts |
| G08 | `brand-campaign-assets` | Brand-bound campaign assets and reviewed final package |

Each graph contains only Core task, decision, all-join, and end nodes. Decision rules are explicit for all supported execution modes. G03 defaults to three concepts when no count is supplied; counts outside 3–5 and conflicting count inputs are rejected. An incomplete concept set cannot become gallery-ready.

## Role structure

`head-of-design` is the top role. `design-director` leads product design, while `creative-director` leads brand and art direction. Design research, product design, interaction design, systems, engineering, and QA report through the product-design branch. Brand strategy, identity, art direction, and voice report through the creative branch. `design-ops-producer` coordinates intake, traceability, and handoff. See [`roles/catalog.mjs`](roles/catalog.mjs) and the five role documents per role under `roles/`.

## Load and verify

From the repository root, load-smoke with no production capabilities advertised:

```powershell
node packs/agentic-creative-team-pack/scripts/smoke.mjs
```

This registers the pack in the current Core runtime and starts a G01 run through the host wrapper. It stops before agent dispatch. Run the pack's focused tests from its directory:

```powershell
cd packs/agentic-creative-team-pack
node --test tests/*.test.mjs tests/skills/*.test.mjs tests/source/*.test.mjs
```

The test suite includes current-Core registration/execution, real PNG-backed G03 completion at counts 3, 4, and 5, incomplete and reviewer-identity checks, and actual host-wrapper workflows for G04/G05/G06 with wrong-reference negatives.

## Offline helpers

The interview demo is a local static file. To preview it through the loopback-only, path-restricted helper:

```powershell
node packs/agentic-creative-team-pack/scripts/preview-examples.mjs
```

The command prints its local URL and serves only files under `examples/`; this release includes the interview demo and no separate gallery demo. For artifact creation, validation, and gallery assembly APIs, see [`adapters/ARTIFACTS.md`](adapters/ARTIFACTS.md).

## Runtime enforcement and provenance

Always route transitions through `createCreativeHostApi()` from `index.mjs`. It wraps Core `startRun`, `submitNode`, and `decideNode`; direct Core calls bypass pack checks. The wrapper validates exact artifact versions, decision evidence, accepted review links, image bytes, gallery rendering, selected-concept continuity, pinned BE contracts, and independent execution identity where applicable. The host supplies identity resolution, artifact and provenance loaders, decision evidence, image provider checks, and JPEG/WebP decoding. Those services are never assumed present just because capability IDs appear in metadata.

Full upstream source snapshots are bundled in `sources/upstream/`, with immutable commit, license, tree digest, and lock digest metadata in `pack.sourceSnapshot`. Source materialization uses the lock and verified snapshots; it does not run upstream hooks or scripts. The pack does not install these skills into a host.

See [`docs/limitations.md`](docs/limitations.md) for readiness boundaries and [`docs/integration.md`](docs/integration.md) for the host API contract. `creative_design_handoff` is a compatibility proposal only: this release does not change ADLC or claim an accepted handoff.
