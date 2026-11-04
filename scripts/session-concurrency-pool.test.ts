import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseTaskCount } from './session-concurrency-contract.mjs'
import { validateConcurrencyReport } from './session-concurrency-validate.mjs'
import { TASK_POOL, minimalReport } from './session-concurrency-report-fixture.mjs'
import { batchValue, runTaskPool, summarizeTaskPool, trackBatch } from './session-concurrency-pool.mjs'

// runTaskPool is injected into the renderer with toString(), so the only faithful unit boundary is the
// function text itself plus a controlled clock. The deadline of every case here is a fake clock, never a wait.
function fakePage() {
  let now = 0
  const load = new Function('performance', `return (${runTaskPool.toString()})`)
  const pool = load({ timeOrigin: 1_000, now: () => now })
  // advance returns the new page time, so a caller can read the clock and move it in one expression.
  return { pool, advance: ms => (now += ms), origin: 1_000 }
}

const batch = size => Array.from({ length: size }, (_, index) => ({ index }))

describe('fixed batch size contract', () => {
  it('accepts only the default batch or a full sixteen', () => {
    expect(parseTaskCount(undefined, 4)).toBe(4)
    expect(parseTaskCount('', 16)).toBe(16)
    expect(parseTaskCount('16', 4)).toBe(16)
    // The batch can only be the in-flight limit or the full batch: no arbitrary work size is reserved.
    expect(() => parseTaskCount('4', 16)).toThrow(/tasks must equal concurrency \(16\) or 16/)
    expect(() => parseTaskCount('8', 4)).toThrow(/or 16/)
  })
})

describe('fixture task pool', () => {
  it('runs sixteen tasks with at most four in flight and completes every one', async () => {
    const page = fakePage()
    let inFlight = 0
    let peak = 0
    const started = []
    const pool = await page.pool({ tasks: batch(16), limit: 4 }, async task => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      started.push(task.index)
      const startRequestedAtEpochMs = page.origin + page.advance(10)
      await Promise.resolve()
      inFlight -= 1
      return { startRequestedAtEpochMs, terminalAtEpochMs: startRequestedAtEpochMs + 100 }
    })
    expect(peak).toBe(4)
    expect(started).toEqual(batch(16).map(task => task.index))
    expect(pool.outcomes).toHaveLength(16)
    expect(pool.outcomes.every(outcome => outcome.ok)).toBe(true)
    expect(pool.firstFailure).toBe(null)
    expect(summarizeTaskPool({ pool, tasks: 16, concurrency: 4 })).toMatchObject({ status: 'measured',
      tasks: 16, limit: 4, dispatched: 16, completed: 16, notStarted: [] })
  })

  it('keeps results in task order when they finish out of order', async () => {
    const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const page = fakePage()
    const delays = { a: 3, b: 2, c: 1 }
    const pool = await page.pool({ tasks, limit: 3 }, async task => {
      for (let tick = 0; tick < delays[task.id]; tick++) await Promise.resolve()
      return { id: task.id, startRequestedAtEpochMs: page.origin, terminalAtEpochMs: page.origin + delays[task.id] }
    })
    expect(pool.outcomes.map(outcome => outcome.run.id)).toEqual(['a', 'b', 'c'])
  })

  it('measures queue wait and batch completion on the page clock', async () => {
    const page = fakePage()
    // limit 1: before each drive the clock jumps 100 ms (queueing), and inside it 50 ms (the run).
    const pool = await page.pool({ tasks: batch(3), limit: 1 }, async () => {
      const startRequestedAtEpochMs = page.origin + page.advance(100)
      return { startRequestedAtEpochMs, terminalAtEpochMs: page.origin + page.advance(50) }
    })
    expect(pool.outcomes.map(outcome => outcome.queueWaitMs)).toEqual([100, 250, 400])
    const summary = summarizeTaskPool({ pool, tasks: 3, concurrency: 1 })
    expect(summary.batchMs).toBe(450)
    expect(summary.completedPerSecond).toBe(6.7)
    expect(summary.queueWaitMs).toMatchObject({ count: 3, max: 400 })
  })

  // A task dispatched before the pool observed the failure is in flight, not a late dispatch. The ordering
  // here is a guarantee, not luck: the failing drive is a plain function returning the rejected promise, so
  // the pool registers its continuation before this test registers its own catch, and the pool's catch block
  // therefore runs first. No sleeps, no polling and no tick counting are involved.
  it('stops dispatching once it has observed a drive failure, without retrying it', async () => {
    const page = fakePage()
    const attempted = []
    let rejectFailure
    let releaseSuccesses
    const failure = new Promise((_, reject) => { rejectFailure = () => reject(new Error('start failed')) })
    const successes = new Promise(resolve => { releaseSuccesses = resolve })
    const poolRun = page.pool({ tasks: batch(16), limit: 4 }, task => {
      attempted.push(task.index)
      if (task.index === 1) return failure
      return successes.then(() => ({ startRequestedAtEpochMs: page.origin, terminalAtEpochMs: page.origin + 1 }))
    })
    // Four slots took the first four tasks; nothing else can be dispatched while they are parked.
    expect(attempted).toEqual([0, 1, 2, 3])
    rejectFailure()
    // Resolves after the pool's own continuation has already run and recorded the failure.
    await failure.catch(() => {})
    releaseSuccesses()
    const pool = await poolRun
    expect(attempted).toEqual([0, 1, 2, 3])
    expect(pool.firstFailure).toEqual({ index: 1, error: 'start failed' })
    const summary = summarizeTaskPool({ pool, tasks: 16, concurrency: 4 })
    expect(summary.status).toBe('incomplete')
    expect(summary.completed).toBe(3)
    expect(summary.failed).toEqual([{ index: 1, error: 'start failed' }])
    expect(summary.notStarted).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    expect(pool.outcomes[4].error).toMatch(/not started: task 1 failed/)
  })
})

