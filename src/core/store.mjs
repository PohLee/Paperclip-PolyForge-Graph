import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const clone = (value) => structuredClone(value);

export class RevisionConflict extends Error {
  constructor() { super('Storage revision changed; retry the operation'); this.name = 'RevisionConflict'; }
}

/** A store supplies read() and write(state, expectedRevision). */
export class MemoryStore {
  #state = null;
  async read() { return this.#state === null ? null : clone(this.#state); }
  async write(state, expectedRevision) {
    if ((this.#state?.revision ?? 0) !== expectedRevision) throw new RevisionConflict();
    this.#state = clone(state);
  }
}

/** JSON snapshot store for a single writer process. Rename keeps snapshots intact on crashes. */
export class FileStore {
  constructor(path) { this.path = path; }
  async read() {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async write(state, expectedRevision) {
    const current = await this.read();
    if ((current?.revision ?? 0) !== expectedRevision) throw new RevisionConflict();
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await rename(temporary, this.path);
  }
}
