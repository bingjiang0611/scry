import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

import { createAppSessionStore, createProjectStore, createRecentFoldersStore } from './app-store'

it.each(['recent', 'project'] as const)('caches %s reads, returns copies, and invalidates external edits/replacements', (kind) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'scry-a2-cache-'))
  try {
    const file = join(dir, kind === 'recent' ? 'recent-folders.json' : 'projects.json')
    const first = kind === 'recent' ? ['/repo-a'] : [{ cwd: '/repo-a', lastOpenedAt: 1 }]
    const second = kind === 'recent' ? ['/repo-b'] : [{ cwd: '/repo-b', lastOpenedAt: 2 }]
    const store = kind === 'recent' ? createRecentFoldersStore(dir) : createProjectStore(dir)
    fs.writeFileSync(file, JSON.stringify(first))
    expect(store.load()).toEqual(first)
    vi.mocked(fs.readFileSync).mockClear()
    const copy = store.load()
    if (typeof copy[0] === 'string') copy[0] = 'mutated'
    else copy[0].cwd = 'mutated'
    copy.pop()
    expect(store.load()).toEqual(first)
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled()

    // Same inode, same byte length: mtime invalidates the cache.
    fs.writeFileSync(file, JSON.stringify(second))
    fs.utimesSync(file, 1234567890, 1234567890)
    expect(store.load()).toEqual(second)
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(1)
    const stamp = fs.statSync(file)
    const replacement = `${file}.replacement`
    fs.writeFileSync(replacement, JSON.stringify(first))
    fs.utimesSync(replacement, stamp.atime, stamp.mtime)
    fs.renameSync(replacement, file)
    expect(store.load()).toEqual(first)
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(2)

    fs.writeFileSync(`${file}.bak`, JSON.stringify(second))
    fs.unlinkSync(file)
    expect(store.load()).toEqual(second)
    fs.writeFileSync(`${file}.bak`, JSON.stringify(first))
    expect(store.load()).toEqual(first)
    fs.writeFileSync(`${file}.bak`, '{corrupt')
    expect(() => store.load()).toThrow('主索引与备份均不可用')
    fs.writeFileSync(file, JSON.stringify(second))
    expect(store.load()).toEqual(second)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

it('skips exact record/recordPending writes but preserves activity changes and backup recovery health', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'scry-a2-noop-'))
  const time = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    const store = createAppSessionStore(dir)
    const request = { providerId: 'claude' as const, runtimeProvider: 'claude_sdk' as const,
      cwd: '/repo', runId: 'run-1', prompt: 'first' }
    const file = join(dir, 'app-sessions.json')
    const signature = (): number[] => [fs.statSync(file).ino, fs.statSync(`${file}.bak`).ino]
    store.recordPending(request)
    const pending = signature()
    store.recordPending({ ...request, prompt: 'duplicate, not a title change' })
    expect(signature()).toEqual(pending)
    store.record({ ...request, externalSessionId: 'native' })
    const native = signature()
    store.record({ ...request, externalSessionId: 'native' })
    expect(signature()).toEqual(native)
    time.mockReturnValue(1001)
    store.record({ ...request, externalSessionId: 'native' })
    expect(signature()).not.toEqual(native)
    expect(store.load()[0].ts).toBe(1001)
    expect(store.load()[0].preview).toBe('first')
    fs.unlinkSync(file)
    expect(store.health()).toMatchObject({ status: 'degraded', source: 'backup' })
    const backup = store.load()
    fs.writeFileSync(`${file}.bak`, JSON.stringify(backup.map(session => ({ ...session, title: 'external' }))))
    expect(store.load()[0].title).toBe('external')
    store.record({ ...request, externalSessionId: 'native' })
    expect(store.health()).toEqual({ status: 'ready', source: 'primary' })
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))[0].title).toBe('external')
  } finally {
    time.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
