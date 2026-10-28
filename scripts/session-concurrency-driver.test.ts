import { EventEmitter } from 'node:events'
import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOutputCapture, watchChildClose } from './session-concurrency-electron.mjs'
import { planAdmissionTargets, planHistorySwitches, selectScenario } from './session-concurrency-contract.mjs'
import { performHistorySwitches, waitForAdmittedTasks } from './session-concurrency-ui.mjs'
import { driveConcurrencyRun, installConcurrencyProbe } from './session-concurrency-page.mjs'

// The driver runs inside the renderer, so a fake window is the only faithful unit boundary. vm keeps
// the stringified function byte-identical to what the harness injects.
function harness({ startReply = { runId: 'run-a' }, focus = true, startError = null, beforeReply = false } = {}) {
  let onTrace
  let onTurnDone
  let onError
  const calls = []
  const window = { scry: {
    start: async () => {
      calls.push('start')
      if (startError) throw new Error(startError)
      // The terminal notification is delivered before the start reply is read, like a fast run.
      if (beforeReply) onTurnDone({ runId: startReply.runId, externalSessionId: 'sess-a' })
      return startReply
    },
    focusRun: async runId => { calls.push(`focusRun:${runId}`); return focus },
    // Recorded only so the test can prove the driver stopped asking for them: production aborts the
    // previous global controller on agent:loadSession, so a per-run readback cancels its siblings.
    loadSession: async () => { calls.push('loadSession'); return { turns: [] } },
    activeRuns: async () => { calls.push('activeRuns'); return [] },
    onTrace: callback => { onTrace = callback; return () => { onTrace = null } },
    onTurnDone: callback => { onTurnDone = callback; return () => { onTurnDone = null } },
    onError: callback => { onError = callback; return () => { onError = null } },
    onTraceHealth: () => () => {}
  } }
  const document = { documentElement: {}, querySelector: () => null }
  const context = createContext({ window, document, performance, setTimeout, clearTimeout, Error, Promise, Map, Set, Math,
    Number, JSON, MutationObserver: undefined, PerformanceObserver: undefined })
  const install = () => runInContext(`(${installConcurrencyProbe.toString()})()`, context)
  const drive = input => runInContext(`(${driveConcurrencyRun.toString()})(${JSON.stringify(input)})`, context)
  return {
    install, drive, calls,
    trace: (events, receipt) => onTrace(events, receipt),
    done: event => onTurnDone(event),
    error: event => onError(event),
    window
  }
}

