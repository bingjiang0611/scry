// Page-side observation and per-run driver for the P0 concurrency slice.
// Both functions are stringified into the renderer by scripts/session-concurrency-bench.mjs and
// are also executed inside node:vm by scripts/session-concurrency-bench.test.ts.
//
// Observation only: nothing here acknowledges a trace batch, wraps preload APIs, or changes App
// semantics. Terminal/error events are captured globally and claimed strictly by run id, because a
// notification can arrive before the matching start reply is read. The probe also records the
// transcript's own DOM state so "was this run's text actually mounted" is a native observation.

export function installConcurrencyProbe() {
  const MAX_TERMINALS = 64
  const MAX_START_REPLIES = 64
  const MAX_BATCHES = 2_000
  const probe = {
    installedAt: performance.now(),
    // One entry per start reply the App actually returned, keyed by cwd. A rendered live row is recorded
    // before the run is registered (src/main/bootstrap/run-live-state.ts recordPending then admit), so a row
    // proves intent, never admission; this list is admission evidence and is only written from a reply.
    startReplies: [],
    batches: [],
    health: [],
    terminals: [],
    errors: [],
    longTasks: { supported: false, count: 0, totalMs: 0, maxMs: 0 },
    domMutations: { count: 0, lastAt: null, observed: false }
  }
  const now = () => performance.now()
  const waiters = new Map()
  const terminals = new Map()
  const errors = new Map()
  const deliver = (runId, entry) => {
    const waiter = waiters.get(runId)
    if (!waiter) return
    waiters.delete(runId)
    if (entry.error) waiter.reject(new Error(entry.error))
    else waiter.resolve(entry)
  }
  const releaseTrace = window.scry.onTrace((events, receipt) => {
    const firstText = events.find(event => event.kind === 'model' && (event.stage === 'text' || event.stage === 'text_delta'))
    probe.batches.push({
      batchId: receipt && receipt.batchId !== undefined ? receipt.batchId : null,
      generation: receipt && receipt.generation !== undefined ? receipt.generation : null,
      bytes: receipt && Number.isFinite(receipt.bytes) ? receipt.bytes : null,
      events: events.length,
      runIds: [...new Set(events.map(event => event.runId))],
      at: now(),
      firstTextAt: firstText ? now() : null,
      firstTextRunId: firstText ? firstText.runId : null
    })
    if (probe.batches.length > MAX_BATCHES) probe.batches.shift()
  })
  const releaseDone = window.scry.onTurnDone(event => {
    const entry = { runId: event.runId, event, at: now() }
    terminals.set(event.runId, entry)
    probe.terminals.push({ runId: event.runId, at: entry.at })
    if (probe.terminals.length > MAX_TERMINALS) probe.terminals.shift()
    deliver(event.runId, entry)
  })
  const releaseError = window.scry.onError(event => {
    const message = event && typeof event.message === 'string' ? event.message : 'provider error'
    const entry = { runId: event.runId, error: message, at: now() }
    errors.set(entry.runId, entry)
    probe.errors.push({ runId: entry.runId, message, at: entry.at })
    if (probe.errors.length > MAX_TERMINALS) probe.errors.shift()
    deliver(entry.runId, entry)
  })
  const releaseHealth = typeof window.scry.onTraceHealth === 'function'
    ? window.scry.onTraceHealth(state => probe.health.push({
      at: now(), degraded: Boolean(state.degraded), skippedEvents: state.skippedEvents,
      bufferedEvents: state.bufferedEvents, bufferedBytes: state.bufferedBytes,
      inFlightBytes: state.inFlightBytes, resyncRequired: Boolean(state.resyncRequired)
    }))
    : () => {}
  // Independent observation counter restricted to the transcript subtree. DOM mutations cannot
  // prove that a specific trace batch committed, so this is never reported as commit latency.
  let observer = null
  if (typeof MutationObserver === 'function' && typeof document === 'object' && document.documentElement) {
    observer = new MutationObserver(records => {
      const container = document.querySelector('.chat-transcript')
      if (!container) return
      if (!records.some(record => container.contains(record.target))) return
      probe.domMutations.count += 1
      probe.domMutations.lastAt = now()
    })
    observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true })
    probe.domMutations.observed = true
  }
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        probe.longTasks.count += 1
        probe.longTasks.totalMs += entry.duration
        probe.longTasks.maxMs = Math.max(probe.longTasks.maxMs, entry.duration)
      }
    }).observe({ entryTypes: ['longtask'] })
    probe.longTasks.supported = true
  } catch { probe.longTasks.supported = false }

  window.__scryConcurrencyStartReplies = probe.startReplies
  window.__scryConcurrencyRecordStart = entry => {
    probe.startReplies.push({ cwd: entry.cwd, runId: entry.runId, at: now() })
    if (probe.startReplies.length > MAX_START_REPLIES) probe.startReplies.shift()
  }

  // Bounded wait for one run's terminal state. A terminal or error that already arrived is
  // returned immediately; another run's event is stored for that run and never claimed here.
  window.__scryConcurrencyAwait = (runId, deadlineMs) => new Promise((resolve, reject) => {
    if (errors.has(runId)) return reject(new Error(errors.get(runId).error))
    if (terminals.has(runId)) return resolve(terminals.get(runId))
    const timer = setTimeout(() => {
      waiters.delete(runId)
      reject(new Error(`no terminal event for ${runId} within ${deadlineMs} ms`))
    }, deadlineMs)
    waiters.set(runId, {
      resolve: value => { clearTimeout(timer); resolve(value) },
      reject: error => { clearTimeout(timer); reject(error) }
    })
  })
  window.__scryConcurrencyTraceFor = runId => probe.batches
    .filter(batch => batch.runIds.includes(runId))
    .reduce((total, batch) => ({
      batches: total.batches + 1,
      events: total.events + batch.events,
      bytes: total.bytes + (batch.bytes === null ? 0 : batch.bytes),
      firstTextAt: total.firstTextAt !== null ? total.firstTextAt
        : batch.firstTextRunId === runId ? batch.firstTextAt : null,
      lastAt: batch.at
    }), { batches: 0, events: 0, bytes: 0, firstTextAt: null, lastAt: null })
  window.__scryConcurrencyRelease = () => {
    releaseTrace()
    releaseDone()
    releaseError()
    releaseHealth()
    waiters.clear()
    if (observer) observer.disconnect()
  }
  window.__scryConcurrencyProbe = probe
  return { installed: true, longTaskSupported: probe.longTasks.supported,
    domMutationsObserved: probe.domMutations.observed }
}

