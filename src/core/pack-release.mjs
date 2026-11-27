import { createHash } from 'node:crypto';
import { canonical } from './canonical.mjs';

const sha256 = json => `sha256:${createHash('sha256').update(json).digest('hex')}`;

// The release block is excluded from both supported Pack payload encodings.
export function assertPackReleaseDigest(pack) {
  const { release, ...payload } = pack;
  const digest = release?.digest;
  if (digest && (digest === sha256(JSON.stringify(payload)) || digest === sha256(canonical(payload)))) return;
  throw new Error('Immutable release digest does not match Pack payload');
}