describe('per-run driver', () => {
  const input = { cwd: '/tmp/run-0', prompt: 'p', deadlineMs: 5_000, focus: true }

  it('claims the terminal that arrived before the start reply and reports observable boundaries', async () => {
    const fake = harness({ beforeReply: true })
    expect(fake.install().installed).toBe(true)
    const result = await fake.drive(input)
    expect(result.runId).toBe('run-a')
    expect(result.externalSessionId).toBe('sess-a')
    expect(result.terminalConfirmed).toBe(true)
    expect(result.startRequestedAtEpochMs).toBeGreaterThan(0)
    expect(result.terminalAtEpochMs).toBeGreaterThanOrEqual(result.startRequestedAtEpochMs)
    expect(result.startReplyAtEpochMs).toBeGreaterThanOrEqual(result.startRequestedAtEpochMs)
    // The terminal arrived before the reply was read, so the accepted-active interval is zero-length;
    // the raw page-clock order is preserved for the overlap contract instead of being clamped.
    expect(result.terminalAtEpochMs).toBeLessThanOrEqual(result.startReplyAtEpochMs)
    expect(result.firstOutputReceiptMs).toBeNull()
    expect(result.firstOutputUnavailable).toBe('run-not-mirrored-renderer-sees-focused-run-only')
  })

  // The previous revision asserted that a driver rejected a run whose archived turn was missing or
  // whose prompt differed. Those assertions were wrong for this contract: the check went through
  // agent:loadSession, and production aborts the previous global controller on every call, so a
  // concurrent readback cancels its siblings and the failure was a harness artefact, not a Provider
  // or run failure. Archive verification moved to the canonical durable files after exit, where it is
  // stricter: the harness re-reads the archived turn and re-hashes the referenced content blob.
  it('never reads history per run, so a readback cancellation cannot be reported as a run failure', async () => {
    const fake = harness()
    fake.install()
    const pending = fake.drive(input)
    fake.done({ runId: 'run-a', externalSessionId: 'sess-a' })
    await expect(pending).resolves.toMatchObject({ runId: 'run-a' })
    expect(fake.calls).toEqual(['start', 'focusRun:run-a'])
    expect(fake.calls).not.toContain('loadSession')
    expect(fake.calls).not.toContain('activeRuns')
  })

  it('never claims another run terminal and keeps it for its own owner', async () => {
    const fake = harness()
    fake.install()
    const pending = fake.drive(input)
    fake.done({ runId: 'run-other', externalSessionId: 'sess-other' })
    fake.done({ runId: 'run-a', externalSessionId: 'sess-a' })
    const result = await pending
    expect(result.runId).toBe('run-a')
    const other = await fake.window.__scryConcurrencyAwait('run-other', 10)
    expect(other.runId).toBe('run-other')
  })

  it('rejects a run whose own error arrived early and ignores another run error', async () => {
    const failing = harness()
    failing.install()
    const pending = failing.drive(input)
    failing.error({ runId: 'run-a', message: 'provider exploded' })
    await expect(pending).rejects.toThrow(/provider exploded/)
    const crossTalk = harness()
    crossTalk.install()
    const running = crossTalk.drive(input)
    crossTalk.error({ runId: 'run-other', message: 'other run failed' })
    crossTalk.done({ runId: 'run-a', externalSessionId: 'sess-a' })
    await expect(running).resolves.toMatchObject({ runId: 'run-a' })
  })

  // Only the task the fixture means to mirror may take focus; a batch at a lower in-flight limit must not
  // add foreground work, so an unfocused drive is a first-class case rather than a silent default.
  it('takes focus only when asked to, and requires the boolean', async () => {
    const unfocusedDrive = harness()
    unfocusedDrive.install()
    const pending = unfocusedDrive.drive({ ...input, focus: false })
    unfocusedDrive.done({ runId: 'run-a', externalSessionId: 'sess-a' })
    await expect(pending).resolves.toMatchObject({ runId: 'run-a', firstOutputUnavailable: 'run-not-mirrored-renderer-sees-focused-run-only' })
    expect(unfocusedDrive.calls).toEqual(['start'])
    await expect(unfocusedDrive.drive({ ...input, focus: undefined })).rejects.toThrow(/explicit focus boolean/)
  })

  it('surfaces start and focus failures', async () => {
    const startFail = harness({ startError: 'start rejected' })
    startFail.install()
    await expect(startFail.drive(input)).rejects.toThrow(/start rejected/)
    const unnamed = harness({ startReply: { runId: '' } })
    unnamed.install()
    await expect(unnamed.drive(input)).rejects.toThrow(/start reply did not name a run id/)
    const unfocused = harness({ focus: false })
    unfocused.install()
    const pending = unfocused.drive(input)
    unfocused.done({ runId: 'run-a', externalSessionId: 'sess-a' })
    await expect(pending).rejects.toThrow(/not focusable/)
  })

  it('refuses to drive without an installed probe and times out instead of inventing a terminal', async () => {
    const fake = harness()
    await expect(fake.drive(input)).rejects.toThrow(/probe is not installed/)
    fake.install()
    await expect(fake.window.__scryConcurrencyAwait('run-missing', 20)).rejects.toThrow(/no terminal event for run-missing/)
  })

  it('attributes trace batches and bytes to their own run only', async () => {
    const fake = harness()
    fake.install()
    const pending = fake.drive(input)
    fake.trace([{ kind: 'model', stage: 'text', runId: 'run-a' }, { kind: 'model', stage: 'text', runId: 'run-b' }],
      { batchId: 1, generation: 0, bytes: 100 })
    fake.trace([{ kind: 'model', stage: 'text', runId: 'run-b' }], { batchId: 2, generation: 0, bytes: 50 })
    fake.done({ runId: 'run-a', externalSessionId: 'sess-a' })
    const result = await pending
    expect(result.traceEvents).toBe(2)
    expect(result.traceBytes).toBe(100)
    expect(result.traceMirrored).toBe(true)
    expect(result.firstOutputReceiptMs).not.toBeNull()
    expect(fake.window.__scryConcurrencyTraceFor('run-b')).toMatchObject({ batches: 2, events: 3, bytes: 150 })
  })
})

// Fixed fixture shape: the accepted concurrency levels (4 and 16) switch across four different runs'
// history sessions. A plan that cannot give each switch its own run is refused instead of repeating a
// target, so no single-run sequence is planned: 1 is not an accepted level (parseConcurrency).
describe('history switch plan by concurrency', () => {
  it('uses a different run history session per switch', () => {
    const runs = Array.from({ length: 4 }, (_, index) => ({ cwd: `/tmp/run-${index}`,
      historySessionId: `conc-${index}-history`, seededLiveSessionId: `conc-${index}-live` }))
    const plan = planHistorySwitches({ runs, scenario: selectScenario('history-switch') })
    expect(plan.map(target => target.sessionId)).toEqual(runs.map(run => run.historySessionId))
    expect(plan.every(target => target.latestIndex === 19)).toBe(true)
    expect(planHistorySwitches({ runs, scenario: selectScenario('stream') })).toEqual([])
  })

  it('refuses a plan that would have to repeat one run for several switches', () => {
    const runs = [{ cwd: '/tmp/run-0', historySessionId: 'conc-0-history', seededLiveSessionId: 'conc-0-live' }]
    expect(() => planHistorySwitches({ runs, scenario: selectScenario('history-switch') }))
      .toThrow(/at least one run per requested switch/)
  })
})

