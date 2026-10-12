import { describe, expect, it, vi } from 'vitest'
import { ContextAdmission, canRestartInterruptedLocalOnlySession, expectedRestartSourceMatches, expectedSessionMatches, waitForCompletedRuns } from './context-admission'

describe('context admission', () => {
  it('serializes the same provider workspace while allowing another context through', async () => {
    const admission = new ContextAdmission()
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const order: string[] = []

    const first = admission.run('codex\0/repo', async () => {
      order.push('first:start')
      await firstBlocked
      order.push('first:end')
    })
    const secondAction = vi.fn(async () => { order.push('second') })
    const second = admission.run('codex\0/repo', secondAction)
    const independent = admission.run('claude\0/repo', async () => { order.push('independent') })

    await independent
    expect(secondAction).not.toHaveBeenCalled()
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'independent', 'first:end', 'second'])
  })

  it('releases the queue after an action rejects', async () => {
    const admission = new ContextAdmission()
    await expect(admission.run('qoder\0/repo', async () => { throw new Error('denied') }))
      .rejects.toThrow('denied')
    await expect(admission.run('qoder\0/repo', async () => 'next')).resolves.toBe('next')
  })

  it('waits for a UI-complete run to settle before admitting the queued turn', async () => {
    let releasePipeline!: () => void
    const settled = new Promise<void>((resolve) => { releasePipeline = resolve })
    let admitted = false
    const waiting = waitForCompletedRuns([{ done: true, settled }]).then((value) => { admitted = value })
    await Promise.resolve()
    expect(admitted).toBe(false)
    releasePipeline()
    await waiting
    expect(admitted).toBe(true)
    await expect(waitForCompletedRuns([{ done: false, settled: Promise.resolve() }])).resolves.toBe(false)
  })

  it('binds a prompt to the session selected before a draining wait', () => {
    const draining = [{ runId: 'run-a', externalSessionId: 'session-a' }]
    expect(expectedSessionMatches('session-a', 'session-a', () => draining)).toBe(true)
    expect(expectedSessionMatches('run-a', 'session-a', () => draining)).toBe(true)
    expect(expectedSessionMatches('session-a', 'session-b', () => draining)).toBe(false)
    expect(expectedSessionMatches(null, undefined, () => draining)).toBe(true)
    expect(expectedSessionMatches(null, 'session-b', () => draining)).toBe(false)
  })

  it.each([
    { expected: undefined, actual: 'session-a', matches: true },
    { expected: null, actual: undefined, matches: true },
    { expected: null, actual: 'session-a', matches: false },
    { expected: 'session-a', actual: 'session-a', matches: true }
  ])('does not load aliases for direct session admission: $expected / $actual', ({ expected, actual, matches }) => {
    const candidates = vi.fn(() => { throw new Error('catalog must not be read') })
    expect(expectedSessionMatches(expected, actual, candidates)).toBe(matches)
    expect(candidates).not.toHaveBeenCalled()
  })

  it('reloads aliases and rejects a stale session after settlement', async () => {
    let aliases = [{ runId: 'run-a', externalSessionId: 'session-a' }]
    const candidates = vi.fn(() => aliases)
    expect(expectedSessionMatches('run-a', 'session-a', candidates)).toBe(true)
    await waitForCompletedRuns([{ done: true, settled: Promise.resolve().then(() => {
      aliases = [{ runId: 'run-a', externalSessionId: 'session-b' }]
    }) }])
    expect(expectedSessionMatches('run-a', 'session-a', candidates)).toBe(false)
    expect(expectedSessionMatches('run-a', 'session-b', candidates)).toBe(true)
    expect(candidates).toHaveBeenCalledTimes(3)
  })

  it('does not turn missing alias evidence into successful admission', () => {
    const candidates = vi.fn(() => { throw new Error('catalog unavailable') })
    expect(() => expectedSessionMatches('run-a', 'session-a', candidates)).toThrow('catalog unavailable')
  })

  it('仍然允许向首轮失败后只剩本地壳的会话重新发送', () => {
    // 首轮失败后 catalog 里只剩 externalSessionId === runId 的本地壳，main 也没有原生 session。
    const localOnly = [{ runId: 'run-failed', externalSessionId: 'run-failed', sessionId: 'run-failed' }]
    const pending = [{ runId: 'run-pending', sessionId: 'run-pending' }]
    expect(expectedSessionMatches('run-failed', undefined, () => localOnly)).toBe(true)
    expect(expectedSessionMatches('run-pending', undefined, () => pending)).toBe(true)
    // 可 resume 的会话丢了 main 侧边界时仍然必须拒绝，不能静默新建 session。
    expect(expectedSessionMatches('run-a', undefined, () => [{ runId: 'run-a', externalSessionId: 'session-a' }])).toBe(false)
    // 本地壳也不能被当成其他会话的投递目标。
    expect(expectedSessionMatches('run-failed', 'session-b', () => localOnly)).toBe(false)
    expect(expectedSessionMatches('run-other', undefined, () => localOnly)).toBe(false)
  })

  it('只把无原生 session 的 provisional run 视为 restart 来源', () => {
    expect(expectedRestartSourceMatches('run-stopped', undefined, 'run-stopped')).toBe(true)
    expect(expectedRestartSourceMatches('other-run', undefined, 'run-stopped')).toBe(false)
    expect(expectedRestartSourceMatches('run-stopped', 'native-session', 'run-stopped')).toBe(false)
    expect(expectedRestartSourceMatches(null, undefined, 'run-stopped')).toBe(false)
  })

  it('只允许没有原生边界的 interrupted 首轮重新编辑', () => {
    const turn = { runId: 'run-stopped', status: 'interrupted' }
    expect(canRestartInterruptedLocalOnlySession({ turns: [turn] }, 'run-stopped')).toBe(true)
    expect(canRestartInterruptedLocalOnlySession(null, 'run-stopped')).toBe(false)
    expect(canRestartInterruptedLocalOnlySession({ turns: [turn, { ...turn, runId: 'run-2' }] }, 'run-stopped')).toBe(false)
    expect(canRestartInterruptedLocalOnlySession({ turns: [{ ...turn, status: 'failed' }] }, 'run-stopped')).toBe(false)
    expect(canRestartInterruptedLocalOnlySession({ turns: [{ ...turn, providerTurnId: 'provider-turn' }] }, 'run-stopped')).toBe(false)
    expect(canRestartInterruptedLocalOnlySession({ turns: [{ ...turn, forkTurnId: 'fork-turn' }] }, 'run-stopped')).toBe(false)
    expect(canRestartInterruptedLocalOnlySession({ turns: [turn] }, 'other-run')).toBe(false)
  })
})
