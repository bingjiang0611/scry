import { describe, expect, it, vi } from 'vitest'
import { ADMISSION_DEADLINE_MS, ContextAdmission, admitRun, canRestartInterruptedLocalOnlySession, expectedRestartSourceMatches, expectedSessionMatches, runConflictsWithSession, waitForCompletedRuns } from './context-admission'

describe('context admission', () => {
  it('admits an explicit new session while another first turn has no Provider session ID', async () => {
    const pending = { runId: 'run-first', done: false, settled: Promise.resolve() }
    const conflicts = [pending].filter((run) => runConflictsWithSession(run, undefined, null))
    await expect(waitForCompletedRuns(conflicts)).resolves.toBe(true)
    const sameSession = [pending].filter((run) => runConflictsWithSession(run, undefined, 'run-first'))
    await expect(waitForCompletedRuns(sameSession)).resolves.toBe(false)
    expect(runConflictsWithSession(pending, undefined, 'run-first')).toBe(true)
    expect(runConflictsWithSession(pending, undefined, 'run-other')).toBe(false)
    expect(runConflictsWithSession(pending, undefined, undefined)).toBe(true)
  })

  it('still blocks the same native session and admits independent native sessions', () => {
    const run = { runId: 'run-first', sessionId: 'session-first', externalSessionId: 'native-first' }
    expect(runConflictsWithSession(run, 'native-first', 'native-first')).toBe(true)
    expect(runConflictsWithSession(run, 'native-other', 'native-other')).toBe(false)
    expect(runConflictsWithSession(run, undefined, null)).toBe(false)
  })

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

  it('atomically reserves overlapping identities without blocking an unrelated conversation', async () => {
    const admission = new ContextAdmission()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const first = admission.runMany(['thread-a', 'native-b'], async () => {
      order.push('first:start')
      await blocked
      order.push('first:end')
    })
    const reverse = admission.runMany(['native-b', 'thread-a'], async () => { order.push('reverse') })
    const native = admission.run('native-b', async () => { order.push('native') })
    await admission.run('unrelated', async () => { order.push('unrelated') })
    expect(order).toEqual(['first:start', 'unrelated'])
    release()
    await Promise.all([first, reverse, native])
    expect(order).toEqual(['first:start', 'unrelated', 'first:end', 'reverse', 'native'])
  })

  it('reserves the entire key set while waiting on an earlier single-key owner', async () => {
    const admission = new ContextAdmission()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const first = admission.run('a', () => blocked)
    const combinedAction = vi.fn(async () => {})
    const followerAction = vi.fn(async () => {})
    const combined = admission.runMany(['b', 'a', 'b'], combinedAction)
    const follower = admission.run('b', followerAction)
    await admission.run('c', async () => {})
    expect(combinedAction).not.toHaveBeenCalled()
    expect(followerAction).not.toHaveBeenCalled()
    release()
    await Promise.all([first, combined, follower])
    expect(combinedAction.mock.invocationCallOrder[0]).toBeLessThan(followerAction.mock.invocationCallOrder[0])
  })

  it('releases every identity after rejection and rejects an empty key set', async () => {
    const admission = new ContextAdmission()
    await expect(admission.runMany(['a', 'b'], async () => { throw new Error('denied') })).rejects.toThrow('denied')
    await expect(admission.runMany(['b', 'a'], async () => 'next')).resolves.toBe('next')
    const action = vi.fn(async () => {})
    await expect(admission.runMany([], action)).rejects.toThrow('at least one')
    expect(action).not.toHaveBeenCalled()
  })

  // G1：一个永不释放的持有者曾让后续每一轮都停在 admission 里，App 既看不到错误也无法停止。
  // 有界等待把「永远等待」变成带原因的失败，并且不留下幽灵排队位。
  it('gives up waiting for a holder that never releases instead of queueing forever', async () => {
    const admission = new ContextAdmission({ admitDeadlineMs: 30 })
    let releaseHolder!: () => void
    const held = new Promise<void>((resolve) => { releaseHolder = resolve })
    const holder = admission.run('a', () => held)
    const started = Date.now()
    await expect(admission.run('a', async () => 'next')).rejects.toThrow('run_admission_timeout')
    expect(Date.now() - started).toBeLessThan(2_000)
    // 超时那一轮释放自己的占位：持有者一结束，后续 run 立即通过，而不是排在空气后面。
    releaseHolder()
    await holder
    await expect(admission.run('a', async () => 'after')).resolves.toBe('after')
  })

  it('keeps waiting without a deadline, so the bound is an explicit choice', async () => {
    const admission = new ContextAdmission({ admitDeadlineMs: Number.POSITIVE_INFINITY })
    let releaseHolder!: () => void
    const held = new Promise<void>((resolve) => { releaseHolder = resolve })
    const holder = admission.run('a', () => held)
    const queued = admission.run('a', async () => 'next')
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    releaseHolder()
    await holder
    await expect(queued).resolves.toBe('next')
  })

  // The run-admission deadline is a property of starting a run, not of every queue built
  // on this class: the conversation ledger, deletion and fork serialize on it too, and a
  // timeout there would refuse a write that has not failed (H1).
  it('keeps a default admission queued past the run-admission deadline', async () => {
    vi.useFakeTimers()
    try {
      const admission = new ContextAdmission()
      let releaseHolder!: () => void
      const holder = admission.run('a', () => new Promise<void>((resolve) => { releaseHolder = resolve }))
      const queuedAction = vi.fn(async () => 'next')
      const queued = admission.run('a', queuedAction)
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
      queued.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
      await vi.advanceTimersByTimeAsync(ADMISSION_DEADLINE_MS + 5_000)
      expect(outcome).toBe('pending')
      expect(queuedAction).not.toHaveBeenCalled()
      releaseHolder()
      await holder
      await expect(queued).resolves.toBe('next')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a run start that waits behind a holder at the run-admission deadline', async () => {
    vi.useFakeTimers()
    try {
      const admission = new ContextAdmission()
      let releaseHolder!: () => void
      const holder = admission.runMany(['a'], () => new Promise<void>((resolve) => { releaseHolder = resolve }))
      const action = vi.fn(async () => 'started')
      const start = admitRun(admission, ['a'], action)
      const rejected = expect(start).rejects.toThrow('run_admission_timeout')
      await vi.advanceTimersByTimeAsync(ADMISSION_DEADLINE_MS + 1)
      await rejected
      expect(action).not.toHaveBeenCalled()
      releaseHolder()
      await holder
      // The timed-out start released its own place, so the next one is not stuck behind it.
      await expect(admitRun(admission, ['a'], async () => 'after')).resolves.toBe('after')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a UI-complete run that never settles as no longer waitable', async () => {
    const never = new Promise<void>(() => {})
    const started = Date.now()
    await expect(waitForCompletedRuns([{ done: true, settled: never }], { admitDeadlineMs: 30 })).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
    // 控制组：没有 deadline 时同一个输入仍在等待，说明上面的 false 来自边界而不是恰好完成。
    let finished = false
    const unbounded = waitForCompletedRuns([{ done: true, settled: never }]).then(() => { finished = true })
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    expect(finished).toBe(false)
    void unbounded
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