// Negative control: dispatch needs the seeded catalog and the started session row observed first. The
// fake page throws on any query or wait, so a dispatched click (which would need both) cannot pass.
describe('history switch dispatch guard', () => {
  const target = { sessionId: 'conc-0-history', seededLiveSessionId: 'conc-0-live', cwd: '/tmp/run-0',
    prompt: 'performance long stream', latestIndex: 19 }

  it('dispatches no click when the started session row was not observed', async () => {
    const sent = []
    const switches = await performHistorySwitches({
      session: { send: async (method, params) => { sent.push([method, params]) } },
      evaluate: async () => { throw new Error('no page query may run when the guard holds') },
      wait: async () => { throw new Error('no readiness wait may run when the guard holds') },
      targets: [target], preparation: [{ sessionId: target.sessionId, state: 'seeded-ready' }],
      startedRows: [{ sessionId: target.sessionId, startedRow: 'not-observed', status: 'unavailable', reason: 'timeout' }],
      expectedStarted: 1
    })
    expect(switches).toEqual([])
    expect(sent).toEqual([])
  })

  it('dispatches no click when the seeded preparation was not ready', async () => {
    const sent = []
    const switches = await performHistorySwitches({
      session: { send: async (method, params) => { sent.push([method, params]) } },
      evaluate: async () => { throw new Error('no page query may run when the guard holds') },
      wait: async () => { throw new Error('no readiness wait may run when the guard holds') },
      targets: [target], preparation: [{ sessionId: target.sessionId, state: 'seeded-row-not-listed-after-wait' }],
      startedRows: [{ sessionId: target.sessionId, startedRow: 'observed', status: 'measured' }],
      expectedStarted: 1
    })
    expect(switches).toEqual([])
    expect(sent).toEqual([])
  })
})

// Admission staging, not input latency: a history click changes the authorized cwd, so a start still in flight
// would be refused by the real trust/cwd gate. Every task must be admitted (start reply plus rendered row)
// before the first click. These cases drive the real function order with a fake page, not a selector string.
describe('history admission staging', () => {
  const preparation = Array.from({ length: 4 }, (_, index) =>
    ({ sessionId: `conc-${index}-history`, state: 'seeded-ready' }))
  const admittedRow = index => ({ sessionId: `conc-${index}-history`, cwd: `/tmp/run-${index}`,
    prompt: 'performance long stream', startedRow: 'observed', startReply: 'observed', status: 'measured' })
  const allAdmitted = Array.from({ length: 16 }, (_, index) => admittedRow(index))
  const fixtureTasks = Array.from({ length: 16 }, (_, index) => ({ cwd: `/tmp/run-${index}`,
    historySessionId: `conc-${index}-history` }))
  const shapeTargets = () => planAdmissionTargets({ runs: fixtureTasks, scenario: selectScenario('history-switch') })
  // Two answers per batch: the bounded wait, then the single read-only state read.
  const reader = answers => {
    const evaluated = []
    return { evaluated, evaluate: async expression => { evaluated.push(expression); return answers.shift() } }
  }

  // A null page answer makes every click attempt unproven, which is fine: these cases are about whether the
  // pointer path runs at all, never about proving a native click.
  function fake() {
    const sent = []
    const queries = []
    return { sent, queries, session: { send: async (method, params) => { sent.push([method, params]) } },
      evaluate: async expression => { queries.push(expression); return null },
      wait: async expression => { queries.push(expression) } }
  }

  it('dispatches nothing while only four of the sixteen tasks are admitted', async () => {
    const closed = await gate(allAdmitted.slice(0, 4))
    expect(closed).toMatchObject({ switches: [], queries: [], sent: [] })
  })

  // The bench shape and the page reader must agree: a task record has historySessionId and no prompt, so
  // handing task records over would make the row predicate match nothing.
  it('builds admission targets with a session id and the scenario prompt', () => {
    expect(shapeTargets()).toHaveLength(16)
    expect(shapeTargets()[0]).toEqual({ sessionId: 'conc-0-history', cwd: '/tmp/run-0',
      prompt: 'performance long stream' })
  })

  // One gate invocation, so the closed and open cases cannot drift apart.
  async function gate(rows) {
    const page = fake()
    const switches = await performHistorySwitches({ ...page, targets: shapeTargets().slice(0, 4), preparation,
      startedRows: rows, expectedStarted: 16 })
    return { switches, queries: page.queries, sent: page.sent }
  }

  // A rendered row is recorded before the run is registered, so rows alone must not open the gate.
  it('requires a start reply per cwd, not only a rendered row', async () => {
    const list = shapeTargets()
    const page = reader([true, [...list.slice(0, 15).map(() => ({ rowObserved: true, replyObserved: true })),
      { rowObserved: true, replyObserved: false }]])
    const rows = await waitForAdmittedTasks({ evaluate: page.evaluate, targets: list })
    expect(page.evaluated).toHaveLength(2)
    expect(rows.slice(0, 15).every(row => row.status === 'measured')).toBe(true)
    expect(rows[15]).toMatchObject({ status: 'unavailable', startReply: 'not-observed' })
    expect(rows[15].reason).toMatch(/no start reply was recorded for this cwd/)
    expect(await gate(rows)).toMatchObject({ switches: [], queries: [] })
  })

  it('opens the gate only when every reply and row is observed, with one bounded wait', async () => {
    const list = shapeTargets()
    const page = reader([true, list.map(() => ({ rowObserved: true, replyObserved: true }))])
    const rows = await waitForAdmittedTasks({ evaluate: page.evaluate, targets: list })
    expect(page.evaluated).toHaveLength(2)
    expect(rows.every(row => row.status === 'measured')).toBe(true)
    const opened = await gate(rows)
    expect(opened.queries.length).toBeGreaterThan(0)
    expect(opened.switches).toHaveLength(4)
    expect(opened.sent.length).toBeGreaterThan(0)   // the pointer really dispatched once the gate opened
  })

  it('fails closed when one task row is missing from an otherwise full batch', async () => {
    const rows = allAdmitted.map(row => ({ ...row }))
    rows[9] = { ...rows[9], startedRow: 'not-observed', status: 'unavailable', reason: 'deadline' }
    expect(await gate(rows)).toEqual({ switches: [], queries: [], sent: [] })
  })
})

