import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { RunOutputLog, type OutputChunk, type RunOutputPage, type RunOutputStore } from './run-output-log'
import { RunOutputFileStore } from './run-output-file'

// E2 follow-up: a wake-only read must not read output bodies.
//
// The wake exists so the App learns "there is more" without the text crossing the
// socket. The first version answered it by reading a whole page of chunks and returning
// their length - the text still left the disk and crossed a worker thread on every wake.
// The file store keeps a fixed-length index, so the count comes from that alone.

const directories: string[] = []
const temp = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'scry-output-wake-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('count-only output read', () => {
  it('counts through the store instead of paging chunks', async () => {
    const calls: string[] = []
    const store: RunOutputStore = {
      append: (chunk) => ({ ...chunk, seq: 1 }) as OutputChunk,
      since: () => { calls.push('since'); throw new Error('wake must not page chunks') },
      countSince: (runId: string, cursor: number) => { calls.push(`countSince:${runId}:${cursor}`); return { count: 3, cursor: 7 } },
      close: () => {}
    }
    const log = new RunOutputLog({ store })
    await expect(log.countSince('run-1', 4)).resolves.toEqual({ count: 3, cursor: 7 })
    expect(calls).toEqual(['countSince:run-1:4'])
  })

  it('counts in memory without a store', async () => {
    const log = new RunOutputLog()
    log.append('run-1', { kind: 'output', text: 'a' })
    log.append('run-1', { kind: 'output', text: 'b' })
    await expect(log.countSince('run-1', 0)).resolves.toEqual({ count: 2, cursor: 2 })
    await expect(log.countSince('run-1', 2)).resolves.toEqual({ count: 0, cursor: 2 })
  })

  it('answers from the index alone, without a page of bodies', async () => {
    const store = new RunOutputFileStore(temp())
    for (const text of ['one', 'two', 'three']) await store.append({ runId: 'run-1', kind: 'output', text, at: 1 })
    // The count is the index length, so it is not capped by the page size the way a
    // chunk page is; the cursor is the newest sequence number.
    expect(store.countSince('run-1', 0)).toEqual({ count: 3, cursor: 3 })
    expect(store.countSince('run-1', 2)).toEqual({ count: 1, cursor: 3 })
    expect(store.countSince('run-1', 9)).toEqual({ count: 0, cursor: 9 })
    const page: RunOutputPage = await store.since('run-1', 0)
    expect(page.cursor).toBe(3)
    await store.close()
  })

  it('reports nothing for a run that never wrote output', async () => {
    const store = new RunOutputFileStore(temp())
    expect(store.countSince('run-missing', 0)).toEqual({ count: 0, cursor: 0 })
    await store.close()
  })
})
