import assert from 'node:assert/strict'

// Pure aggregation for the P0 concurrency slice. Ratios are summed inside one sampling window and
// only per-window values are distributed; nothing here adds percentages across windows.
const percentile = (values, quantile) => [...values].sort((left, right) => left - right)[Math.ceil(values.length * quantile) - 1]

export function distribution(values) {
  assert.ok(values.length > 0, 'distribution requires at least one sample')
  return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) }
}

export const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
export const round = value => Math.round(value * 10) / 10
export const unavailable = reason => ({ status: 'unavailable', reason })

// Renderer attribution for this slice. No production observer exists, and the two candidate
// shortcuts are not commit proofs: useAgentSession also acknowledges ignored batches immediately,
// and DOM mutations cannot attribute a commit to one specific trace batch.
export const RENDERER_COMMIT_UNAVAILABLE = 'no trusted per-batch React commit signal is observable without adding a production observer: '
  + 'useAgentSession acknowledges ignored batches without a React commit, and transcript DOM mutations cannot attribute a commit to a batch'

export function rendererCommitLane() {
  return unavailable(RENDERER_COMMIT_UNAVAILABLE)
}

// Independent observation counters. These are traffic and blocking evidence, never latency:
// they carry no per-batch delay and are named so they cannot be read as commit time.
export function summarizeRendererObservation(probe) {
  if (!probe) return unavailable('renderer probe was not installed')
  const batches = Array.isArray(probe.batches) ? probe.batches : []
  if (batches.length === 0) return unavailable('no agent:trace batch reached the renderer')
  const bytes = batches.filter(batch => finite(batch.bytes)).map(batch => batch.bytes)
  return {
    status: 'measured',
    source: 'observation counters only: agent:trace receipts, longtask PerformanceObserver, transcript MutationObserver',
    batches: {
      count: batches.length,
      events: distribution(batches.map(batch => batch.events)),
      bytes: bytes.length > 0 ? distribution(bytes) : null,
      runIdsObserved: [...new Set(batches.flatMap(batch => batch.runIds ?? []))].length
    },
    longTasks: probe.longTasks?.supported
      ? { supported: true, count: probe.longTasks.count, totalMs: round(probe.longTasks.totalMs), maxMs: round(probe.longTasks.maxMs) }
      : { supported: false, reason: 'PerformanceObserver longtask entry type unavailable' },
    domMutations: probe.domMutations?.observed
      ? { observed: true, count: probe.domMutations.count, note: 'transcript-subtree mutation count; not a commit proof and not per-batch latency' }
      : { observed: false, reason: 'transcript MutationObserver was not attached' }
  }
}

export function summarizeTraceHealth(probe) {
  const states = probe?.health ?? []
  if (states.length === 0) return unavailable('no agent:traceHealth state was published')
  return {
    status: 'measured',
    states: states.length,
    degradedStates: states.filter(state => state.degraded).length,
    skippedEvents: Math.max(...states.map(state => state.skippedEvents ?? 0)),
    bufferedEventsMax: Math.max(...states.map(state => state.bufferedEvents ?? 0)),
    bufferedBytesMax: Math.max(...states.map(state => state.bufferedBytes ?? 0)),
    inFlightBytesMax: Math.max(...states.map(state => state.inFlightBytes ?? 0)),
    resyncRequiredStates: states.filter(state => state.resyncRequired).length
  }
}

// Promise.all preserves input order, so outcomes[i] belongs to runs[i]. The workspace used to locate
// a run's durable evidence comes from that authority only; a page-reported field can never select a
// different workspace, and a dispatched slot without an outcome fails instead of being skipped.
export function associateOutcomes(runs, outcomes) {
  assert.equal(outcomes.length, runs.length, 'every dispatch slot must produce exactly one outcome')
  return outcomes.map((outcome, index) => ({ ...outcome, index, cwd: runs[index].cwd }))
}

// Diagnostics retention is a decision, not a side effect: temp userData, per-run workspaces and the
// full App log are deleted only when this exact run produced a measured report AND the owned process
// tree is confirmed gone. A failure, an incomplete report or an unknown cleanup keeps everything,
// because the retained log is the only evidence of what happened.
export function decideRetention({ outcome, cleanupConfirmed, leftoverProcesses }) {
  if (!cleanupConfirmed) return { retain: true, reason: 'owned process cleanup was not confirmed' }
  if (!Number.isFinite(leftoverProcesses)) return { retain: true, reason: 'leftover owned process count is unknown' }
  if (leftoverProcesses > 0) return { retain: true, reason: `${leftoverProcesses} owned process(es) still registered after cleanup` }
  if (outcome !== 'measured') return { retain: true, reason: `run outcome is ${outcome}, not measured` }
  return { retain: false, reason: 'measured run with confirmed cleanup' }
}
