# Core integration

## Load and start

`index.mjs` exports a JSON-serializable `pack`, `loadPack()`, the callable artifact validators, and `createCreativeHostApi()`. Register the pack once with the current Core `GraphEngine`, then route all creative transitions through the host API. Direct `engine.submitNode()` or `engine.decideNode()` calls bypass pack enforcement.

```js
import { GraphEngine } from './src/core/index.mjs';
import { pack, createCreativeHostApi } from './packs/agentic-creative-team-pack/index.mjs';

const engine = new GraphEngine({ availableCapabilities: hostVerifiedCapabilities });
await engine.registerPack(pack);
const creative = createCreativeHostApi({
  engine,
  artifactRootForRun: run => hostArtifactRoot(run.id),
  resolveActor: hostAuthenticateActor,
  resolveDecisionEvidence: hostResolveDecisionEvidence,
  loadExternalArtifact: hostLoadImmutableArtifact,
  getArtifactProvenance: hostGetArtifactProvenance,
  hasImageProvider: hostHasAuthorizedImageProvider,
  decodeImage: hostDecodeRasterImage,
});

const run = await creative.startRun({
  packId: pack.id, packVersion: pack.version, graphId: 'creative-intake', mode: 'manual',
  actor: authenticatedActor, input: {},
});
```

Run `node packs/agentic-creative-team-pack/scripts/smoke.mjs` from the repository root to verify pack loading, Core registration, and host-wrapper run start with no production capabilities advertised. The smoke deliberately stops before dispatching an agent.

## Trusted host services

The wrapper fails closed when a required service is absent. `resolveActor({claimedActor, context})` must return the authenticated `{id, kind, roles, executionId}` from host identity; it must not trust model-supplied role or execution fields. `resolveDecisionEvidence({run,node,outcome,requiredKinds})` must return each required evidence kind with an exact versioned local `sourceRef` or a trusted immutable external reference. Actor and evidence claims in task payloads are not trusted.

`loadExternalArtifact({ref,kind,context})` returns the exact `{id,version,kind,digest,payload}` record, and concept sets also include a trusted `artifactRoot`. The digest is lowercase SHA-256 over UTF-8 JSON with recursively sorted object keys and array order preserved. `getArtifactProvenance(ref)` returns trusted author identities for external artifacts. The wrapper checks reference kind, identity, version, digest, and payload schema.

`artifactRootForRun(run)` supplies a private filesystem root. Image and gallery paths must remain inside it after realpath resolution. PNGs are decoded locally; JPEG and WebP require a trusted `decodeImage(bytes,mimeType)` service. For external concept sets, image files must be under the record's trusted artifact root. `hasImageProvider(id)` must verify an installed, authorized provider. A declared Core capability is a promise that the host can actually execute it; do not mark absent services available to make registration pass.

## Run API and enforced checks

Call `startRun`, then dispatch nodes returned by Core. Submit task outputs with `submitNode({runId,nodeId,actor,artifacts,payloads})`; artifact envelopes must match payload identity, and every graph-declared output is required. Use `decideNode({runId,nodeId,actor,outcome,reason})` for decision nodes. The wrapper checks explicit role decision rules and required evidence before Core records a decision. Join and end nodes accept no artifacts. Core remains responsible for graph readiness and transition recording.

The wrapper applies graph-specific checks:

- **G01** preserves facts, preferences, constraints, assumptions, and open questions in a validated creative brief.
- **G02** requires evaluated claim status and source references for supported factual claims before a baseline may be accepted; unsupported claims can route to evidence gaps.
- **G03** defaults to three candidates when count is omitted, rejects brief/top-level count conflicts, and permits only 3, 4, or 5. It requires an authorized image provider, actual raster bytes, exact branch count, a complete review, and a single canonical static gallery rendered by the trusted helper. Partial work can terminate incomplete or blocked; it cannot become gallery-ready.
- **G04** requires exact versioned concept set and human-owner preference references at start. The selected candidate ID, version, and image digest are preserved through interpretation, page map, desktop/mobile designs, review, and final package.
- **G05** pins the accepted baseline and exact version/digest of each supplied BE contract. The state matrix, contract review, feature design, handoff, independent review, and final package must carry those same refs.
- **G06** supports either an existing design baseline or an explicit brand-baseline/concept-selection bootstrap. Inventory and proposed changes must preserve that exact expected ref.
- **G07** requires pinned review subjects and trusted author execution provenance; the reviewer execution must differ from all subject authors.
- **G08** pins campaign and brand versions, asset package, review, and acceptance decision in its final package.

For final artifacts, the wrapper validates schemas and exact links against the run's actual completed artifacts and decisions. This makes the wrapper the required pack-specific enforcement boundary; JSON schemas alone are descriptive.

## Artifact and gallery helpers

Use `createInterviewArtifact()` and `validateInterviewArtifact()` for sourced intake records. Use `validateConceptSet()` and `validateStaticImage()` for image evidence; use `createSelection()` / `validateSelection()` for human preference records. `assembleGallery()` verifies raster metadata, path containment, and image digests, then stages one static gallery. See [`adapters/ARTIFACTS.md`](../adapters/ARTIFACTS.md). The loopback-only example preview is `node packs/agentic-creative-team-pack/scripts/preview-examples.mjs [--port N]`.

## ADLC boundary

`creative_design_handoff` is a versioned creative-side artifact only. This Pack does not register a bridge, mutate ADLC, claim successful transfer, or prove destination compatibility. A separately implemented bridge must validate the destination's live contract, permissions, references, and acceptance before dispatching anything to ADLC.
