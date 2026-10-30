# Interview and concept gallery adapters

These adapters are dependency-light ESM helpers for local artifacts. The static HTML tools do not upload or persist data on a server.

## Interview

`adapters/interview/index.mjs` exports `renderInterviewHtml(questionnaire)`, `createInterviewArtifact({ id?, questionnaire, answers, source?, revision?, requirements?, history?, createdAt? })`, `validateInterviewArtifact(value)`, `projectRequirements(artifact)`, and `INTERVIEW_ARTIFACT_SCHEMA`. The canonical `interview_responses` shape is `{ id, kind, questionnaire: { id, version }, revision, createdAt, source, answers, requirements, history }`. Raw `answers` preserve `questionId`, original `value`, response `source`, optional explicit `requirementKind`, and `updatedAt`. Each prior edit is kept as a history snapshot with its revision, captured time, answers, and requirements. The browser JSON import/export uses this same shape. It rejects a questionnaire ID or version mismatch; a changed questionnaire needs an explicit migration before import.

Questionnaires use an ID, version, and question list; supported fields are `text`, `textarea`, `select`, and `checkbox`, with optional `when: { questionId, equals }` conditions. `requirementKind` may explicitly be `fact`, `preference`, `constraint`, or `assumption`; absent classification stays `unclassified`. Empty or explicit English/Chinese uncertainty answers become `unknown`. A false checkbox remains a valid negative answer. The generated page labels controls, saves and restores in browser local storage, and exports the canonical raw answers as JSON or a requirements Markdown projection. Storage failures are displayed. Imports and exports are local files.

The JSON artifact keeps each raw answer and its source separate from the `requirements` array. The projection uses only an explicit question `requirementKind` (`fact`, `preference`, `constraint`, or `assumption`); otherwise it labels the response `unclassified`. Blank and recognized uncertain answers are explicit `unknown` entries, while a false checkbox remains an ordinary negative answer. Downstream synthesis should add inferred requirements separately with evidence references.

Generate the reviewer demo with:

```sh
node packs/agentic-creative-team-pack/scripts/demo-interview.mjs
```

It writes `examples/interview-demo.html` from `templates/interview/questionnaire.json`.

## Gallery

`adapters/concept-gallery/index.mjs` exports `CONCEPT_SET_ARTIFACT_SCHEMA`, `CONCEPT_SELECTION_SCHEMA`, `validateConceptSet`, `validateSelection`, `createSelection`, `inspectStaticImage`, `validateStaticImage`, `renderGalleryHtml`, and `assembleGallery`. A set has exactly its requested 3, 4, or 5 candidates. Each candidate includes a version, title, thesis, short description, choices, fit, tradeoff, static raster image metadata, provider metadata, and source references.

`assembleGallery({ conceptSet, sourceDir, outputDir, title?, decodeImage? })` requires image paths relative to `sourceDir`. It checks that source realpaths stay inside that directory, validates PNG chunks and pixel data with a built-in decoder, and checks JPEG/WebP structure, dimensions, and SHA-256. JPEG and WebP require a trusted host `decodeImage(bytes, mimeType)` capability that returns decoded `{ width, height }`; structural checks alone are not treated as proof that those files decode. It stages the complete bundle and replaces the output directory only after every candidate passes validation. Source and output directories must not overlap. Image validation fails closed for unsupported MIME types, mismatched digests or dimensions, malformed assets, path escapes, symlink targets, and duplicate IDs, paths, or image bytes. PNG interlacing is currently unsupported. A 20-megapixel and 100 MB input limit bounds raster decoding work.

`createSelection({ set, candidateId, selectedBy, reason?, disposition?, id?, version?, createdAt? })` returns a versioned `concept_selection` record with `id`, `kind: "concept_selection"`, and `version` (default `1.0.0`). The default disposition is `preference`; the helper rejects acceptance dispositions, and `validateSelection(selection, set)` requires the exact current set revision, candidate version, and image digest. `CONCEPT_SELECTION_SCHEMA` describes this registered record shape.

The gallery is a static image comparison page with zoom, comments, preference recording, and JSON import/export. It records a preference against the exact set revision, candidate version, and image digest; it never reports acceptance. A combination request is stored as `type: "combine"` with `approved: false`, so a new combined candidate still needs to be produced and selected separately.

`adapters/image-provider/index.mjs` exposes the provider adapter and request contract. Without a host provider, it returns a capability gap. A configured provider must return exactly the requested number of unique candidate IDs; this adapter never substitutes mock images or claims images were generated.

## Local preview

Run `node packs/agentic-creative-team-pack/scripts/preview-examples.mjs` to serve only the pack's `examples/` directory on `127.0.0.1`. The operating system chooses an available ephemeral port by default. Pass `--port 8080` to select a port. The server rejects traversal, symlink escapes, non-file requests, and methods other than GET/HEAD; it does not bind to a network interface or expose the repository.

The demo HTML is an interview artifact only. No user product brief or suitable reference raster assets were supplied for this implementation, so no gallery preview is presented as a generated concept. Browser visual QA was not performed: the available browser tool explicitly blocked `file://` and prohibited reaching that same page through another browser route. Script behavior is covered by an isolated DOM harness. JPEG and WebP still require the host decoder capability described above.
