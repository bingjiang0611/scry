import { open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, vi } from 'vitest'

// Test-only physical probes. The opt-in SQLite config supplies its own driver;
// neither Store business validation nor production registration selects one.
export type PublicationKind = 'root' | 'checkpoint' | 'sequence'
export type PublicationGate = {
  reached: Promise<void>
  release(): Promise<void>
  restore(): void
  expectHeld(): Promise<void>
  expectSettled(failed?: boolean): Promise<void>
}
export type StorageTestProbe = {
  publicationFailure(kind: PublicationKind): string
  metadataFailure: string
  readMetadata(path: string): Promise<string>
  replaceMetadata(path: string, text: string): Promise<void>
  failMetadataOnce(path: string): Promise<void>
  holdPublication(path: string, kind: PublicationKind, fail?: boolean): Promise<PublicationGate>
}
const publicationFailure = (kind: PublicationKind) => kind === 'root' ? 'held root directory sync failed'
  : kind === 'sequence' ? 'fixture terminal sequence directory sync failure' : 'directory sync failed'

export const storageProbe: StorageTestProbe = {
  publicationFailure,
  metadataFailure: 'frame rename failed',
  readMetadata: path => readFile(path, 'utf8'),
  replaceMetadata: async (path, text) => { await writeFile(path, text) },
  async failMetadataOnce(path) {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockImplementation(async (...args) => {
      if (String(args[1]) === path) {
        vi.mocked(rename).mockImplementation(actual.rename)
        throw new Error('frame rename failed')
      }
      return actual.rename(...args)
    })
  },
  async holdPublication(path, kind, fail = false) {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let release!: () => void, reached!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { reached = resolve })
    let syncs = 0, armed = true
    vi.mocked(rename).mockClear()
    vi.mocked(writeFile).mockClear()
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (String(args[0]) === dirname(path) && args[1] === 'r') {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          if (armed) {
            armed = false; syncs++; reached()
            await held
            if (fail) throw new Error(publicationFailure(kind))
          }
          await sync()
        }
      }
      return handle
    })
    return {
      reached: started,
      release: async () => { release() },
      restore: () => { vi.mocked(open).mockReset().mockImplementation(actual.open) },
      async expectHeld() {
        expect(syncs).toBe(1)
        expect(vi.mocked(rename).mock.calls.filter(([, target]) => String(target) === path)).toHaveLength(1)
        if (kind === 'sequence') return
        const writes = vi.mocked(writeFile).mock.calls.filter(([target]) => String(target).endsWith('.tmp'))
        expect(writes).toHaveLength(kind === 'checkpoint' ? 2 : 1)
        for (const [, , options] of writes) expect(options).toMatchObject({ flush: true, mode: 0o600 })
        expect(vi.mocked(rename)).toHaveBeenCalledTimes(kind === 'checkpoint' ? 2 : 1)
        expect(vi.mocked(rename).mock.calls.filter(([, target]) => String(target).endsWith('.governing.json'))).toHaveLength(0)
      },
      async expectSettled() { expect(syncs).toBe(1) }
    }
  }
}
