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
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    vi.spyOn(store, 'required').mockImplementation(async (id: string) => {
      // Only the first cold scan's read waits, so it is the one that finishes last.
      if (calls++ === 0) await gate
      return required(id)
    })

    const slowList = store.list(cwd)
    const published = store.create(cwd)
    // Let the publication run as far as it can before the old scan is allowed to finish.
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    const [listed, created] = await Promise.all([slowList, published])

    expect(listed.map(conversation => conversation.id)).toContain(existing.id)
    const after = (await store.list(cwd)).map(conversation => conversation.id)
    expect(after).toEqual(expect.arrayContaining([existing.id, created.id]))
  })
})
