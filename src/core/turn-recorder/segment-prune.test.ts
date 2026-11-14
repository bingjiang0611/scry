import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STALE_SEGMENT_CHAIN_AGE_MS, pruneStaleSegmentChains } from './segment-prune.js'
import { readJson } from './io.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const sessionKey = 'session-1'
const frozen = {
  requestedRoot: '/w', repoRoot: '/w', scope: 'repo', tree: 'a'.repeat(40),
  at: '2026-11-13T00:00:00.000Z', objectDir: 'objects', tempDir: 'x', alternateObjectDirs: []
}

/** 一条已经停下的段链：两段各自的 store，加上会话状态里指向它们的引用。 */
async function chain(dataRoot: string, generations: number[], ageDays: number): Promise<string[]> {
  const root = join(dataRoot, 'runtime', 'qoder', sessionKey)
  const dirs: string[] = []
  for (const generation of generations) {
    const store = join(root, 'segment-captures', String(generation), `scry-turn-diff-${generation}`)
    await mkdir(join(store, 'objects', 'ab'), { recursive: true })
    await writeFile(join(store, 'objects', 'ab', 'cdef'), Buffer.alloc(16))
    const at = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1_000)
    await utimes(join(root, 'segment-captures', String(generation)), at, at)
    dirs.push(store)
  }
  await writeFile(join(root, 'session.json'), JSON.stringify({
    schemaVersion: 1, provider: 'qoder', sessionId: sessionKey,
    chainStores: dirs,
    lastSegment: { recordId: 'b'.repeat(32), rootRecordId: 'c'.repeat(32), generation: 2, frozenDiffs: [frozen] }
  }))
  return dirs
}

async function exists(path: string): Promise<boolean> {
  return readdir(join(path, '..')).then(names => names.length > 0).catch(() => false)
}

describe('stale recorder segment chains', () => {
  it('removes a chain whose newest segment is older than the threshold, and stops referencing it', async () => {
    const dataRoot = await tempRoot('scry-segment-prune-')
    const dirs = await chain(dataRoot, [1, 2], 4)
    const root = join(dataRoot, 'runtime', 'qoder', sessionKey)

    const result = await pruneStaleSegmentChains(dataRoot)

    expect(result).toMatchObject({ sessions: 1, generations: 2, files: 2, scanned: true })
    expect(await exists(dirs[0])).toBe(false)
    expect(await readdir(join(root, 'segment-captures')).catch(() => [])).toEqual([])
    const state = JSON.parse(await readFile(join(root, 'session.json'), 'utf8')) as Record<string, unknown>
    expect(state.chainStores).toBeUndefined()
    expect((state.lastSegment as Record<string, unknown>).frozenDiffs).toBeUndefined()
    // 记录的关联信息留着：下一段仍然接得回原提问，只是不再声称有 diff 基线。
    expect((state.lastSegment as Record<string, unknown>).recordId).toBe('b'.repeat(32))
  })

  it('keeps a chain that a new segment could still use, and an open turn pins its own chain', async () => {
    const dataRoot = await tempRoot('scry-segment-prune-keep-')
    const fresh = await tempRoot('scry-segment-prune-fresh-')
    await chain(fresh, [1], 0)
    await expect(pruneStaleSegmentChains(fresh)).resolves.toMatchObject({ sessions: 0, files: 0 })
    expect(await exists(join(fresh, 'runtime', 'qoder', sessionKey, 'segment-captures', '1'))).toBe(true)

    const dirs = await chain(dataRoot, [1], 4)
    const root = join(dataRoot, 'runtime', 'qoder', sessionKey)
    await writeFile(join(root, 'open.json'), JSON.stringify({ provider: 'qoder', sessionId: sessionKey, generation: 2 }))
    await expect(pruneStaleSegmentChains(dataRoot)).resolves.toMatchObject({ sessions: 0 })
    expect(await exists(dirs[0])).toBe(true)
  })

  it('scans at most once per threshold and re-arms after it passes', async () => {
    const dataRoot = await tempRoot('scry-segment-prune-marker-')
    await chain(dataRoot, [1], 4)
    const now = Date.now()
    await expect(pruneStaleSegmentChains(dataRoot, { now })).resolves.toMatchObject({ scanned: true })
    await chain(dataRoot, [1], 4)
    await expect(pruneStaleSegmentChains(dataRoot, { now: now + 1_000 })).resolves.toMatchObject({ scanned: false })
    const later = now + STALE_SEGMENT_CHAIN_AGE_MS + 1_000
    await expect(pruneStaleSegmentChains(dataRoot, { now: later })).resolves.toMatchObject({ scanned: true, sessions: 1 })
    expect(await readJson(join(dataRoot, 'runtime', 'stale-segment-prune.json'))).toMatchObject({ at: new Date(later).toISOString() })
  })
})
