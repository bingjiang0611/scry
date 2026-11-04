import { describe, expect, it } from 'vitest'
import type { GitTurnDiffCapture } from './git'
import { SessionDiffBaselineRegistry } from './session-diff'
import { WorkspaceOverlapTracker } from './workspace-overlap'

function fakeCapture(id: string): GitTurnDiffCapture {
  return { beforeAt: id, captureMs: 0, status: 'ready', repoRoot: '/repo', beforeTree: id }
}

/** 手动时钟：让「基线 → 兄弟启动 → 证据采集」的先后关系可断言，不依赖真实计时。 */
function clock(startAt = 1_000) {
  let nowMs = startAt
  return { now: () => nowMs, set: (at: number) => { nowMs = at }, advance: (by: number) => { nowMs += by } }
}

function registry(time: ReturnType<typeof clock>): SessionDiffBaselineRegistry {
  return new SessionDiffBaselineRegistry(async () => fakeCapture('capture'), async () => undefined,
    new WorkspaceOverlapTracker(time.now))
}

describe('workspace overlap observation', () => {
  it('lists a sibling that started while the baseline was still being observed', () => {
    const time = clock()
    const baselines = registry(time)
    const entry = baselines.ensure({ key: 'k', revision: 0, cwd: '/repo' })
    baselines.observeRunWorkspace('run-main', '/repo')
    time.advance(50)
    baselines.observeRunWorkspace('run-sibling', '/repo')
    time.advance(500)
    const overlap = baselines.workspaceOverlap('run-main')
    expect(overlap).toMatchObject({ coverage: 'observed', runIds: ['run-sibling'] })
    expect(overlap?.observedFrom).toBe(new Date(1_000).toISOString())
    expect(overlap?.observedTo).toBe(new Date(time.now()).toISOString())
    expect(entry.observedAt).toBe(1_000)
  })

  it('still counts a sibling that finished before this run captured its diff', () => {
    const time = clock()
    const baselines = registry(time)
    baselines.ensure({ key: 'k', revision: 0, cwd: '/repo' })
    baselines.observeRunWorkspace('run-main', '/repo')
    baselines.observeRunWorkspace('run-sibling', '/repo')
    time.advance(120)
    expect(baselines.workspaceOverlap('run-sibling')?.runIds).toEqual(['run-main'])
    baselines.releaseRunWorkspace('run-sibling')
    time.advance(300)
    expect(baselines.workspaceOverlap('run-main')).toMatchObject({ coverage: 'observed', runIds: ['run-sibling'] })
  })

  it('does not attribute a later run to a capture that had already finished', () => {
    const time = clock()
    const baselines = registry(time)
    baselines.ensure({ key: 'k', revision: 0, cwd: '/repo' })
    baselines.observeRunWorkspace('run-main', '/repo')
    time.advance(100)
    baselines.workspaceOverlap('run-main')
    baselines.releaseRunWorkspace('run-main')
    time.advance(100)
    baselines.observeRunWorkspace('run-late', '/repo')
    time.advance(100)
    expect(baselines.workspaceOverlap('run-late')?.runIds).toEqual([])
  })

  it('never mixes a different working directory into the evidence', () => {
    const time = clock()
    const baselines = registry(time)
    baselines.observeRunWorkspace('run-main', '/repo')
    baselines.observeRunWorkspace('run-other', '/elsewhere')
    time.advance(80)
    expect(baselines.workspaceOverlap('run-main', undefined)?.runIds).toEqual([])
  })

  it('reports an observed empty set differently from an unobserved capture', () => {
    const time = clock()
    const baselines = registry(time)
    baselines.observeRunWorkspace('run-main', '/repo')
    expect(baselines.workspaceOverlap('run-main')).toMatchObject({ coverage: 'observed', runIds: [] })
    // 旧记录/无基线：没有观测窗口，只能保持 unknown，不能写成「没有重叠」。
    expect(baselines.workspaceOverlap('run-never-observed')).toBeUndefined()
    baselines.releaseRunWorkspace('run-main')
    expect(baselines.workspaceOverlap('run-main')).toBeUndefined()
  })

  it('covers the session baseline window even when this run only tracked its own turn', () => {
    const time = clock()
    const baselines = registry(time)
    const entry = baselines.ensure({ key: 'k', revision: 0, cwd: '/repo' })
    // 上一轮留下的兄弟：在会话基线之后、本轮之前就写完并收口了。
    baselines.observeRunWorkspace('run-previous', '/repo')
    time.advance(40)
    baselines.workspaceOverlap('run-previous')
    baselines.releaseRunWorkspace('run-previous')
    time.advance(1_000)
    baselines.observeRunWorkspace('run-main', '/repo')
    time.advance(60)
    // 会话净 diff 从会话基线算起：那一轮的改动确实会进入本次净 diff。
    expect(baselines.workspaceOverlap('run-main', entry.observedAt)?.runIds).toEqual(['run-previous'])
    // 本轮 turn diff 只看本轮基线之后：不冒充上一轮的重叠。
    baselines.releaseRunWorkspace('run-main')
    baselines.observeRunWorkspace('run-next', '/repo')
    expect(baselines.workspaceOverlap('run-next')?.runIds).toEqual([])
  })

  it('bounds the reported run IDs instead of silently truncating', () => {
    const time = clock()
    const baselines = registry(time)
    baselines.observeRunWorkspace('run-main', '/repo')
    for (let index = 0; index < 20; index++) baselines.observeRunWorkspace(`run-sibling-${index}`, '/repo')
    time.advance(10)
    const overlap = baselines.workspaceOverlap('run-main')
    expect(overlap?.runIds).toHaveLength(16)
    expect(overlap?.truncated).toBe(true)
  })

  it('downgrades coverage to partial when the bounded history drops an overlapping window', () => {
    const time = clock()
    const baselines = registry(time)
    baselines.observeRunWorkspace('run-main', '/repo')
    for (let index = 0; index < 40; index++) {
      time.advance(1)
      baselines.observeRunWorkspace(`run-closed-${index}`, '/repo')
      time.advance(1)
      baselines.workspaceOverlap(`run-closed-${index}`)
      baselines.releaseRunWorkspace(`run-closed-${index}`)
    }
    expect(baselines.workspaceOverlap('run-main')).toMatchObject({ coverage: 'partial' })
  })

  it('keeps a still-running sibling in the window after it captured intermediate evidence', () => {
    const time = clock(1_000)
    const baselines = registry(time)
    baselines.observeRunWorkspace('run-peer', '/repo')
    time.set(2_000)
    // 兄弟在本轮中途采集过一次证据，但它仍在运行、仍在写同一工作区。
    expect(baselines.workspaceOverlap('run-peer')?.runIds).toEqual([])
    time.set(3_000)
    baselines.observeRunWorkspace('run-later', '/repo')
    time.set(4_000)
    expect(baselines.workspaceOverlap('run-later')?.runIds).toEqual(['run-peer'])
    // 收口之后才按证据结束时间结算：此后再启动的 run 不再与它重叠。
    baselines.releaseRunWorkspace('run-peer')
    baselines.releaseRunWorkspace('run-later')
    time.set(5_000)
    baselines.observeRunWorkspace('run-next', '/repo')
    expect(baselines.workspaceOverlap('run-next')?.runIds).toEqual([])
  })

  it('downgrades a session window that reaches before the retained history to partial', () => {
    const time = clock(1_000)
    const baselines = registry(time)
    const entry = baselines.ensure({ key: 'k', revision: 0, cwd: '/repo' })
    const sessionStart = entry.observedAt
    // 会话基线之后有 40 个已收口的 run，早先的记录会被有界历史淘汰。
    for (let index = 0; index < 40; index++) {
      time.advance(1)
      baselines.observeRunWorkspace(`run-closed-${index}`, '/repo')
      time.advance(1)
      baselines.workspaceOverlap(`run-closed-${index}`)
      baselines.releaseRunWorkspace(`run-closed-${index}`)
    }
    time.advance(1)
    baselines.observeRunWorkspace('run-resumed', '/repo')
    const overlap = baselines.workspaceOverlap('run-resumed', sessionStart)
    // 被淘汰窗口可能与本会话净 diff 相交：不能声称 observed（等于宣称没有别的 run）。
    expect(overlap?.coverage).toBe('partial')
    expect(overlap?.observedFrom).toBe(new Date(sessionStart).toISOString())
    // 本轮自己的窗口仍在保留范围内：只统计本轮基线之后的证据时才够格报 observed。
    expect(baselines.workspaceOverlap('run-resumed')?.coverage).toBe('observed')
  })

  it('bounds retained observation state across working directories', () => {
    const time = clock(1_000)
    const baselines = registry(time)
    for (let cwdIndex = 0; cwdIndex < 200; cwdIndex++) {
      const cwd = `/repo-${cwdIndex}`
      for (let runIndex = 0; runIndex < 2; runIndex++) {
        time.advance(1)
        baselines.observeRunWorkspace(`run-${cwdIndex}-${runIndex}`, cwd)
        time.advance(1)
        baselines.workspaceOverlap(`run-${cwdIndex}-${runIndex}`)
        baselines.releaseRunWorkspace(`run-${cwdIndex}-${runIndex}`)
      }
    }
    const retained = baselines.workspace.retainedState()
    expect(retained.runs).toBeLessThanOrEqual(128)
    expect(retained.cwds).toBeLessThanOrEqual(128)
    // 最早的目录记录已被淘汰：它的会话窗口不能再声称 observed。
    const oldest = '/repo-0'
    time.advance(1)
    baselines.observeRunWorkspace('run-late', oldest)
    expect(baselines.workspaceOverlap('run-late', 1_000)?.coverage).toBe('partial')
  })

  it('drops all observation state on dispose', () => {
    const time = clock()
    const baselines = registry(time)
    baselines.ensure({ key: 'k', revision: 0, cwd: '/repo' })
    baselines.observeRunWorkspace('run-main', '/repo')
    baselines.disposeAll()
    expect(baselines.workspaceOverlap('run-main')).toBeUndefined()
  })
})
