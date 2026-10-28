// Run inside the isolated Paperclip container. Print structural usage evidence
// only; never print log text, prompts, tool arguments, credentials or snippets.
import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path?.startsWith('/paperclip/instances/default/data/run-logs/'))
  throw new Error('Specify an isolated Paperclip run log path');
const raw = await readFile(path, 'utf8');
const rows = raw.split(/\r?\n/).filter(Boolean);
const kinds = new Map();
const chunks = new Map();
let parsed = 0;
let usageStructured = 0;
let completed = 0;
let tokenSnapshots = 0;
let firstShape;
for (const line of rows) {
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  parsed++;
  if (typeof event.stream === 'string' && typeof event.chunk === 'string')
    chunks.set(event.stream, `${chunks.get(event.stream) ?? ''}${event.chunk}`);
  firstShape ??= Object.fromEntries(Object.entries(event).map(([key, value]) =>
    [key, value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value]));
  const kind = event.eventType ?? event.type ?? event.kind ?? '(none)';
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  const payload = event.payload ?? event.data ?? event.message;
  if (event.eventType === 'usage' || event.type === 'usage' || payload?.kind === 'usage') usageStructured++;
  if (['turn.completed', 'run.completed', 'task_complete'].includes(kind)) completed++;
  if (typeof payload?.usage?.inputTokens === 'number' || typeof payload?.usage?.outputTokens === 'number') tokenSnapshots++;
}
const nested = {};
for (const [stream, content] of chunks) {
  const types = new Map();
  let jsonLines = 0;
  let usageEvents = 0;
  let completedEvents = 0;
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    jsonLines++;
    const kind = event.type ?? event.eventType ?? event.kind ?? '(none)';
    types.set(kind, (types.get(kind) ?? 0) + 1);
    if (event.usage || event.token_usage || event.item?.type === 'usage') usageEvents++;
    if (['turn.completed', 'run.completed', 'task_complete'].includes(kind)) completedEvents++;
  }
  nested[stream] = { bytes: Buffer.byteLength(content), jsonLines, types: Object.fromEntries(types),
    usageEvents, completedEvents };
}
console.log(JSON.stringify({ bytes: Buffer.byteLength(raw), lines: rows.length, parsed,
  firstShape, kinds: Object.fromEntries(kinds), usageStructured, completed, tokenSnapshots, nested }));
