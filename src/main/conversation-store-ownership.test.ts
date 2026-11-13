import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore } from './conversation-store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/**
 * The ownership cache is a projection of the ledgers. `list` fills it outside the store
 * admission, so a cold scan that is still reading when another ledger is published must
 * not replace the cache afterwards: a side-chat receipt read from that cache would answer
 * `not-found` for a child that exists, and the renderer would create a second one.
 */
describe('conversation ownership cache', () => {
  it('keeps a ledger published while an older cold scan is still reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-ownership-'))
    roots.push(root)
    const userData = join(root, 'userData')
    await mkdir(join(root, 'workspace'))
    const cwd = await realpath(join(root, 'workspace'))
    const existing = await new ConversationStore(userData).create(cwd)

    const store = new ConversationStore(userData)
    const required = store.required.bind(store)
    const loadOwnership = store.loadOwnership.bind(store)
    const loads: Array<ReturnType<typeof store.loadOwnership>> = []
    let publicationLoading!: () => void
    const publicationReachedScan = new Promise<void>((resolve) => { publicationLoading = resolve })
    vi.spyOn(store, 'loadOwnership').mockImplementation(() => {
      const load = loadOwnership()
      loads.push(load)
      if (loads.length === 2) publicationLoading()
      return load
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let scanStarted!: () => void
    const scanReading = new Promise<void>((resolve) => { scanStarted = resolve })
    let calls = 0
    vi.spyOn(store, 'required').mockImplementation(async (id: string) => {
      // Hold the first cold scan mid-read until the publication has asked for ownership.
      if (calls++ === 0) {
        scanStarted()
        await gate
      }
      return required(id)
    })

    const slowList = store.list(cwd)
    await scanReading
    const published = store.create(cwd)
    await publicationReachedScan
    release()
    const [listed, created] = await Promise.all([slowList, published])

    // Both waited on one scan, so the publication registered itself in the cached map.
    expect(await loads[1]).toBe(await loads[0])
    expect(listed.map(conversation => conversation.id)).toContain(existing.id)
    const after = (await store.list(cwd)).map(conversation => conversation.id)
    expect(after).toEqual(expect.arrayContaining([existing.id, created.id]))
  })
})
