import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { open, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { expect, vi } from 'vitest'
import type { StorageTestProbe } from '../../src/main/workflow-storage-probe.fixture'
import { runtime } from './runtime'
import { DB_NAME, metadataName, type Stats } from './protocol'

async function connection(path: string) {
  if (!metadataName(basename(path))) throw new Error('not canonical prototype metadata')
  const storage = await runtime(dirname(path))
  return new DatabaseSync(join(storage.directory, DB_NAME), { timeout: 0 })
}
async function readMetadata(path: string): Promise<string> {
  const db = await connection(path)
  try {
    const row = db.prepare('SELECT body FROM metadata WHERE name=?').get(basename(path))
    if (typeof row?.body !== 'string') throw new Error('missing canonical SQL metadata')
    return row.body
  } finally { db.close() }
}

export const storageProbe: StorageTestProbe = {
  publicationFailure: () => 'Error: FOREIGN KEY constraint failed',
  metadataFailure: 'FOREIGN KEY constraint failed',
  readMetadata,
  async replaceMetadata(path, text) {
    const db = await connection(path)
    try {
      // This is semantic-input corruption/legacy production, not the separate
      // hash-corruption probe. Keep the envelope hash valid to reach validation.
      const digest = createHash('sha256').update(text).digest('hex')
      db.prepare('INSERT INTO metadata VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body, hash=excluded.hash').run(basename(path), text, digest)
    } finally { db.close() }
  },
  async failMetadataOnce(path) { await (await runtime(dirname(path))).fault('constraint_commit') },
  async holdPublication(path, kind, fail = false) {
    const storage = await runtime(dirname(path))
    const previous = await readMetadata(path)
    const before = await storage.worker.request({ op: 'stats' }) as Stats
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockClear()
    vi.mocked(writeFile).mockClear()
    let syncs = 0, holding = false
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if ([storage.directory, dirname(path)].includes(String(args[0])) && args[1] === 'r') {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { syncs++; await sync() }
      }
      return handle
    })
    await storage.fault(fail ? 'hold_constraint_commit' : 'hold_commit')
    const reached = storage.worker.waitHeld().then(() => { holding = true })
    return {
      reached,
      async release() {
        if (holding) { await storage.worker.request({ op: 'release' }); holding = false }
      },
      restore: () => { vi.mocked(open).mockReset().mockImplementation(actual.open) },
      async expectHeld() {
        // Independent connection: the new authority must not be visible before
        // real COMMIT, even though the immutable artifact is already durable.
        expect(await readMetadata(path)).toBe(previous)
        if (kind === 'sequence') return
        const writes = vi.mocked(writeFile).mock.calls.filter(([target]) => String(target).endsWith('.tmp'))
        expect(writes).toHaveLength(kind === 'checkpoint' ? 1 : 0)
        for (const [, , options] of writes) expect(options).toMatchObject({ flush: true, mode: 0o600 })
        expect(vi.mocked(rename)).toHaveBeenCalledTimes(kind === 'checkpoint' ? 1 : 0)
        expect(syncs).toBe(kind === 'checkpoint' ? 1 : 0)
      },
      async expectSettled(failed = false) {
        if (kind === 'sequence') return
        const after = await storage.worker.request({ op: 'stats' }) as Stats
        expect(after.transactions - before.transactions).toBe(failed ? 0 : 1)
        expect(after.mutations - before.mutations).toBe(1)
        if (failed) expect(await readMetadata(path)).toBe(previous)
      }
    }
  }
}
