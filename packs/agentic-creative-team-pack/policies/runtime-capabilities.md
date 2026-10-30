# Runtime capability contract

Core schedules Graph work and persists artifacts; it does not invoke agents, image providers, file writers, browsers, Figma, interview servers, or BE APIs. The host must advertise only capabilities it can actually dispatch and authenticate. Capability IDs used by this pack are `image-generation`, `image-inspection`, `html-file-write`, `design-rendering`, `project-source-read`, `be-contract-read`, `browser-render`, and `asset-production`.

The G03 concept-sprint requires a real image-generation provider and an HTML file writer. Successful output requires image files that decode and a single gallery that references them. If no authorized provider is present, the host returns a blocked capability result; no placeholder, text-only substitute, or fabricated image artifact may be submitted. G04 requires a real design renderer or an explicitly chosen editable design source. G05 needs source/API/permission evidence from the actual project and BE owner. G07 must distinguish static evidence from browser or accessibility observations.

Before dispatch, the host binds the node role to a trusted actor and invocation context. Before submission it calls `validateCreativeArtifact(kind,payload)`, checks storage paths and digests, and confirms capability-specific evidence. The callable validator and JSON Schemas are Pack-level contracts; Core currently validates only its own fixed schemas and will not infer these rules from Pack metadata.

Independent review nodes use Core `independentOf` execution identity constraints. The host must create a separate trusted execution/session for each reviewer and must not reuse author context or self-report identities from output payloads. Human concept selection must use authenticated human decision APIs; a gallery button alone is not an approval.

The ADLC bridge is a proposal-only compatibility boundary. This release does not register with ADLC, accept ADLC evidence, invoke an implementation graph, or claim a successful handoff. A host may export exact versioned artifact references for a separately reviewed bridge.
