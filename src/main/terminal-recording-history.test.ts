import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TerminalRecordingStore } from './terminal-recording'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const id = (n: number) => `terminal-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'scry-terminal-history-'))
  roots.push(cwd)
  const directory = join(cwd, 'recordings')
  const store = new TerminalRecordingStore(directory, () => {})
  const record = (n: number, workspace = cwd) => {
    store.start({ id: id(n), cwd: workspace, cols: 80, rows: 24, pid: 1 })
    store.append(id(n), 'raw body is not a list preview')
    store.finish({ id: id(n), code: 0, signal: null })
  }
  return { cwd, directory, store, record }
}

describe('terminal recording history', () => {
  it('paginates only authorized metadata in stable ID order, including after a cold reopen', async () => {
    const { cwd, directory, record } = fixture()
    for (const n of [6, 3, 1, 5, 2, 4]) record(n, n % 2 ? cwd : '/foreign')
    const cold = new TerminalRecordingStore(directory, () => {})
    const first = await cold.list({ limit: 2 }, cwd)
    expect(first.items.map((item) => item.id)).toEqual([id(1), id(3)])
    expect(first.nextCursor).toBe(id(3))
    expect(first.partial).toBe(false)
    expect(first.items[0]).toMatchObject({ active: false, state: 'complete', startedAt: expect.any(Number) })
    expect(JSON.stringify(first)).not.toContain('/foreign')
    expect(JSON.stringify(first)).not.toContain('raw body')
    cold.delete(id(3), cwd)
    const second = await cold.list({ after: first.nextCursor!, limit: 2 }, cwd)
    expect(second.items.map((item) => item.id)).toEqual([id(5)])
    expect(second.nextCursor).toBeNull()
    expect((await cold.list({}, '/absent')).items).toEqual([])
  })

  it('keeps old metadata readable without inventing a start time and distinguishes live from interrupted', async () => {
    const { cwd, directory, store, record } = fixture()
    record(1)
    const path = join(directory, `${id(1)}.json`)
    const old = JSON.parse(readFileSync(path, 'utf8'))
    delete old.startedAt
    writeFileSync(path, JSON.stringify(old))
    store.start({ id: id(2), cwd, cols: 80, rows: 24, pid: 1 })
    const live = await store.list({}, cwd)
    expect(live.items[0].startedAt).toBeUndefined()
    expect(live.items[1]).toMatchObject({ active: true, state: 'recording' })
    const cold = await new TerminalRecordingStore(directory, () => {}).list({}, cwd)
    expect(cold.items[1]).toMatchObject({ active: false, state: 'interrupted' })
    store.finish({ id: id(2), code: null, signal: null })
  })

  it.each(['malformed', 'symlink', 'permissions', 'oversized'] as const)('reports %s metadata as partial without exposing unverified identity', async (kind) => {
    const { cwd, directory, store, record } = fixture()
    record(1)
    record(2, '/foreign')
    const path = join(directory, `${id(2)}.json`)
    if (kind === 'malformed') writeFileSync(path, '{}')
    if (kind === 'symlink') { rmSync(path); symlinkSync(join(directory, `${id(1)}.json`), path) }
    if (kind === 'permissions') chmodSync(path, 0o644)
    if (kind === 'oversized') writeFileSync(path, 'x'.repeat(17000))
    const page = await store.list({}, cwd)
    expect(page.partial).toBe(true)
    expect(page.items.map((item) => item.id)).toEqual([id(1)])
    expect(JSON.stringify(page)).not.toContain(id(2))
  })

  it('bounds pages, rejects concurrent scans and releases admission after a scan', async () => {
    const { cwd, store, record } = fixture()
    for (let n = 1; n <= 23; n++) record(n)
    const pending = store.list({}, cwd)
    await expect(store.list({}, cwd)).rejects.toThrow('list_busy')
    expect((await pending).items).toHaveLength(20)
    expect((await store.list({ limit: 1 }, cwd)).items).toHaveLength(1)
    for (const request of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }]) {
      await expect(store.list(request, cwd)).rejects.toThrow('invalid_cursor')
    }
    await expect(store.list({ after: '../escape' }, cwd)).rejects.toThrow('invalid_id')
  })

  it('returns genuine absence but does not treat an unsafe store as empty', async () => {
    const { cwd, directory, store } = fixture()
    expect(await store.list({}, cwd)).toEqual({ items: [], nextCursor: null, partial: false })
    symlinkSync(cwd, directory)
    await expect(store.list({}, cwd)).rejects.toThrow('unsafe_directory')
  })
})
