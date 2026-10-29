import { distribution, finite, round, unavailable } from './session-concurrency-aggregate.mjs'

// Fixed-size worker pool for the measurement fixture. This is not a product scheduler and must not be read
// as queueing capability: it only lets one batch of tasks run with a bounded number in flight so 16 tasks at
// 4 in flight can be compared with 16 tasks at 16 in flight.
//
// runTaskPool executes inside the renderer (it is injected with toString), so the single enqueue instant,
// every dispatch and every terminal come from the same page clock. It deliberately imports nothing: a
// module reference here would not exist in the page. The first drive failure the pool has observed stops new
// dispatches while the already-dispatched tasks keep converging; the remaining tasks are reported as
// not-started instead of being filled with a zero wait or retried. A task dispatched before that observation
// is in flight, not a late dispatch.
export function runTaskPool(input, drive) {
  return (async () => {
    const { tasks, limit } = input
    const batchStartedAt = performance.now()
    const enqueuedAtEpochMs = performance.timeOrigin + batchStartedAt
    const outcomes = new Array(tasks.length).fill(null)
    let next = 0
    let failure = null
    const worker = async () => {
      while (failure === null && next < tasks.length) {
        const index = next++
        try {
          const run = await drive(tasks[index])
          outcomes[index] = { ok: true, run, queueWaitMs: run.startRequestedAtEpochMs - enqueuedAtEpochMs }
        } catch (error) {
          const message = String(error && error.message)
          outcomes[index] = { ok: false, error: message }
          failure = failure ?? { index, error: message }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
    const batchEndedAt = performance.now()
    for (let index = 0; index < outcomes.length; index++) {
      if (!outcomes[index]) {
        outcomes[index] = { ok: false, notStarted: true,
          error: failure ? `not started: task ${failure.index} failed` : 'not started: no free slot in the batch' }
      }
    }
    const terminals = outcomes.filter(outcome => outcome.ok).map(outcome => outcome.run.terminalAtEpochMs)
    return { ok: failure === null, limit, batchStartedAt, batchEndedAt, enqueuedAtEpochMs, firstFailure: failure,
      outcomes, lastTerminalAtEpochMs: terminals.length > 0 ? Math.max(...terminals) : null }
  })()
}

// The batch runs for the whole active phase, so it cannot be awaited where it starts. Node treats a rejection
// nobody is awaiting as a process-level unhandled rejection, which would abort the cleanup that has to run after
// a UI failure. trackBatch keeps the outcome on a record instead, and batchValue hands the original error back on
// the normal path: nothing is swallowed, retried or turned into a success.
export function trackBatch(promise) {
  const record = { settled: false, ok: false, value: undefined, error: null }
  const done = promise.then(
    value => Object.assign(record, { settled: true, ok: true, value }),
    error => Object.assign(record, { settled: true, ok: false, error }))
  return { record, done }
}

export function batchValue(record) {
  if (!record.settled) throw new Error('the task batch had not settled when its result was read')
  if (!record.ok) throw record.error
  return record.value
}

// Batch accounting. queueWait is time spent waiting for a slot, so it is never reported as accepted
// concurrency; concurrency stays the configured in-flight limit and observedConcurrency stays the measured
// overlap of the actual runs.
export function summarizeTaskPool({ pool, tasks, concurrency }) {
  if (!pool) return unavailable('the task pool returned no batch outcome')
  const entries = pool.outcomes.map((outcome, index) => ({ ...outcome, index }))
  const completed = entries.filter(entry => entry.ok)
  const notStarted = entries.filter(entry => !entry.ok && entry.notStarted === true).map(entry => entry.index)
  const failed = entries.filter(entry => !entry.ok && entry.notStarted !== true).map(entry => ({ index: entry.index, error: entry.error }))
  const waits = completed.map(entry => entry.queueWaitMs).filter(value => finite(value))
  const batchMs = pool.lastTerminalAtEpochMs === null ? null : round(pool.lastTerminalAtEpochMs - pool.enqueuedAtEpochMs)
  return {
    status: completed.length === tasks && notStarted.length === 0 && failed.length === 0 ? 'measured' : 'incomplete',
    source: 'renderer performance.now() with one enqueue instant for the batch; every dispatch and terminal uses the same page clock',
    policy: 'fixture worker pool, not a product scheduler: at most limit drives in flight, tasks dispatched in index order, '
      + 'the first observed drive failure stops new dispatches while already-dispatched tasks still converge, and the '
      + 'remainder is not-started',
    tasks,
    limit: pool.limit,
    dispatched: completed.length + failed.length,
    completed: completed.length,
    notStarted,
    failed,
    firstFailure: pool.firstFailure,   // the first drive failure this pool observed
    queueWaitMs: waits.length > 0 ? distribution(waits) : null,
    batchMs,
    completedPerSecond: finite(batchMs) && batchMs > 0 ? round(completed.length * 1000 / batchMs) : null,
    note: 'queueWait is waiting for a slot, not accepted concurrency; peak overlap stays in observedConcurrency against the '
      + 'configured level, and completedPerSecond is a batch throughput, not a per-run rate'
  }
}