// One in-page driver per run. The harness dispatches all of them without awaiting, so the runs are
// genuinely concurrent. Every promise is awaited: a failed start/focus/timeout rejects this run
// without leaving an unhandled rejection, and the probe keeps ownership of listener and timer
// lifetime.
//
// This driver deliberately does not read history. Production aborts the previous global controller on
// every agent:loadSession (src/main/bootstrap/history-load.ts), so a per-run readback would cancel its
// siblings and report a cancellation as a run failure. History is verified once, from the canonical
// durable archive, after all runs settled.
export function driveConcurrencyRun(input) {
  return (async () => {
    const { cwd, prompt, deadlineMs, focus } = input
    // Focus is explicit and never defaulted, so the driver never focuses by accident. This is not a promise
    // that other runs stay background: a production legacy start still auto-focuses itself
    // (src/main/run-registry.ts register defaults focus=true, src/main/bootstrap/run-startup.ts emits
    // agent:focusedRun), so what the renderer actually mirrored has to be read from the report, not assumed.
    if (typeof focus !== 'boolean') throw new Error('drive requires an explicit focus boolean')
    if (typeof window.__scryConcurrencyAwait !== 'function') throw new Error('concurrency probe is not installed')
    if (typeof window.__scryConcurrencyTraceFor !== 'function') throw new Error('concurrency probe trace reader is missing')
    if (typeof window.__scryConcurrencyRecordStart !== 'function') throw new Error('concurrency probe start recorder is missing')
    const startedAt = performance.now()
    const started = await window.scry.start({ providerId: 'codex', cwd, prompt })
    const receiptAt = performance.now()
    const runId = started && started.runId
    if (typeof runId !== 'string' || runId === '') throw new Error('start reply did not name a run id')
    // Recorded the moment the reply names a run: this, not the rendered row, is what admission can claim.
    window.__scryConcurrencyRecordStart({ cwd, runId })
    if (focus) {
      const focused = await window.scry.focusRun(runId)
      if (focused === false) throw new Error('started run was not focusable')
    }
    const terminal = await window.__scryConcurrencyAwait(runId, deadlineMs)
    const done = terminal.event
    if (!done || done.runId !== runId) throw new Error('terminal event identity mismatch')
    if (done.stopped) throw new Error('unexpected interrupted terminal state')
    const trace = window.__scryConcurrencyTraceFor(runId)
    // Absolute page-clock boundaries: the orchestration layer compares them with its own samples, and
    // the observed overlap of these intervals is the measured concurrency, not the configured level.
    const origin = performance.timeOrigin
    return {
      runId,
      prompt,
      externalSessionId: done.externalSessionId || done.sessionId || null,
      startRequestedAtEpochMs: origin + startedAt,
      startReplyAtEpochMs: origin + receiptAt,
      terminalAtEpochMs: origin + terminal.at,
      startReceiptMs: receiptAt - startedAt,
      startToTerminalMs: terminal.at - startedAt,
      // Only the focused run is mirrored to the renderer; an unmirrored run has no receipt time
      // and says so instead of reporting 0.
      firstOutputReceiptMs: trace.firstTextAt === null ? null : trace.firstTextAt - startedAt,
      ...(trace.firstTextAt === null ? { firstOutputUnavailable: 'run-not-mirrored-renderer-sees-focused-run-only' } : {}),
      traceEvents: trace.events,
      traceBytes: trace.bytes,
      traceMirrored: trace.events > 0,
      lastTraceOffsetMs: trace.lastAt === null ? null : trace.lastAt - startedAt,
      terminalConfirmed: true
    }
  })()
}
