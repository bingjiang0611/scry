import { describe, expect, it } from 'vitest'
import { normalizeTurnDiffSnapshot } from './trace.js'

const snapshot = {
  version: 1,
  status: 'captured',
  files: [],
  beforeAt: '2026-07-29T00:00:00.000Z',
  afterAt: '2026-07-29T00:00:01.000Z',
  captureMs: 100,
  cleanup: 'ok'
}

describe('normalizeTurnDiffSnapshot', () => {
  it('保留会话基线缺失原因，避免历史恢复时回退旧快照', () => {
    expect(normalizeTurnDiffSnapshot({ ...snapshot, status: 'unavailable', reason: 'no_baseline' })).toMatchObject({
      status: 'unavailable',
      reason: 'no_baseline',
      files: []
    })
  })

  it('保留合法 collection 元数据且兼容旧快照', () => {
    expect(normalizeTurnDiffSnapshot(snapshot)?.collection).toBeUndefined()
    expect(normalizeTurnDiffSnapshot({
      ...snapshot,
      collection: {
        strategy: 'full_fallback',
        evidence: 'fallback',
        candidatePathCount: 3,
        discoveryMs: 25,
        targetedMs: 50,
        fallbackMs: 200,
        fallbackReason: 'targeted_failed'
      }
    })?.collection).toEqual({
      strategy: 'full_fallback',
      evidence: 'fallback',
      candidatePathCount: 3,
      discoveryMs: 25,
      targetedMs: 50,
      fallbackMs: 200,
      fallbackReason: 'targeted_failed'
    })
  })

  it('非法 collection 只丢弃可选元数据，不影响 diff 正文', () => {
    const invalidCollections = [
      {
        strategy: 'magic',
        evidence: 'watcher',
        candidatePathCount: -1,
        discoveryMs: 'slow'
      },
      {
        strategy: 'targeted',
        evidence: 'fallback',
        candidatePathCount: 1,
        discoveryMs: 1,
        fallbackReason: 'forced'
      },
      {
        strategy: 'full_fallback',
        evidence: 'fallback',
        candidatePathCount: 1,
        discoveryMs: 1
      }
    ]
    for (const collection of invalidCollections) {
      const normalized = normalizeTurnDiffSnapshot({ ...snapshot, collection })
      expect(normalized).toMatchObject({ version: 1, status: 'captured', files: [] })
      expect(normalized?.collection).toBeUndefined()
    }
  })
})

describe('normalizeWorkspaceOverlap', () => {
  const overlap = {
    coverage: 'observed' as const,
    runIds: ['run-a'],
    observedFrom: '2026-07-29T00:00:00.000Z',
    observedTo: '2026-07-29T00:00:01.000Z'
  }

  it('保留合法的重叠证据原样', () => {
    expect(normalizeTurnDiffSnapshot({ ...snapshot, workspaceOverlap: overlap })?.workspaceOverlap).toEqual(overlap)
  })

  it('按上限截断 run ID 时如实标记 truncated，而不是静默少报', () => {
    const runIds = Array.from({ length: 70 }, (_unused, index) => `run-${index}`)
    const normalized = normalizeTurnDiffSnapshot({ ...snapshot, workspaceOverlap: { ...overlap, runIds } })?.workspaceOverlap
    expect(normalized?.runIds).toHaveLength(64)
    expect(normalized?.truncated).toBe(true)
  })

  it('重复的 run ID 去重后不算截断', () => {
    const normalized = normalizeTurnDiffSnapshot({
      ...snapshot, workspaceOverlap: { ...overlap, runIds: ['run-a', 'run-a'] }
    })?.workspaceOverlap
    expect(normalized?.runIds).toEqual(['run-a'])
    expect(normalized?.truncated).toBeUndefined()
  })

  it('拒绝无法解析或倒序的观测窗口，不把畸形时间当作已观测', () => {
    const invalidWindows = [
      { observedFrom: 'not-a-timestamp', observedTo: overlap.observedTo },
      { observedFrom: overlap.observedFrom, observedTo: '2026-13-40T99:99:99.999Z' },
      { observedFrom: overlap.observedTo, observedTo: overlap.observedFrom }
    ]
    for (const window of invalidWindows) {
      expect(normalizeTurnDiffSnapshot({ ...snapshot, workspaceOverlap: { ...overlap, ...window } })?.workspaceOverlap)
        .toBeUndefined()
    }
  })
})