describe('report accounting for a fixed task batch', () => {
  it('rejects a batch size that is neither the concurrency nor sixteen', () => {
    expect(() => validateConcurrencyReport(minimalReport({ tasks: 8 }))).toThrow(/tasks must equal concurrency/)
  })

  it('refuses to call a measured batch that left a task unstarted', () => {
    const optimistic = minimalReport({ taskPool: { ...TASK_POOL, status: 'measured', completed: 3, dispatched: 3,
      notStarted: [3] } })
    expect(() => validateConcurrencyReport(optimistic)).toThrow(/measured batch completes every task/)
  })

  // The comparison under test: the same sixteen tasks at four in flight. Four dispatched and twelve never
  // started is an incomplete batch, not a measured one with a shorter run list.
  it('keeps sixteen tasks at four in flight incomplete when only four were dispatched', () => {
    const failures = [
      ...[0, 1, 2, 3].map(index => ({ index, cwd: `/tmp/run-${index}`, error: 'start failed' })),
      ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(index => ({ index, cwd: `/tmp/run-${index}`,
        error: 'not started: task 0 failed', notStarted: true }))
    ]
    const report = minimalReport({ concurrency: 4, tasks: 16, failures,
      taskPool: { ...TASK_POOL, tasks: 16, limit: 4, dispatched: 4, completed: 0,
        notStarted: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        failed: [0, 1, 2, 3].map(index => ({ index, error: 'start failed' })) } })
    expect(validateConcurrencyReport(report)).toBe(true)
    expect(report.status).toBe('incomplete')
    expect(report.workload).toMatchObject({ concurrency: 4, tasks: 16 })
    expect(report.lanes.taskPool).toMatchObject({ limit: 4, notStarted: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] })
    expect(report.failures.filter(failure => failure.notStarted === true)).toHaveLength(12)
  })
})

// The harness dispatches the batch and then runs UI work before it awaits the result, so a batch rejection can
// land in that window. Node treats it as an unhandled rejection and aborts the process, which is exactly what the
// observed App run did: cleanup never ran and four owned processes were left. These two children are the same
// shape as the harness (dispatch, UI throws, async finally) with and without the guard.
describe('an in-flight batch rejection cannot break cleanup', () => {
  const poolUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'session-concurrency-pool.mjs')).href

  // The child is the harness shape with the timing removed: the batch rejects on a microtask, the UI phase
  // throws, and the finally yields exactly one event-loop boundary — the point at which Node decides whether a
  // rejection was handled. Nothing here depends on how long a timer takes.
  function source(guarded) {
    const setup = guarded
      ? `import { batchValue, trackBatch } from ${JSON.stringify(poolUrl)}
const batch = trackBatch(new Promise((_, reject) => queueMicrotask(() => reject(new Error('batch failed')))))`
      : `const batch = new Promise((_, reject) => queueMicrotask(() => reject(new Error('batch failed'))))`
    return `${setup}
let cleaned = false
try {
  // The UI phase that threw in the real run.
  throw new Error('ui exploded')
} catch (error) {
  console.log('CAUGHT ' + error.message)
} finally {
  // One event-loop boundary in place of the real cleanup (stop, close, drain, flush).
  await new Promise(setImmediate)
  cleaned = true
  console.log('CLEANUP ' + cleaned)
}
${guarded ? "console.log('BATCH ' + batch.record.settled + ' ' + String(batch.record.error && batch.record.error.message))"
    : "await batch"}
try { ${guarded ? 'batchValue(batch.record)' : "throw new Error('unused')"} } catch (error) { console.log('RETHROWN ' + error.message) }
`
  }

  function run(sourceText, args) {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [...args, '--input-type=module', '-e', sourceText],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { output += chunk })
      child.on('close', code => resolve({ code, output }))
    })
  }

  it('reaches the cleanup marker and still reports the original error', async () => {
    const guarded = await run(source(true), [])
    expect(guarded.output).toContain('CAUGHT ui exploded')
    expect(guarded.output).toContain('CLEANUP true')
    expect(guarded.output).toContain('BATCH true batch failed')
    expect(guarded.output).toContain('RETHROWN batch failed')
    expect(guarded.code).toBe(0)
  })

  it('dies before cleanup without the guard, so the control is sensitive', async () => {
    const bare = await run(source(false), ['--unhandled-rejections=strict'])
    expect(bare.output).not.toContain('CLEANUP')
    expect(bare.code).not.toBe(0)
  })
})