// stopOwnedApp returns as soon as no registered process is alive, which is before Node's 'close' has
// drained the stdio pipes. The tail of the log and the leftover inspect both depend on that difference, and
// the drain deadline must only start at the stop: a spawn-time deadline would expire during a quiet run that
// is meant to last longer than the bound. A controlled clock is the only way to prove both without waiting.
describe('child close lifecycle', () => {
  function fakeChild() {
    let kills = 0
    const child = Object.assign(new EventEmitter(), { kill() { kills += 1 } })
    return { child, kills: () => kills }
  }

  afterEach(() => { vi.useRealTimers() })

  it('keeps the subscription while the App runs far past the drain bound', async () => {
    vi.useFakeTimers()
    const { child, kills } = fakeChild()
    const watcher = watchChildClose(child)
    // Sixty seconds of measurement, no stop yet: no deadline is running and the subscription must survive.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(child.listenerCount('close')).toBe(1)
    child.emit('close', 0, null)
    expect(await watcher.wait()).toEqual({ state: 'closed', code: 0, signal: null })
    expect(kills()).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('does not finish before close, and keeps the tail output once close arrives', async () => {
    vi.useFakeTimers()
    const { child, kills } = fakeChild()
    // A fake stream would deliver 'data' on a later tick; this case is about the finalize-versus-close
    // ordering, so it feeds the capture seam the harness wires to those streams.
    const capture = createOutputCapture({ onLine: () => {} })
    const waiting = watchChildClose(child).wait()
    // The stop returned and 100 ms passed; 'close' has not arrived, so nothing may be called finished yet.
    await vi.advanceTimersByTimeAsync(100)
    expect(child.listenerCount('close')).toBe(1)
    capture.stdout('tail line written after the stop returned\n')
    capture.stderr('stderr tail\n')
    child.emit('close', 0, null)
    expect(await waiting).toEqual({ state: 'closed', code: 0, signal: null })
    const text = capture.finish()
    expect(text).toContain('tail line written after the stop returned')
    expect(text).toContain('stderr tail')
    expect(kills()).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('stays unknown when close misses the drain bound after the stop, without stopping again', async () => {
    vi.useFakeTimers()
    const { child, kills } = fakeChild()
    const watcher = watchChildClose(child)
    const waiting = watcher.wait()
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await waiting
    expect(result.state).toBe('unknown')
    expect(result.reason).toMatch(/close was not observed within 5000 ms after the stop/)
    expect(kills()).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    // The unknown verdict is cached: a second wait neither re-arms a deadline nor observes the late close.
    expect(await watcher.wait()).toEqual(result)
  })
})
