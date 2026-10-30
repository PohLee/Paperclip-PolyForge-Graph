# Readiness and limits

This is a loadable Core Pack, not an activated creative runtime. The smoke test proves local pack import, Core registration, and host-wrapper run start; it does not dispatch agents or call external services. No production image-generation request was made for this release. Provider installation, authorization, browser rendering, image generation/decoding for JPEG/WebP, BE access, and design-source access remain host responsibilities. The wrapper rejects G03 when no authorized image provider is available and never substitutes placeholder media.

Pack artifact validation is enforced only when every transition uses `createCreativeHostApi()`. Direct Core calls bypass these pack-specific checks. Core does not automatically enforce the pack's artifact schemas, trusted artifact bytes, external-reference provenance, or image/gallery semantics. The host must also protect its own actor resolver, artifact store, decision-evidence resolver, and author-provenance service.

The source catalog and full pinned source snapshots are included under `sources/`; `sourceSnapshot` metadata, lock digest, commit IDs, licenses, and tree digests are included in the immutable Pack definition. Materialization and verification helpers do not install or execute upstream runtime scripts. Updating those sources is a separate reviewed pack change.

The ADLC boundary remains descriptive. No ADLC package was edited, no live bridge is registered, and no successful handoff is claimed. The handoff artifact can be consumed only by a separately built bridge after destination compatibility and permissions are verified.

An accepted graph result means its evidence gate and exact-reference checks passed for that run. Browser-facing helpers have DOM/script tests, but browser-based visual QA was not performed for this release. The result does not certify market evidence beyond supplied sources, rights clearance, production readiness, observed browser behavior, accessibility compliance, engineering feasibility, or user approval unless the corresponding evidence and reviewer are actually present. Incomplete and blocked outcomes remain valid run results.
