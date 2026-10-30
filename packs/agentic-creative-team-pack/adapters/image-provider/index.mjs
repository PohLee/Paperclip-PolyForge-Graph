export { createImageProviderAdapter } from '../concept-gallery/index.mjs';

export const IMAGE_PROVIDER_CONTRACT = Object.freeze({
  method: 'generateCandidates(request)',
  request: Object.freeze({ count: 'exactly 3, 4, or 5', brief: 'string or structured brief', explorationMode: 'string', referenceAssets: 'optional trusted paths' }),
  response: Object.freeze({ candidates: 'exact requested count of { id, imagePath, mimeType, provider: { id, model?, requestId? } }', decodedFormats: 'PNG is decoded by the built-in PNG verifier; JPEG and WebP require the host trusted image-decoder capability' }),
  constraints: Object.freeze(['candidate IDs are stable and unique within a set', 'images are static PNG, JPEG, or WebP rasters', 'preserve provider metadata per candidate', 'missing provider is a capability gap, never a textual or synthetic substitute']),
});
