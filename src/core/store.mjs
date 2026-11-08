import { readFile, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { platform } from 'node:os';
import { randomUUID } from 'node:crypto';

const clone = (value) => structuredClone(value);
const fileQueues = new Map();

async function withFileLock(path, operation) {
  const previous = fileQueues.get(path) ?? Promise.resolve();
  let release;
  const current = new Promise((resolveLock) => { release = resolveLock; });
  const tail = previous.then(() => current);
  fileQueues.set(path, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (fileQueues.get(path) === tail) fileQueues.delete(path);
  }
}

async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalPath(parent), basename(path));
  }
}
const lockKey = path => platform() === 'win32' ? path.toLocaleLowerCase('en-US') : path;

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
  constructor(path) { this.path = resolve(path); }
  async read() {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async write(state, expectedRevision) {
    const canonical = await canonicalPath(this.path);
    return withFileLock(lockKey(canonical), async () => {
      let current;
      try { current = JSON.parse(await readFile(canonical, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; current = null; }
      if ((current?.revision ?? 0) !== expectedRevision) throw new RevisionConflict();
      await mkdir(dirname(canonical), { recursive: true });
      const temporary = `${canonical}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
        await rename(temporary, canonical);
      } catch (error) {
        // A failed rename/write must not leave abandoned snapshots behind.
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
  }
}
