import assert from 'node:assert/strict'
import { distribution, finite, round, unavailable } from './session-concurrency-aggregate.mjs'

// Lanes for the P0 slice: [scry:resource] windows, boundary snapshots (main CPU/memory, per-process
// cumulative CPU, CDP task time), observed overlap, DOM mount check. Pure functions only.
// Journal windows keep memory and process counts, not CPU percent: percentCPUUsage is "since the previous
// getAppMetrics() call", so no percentage belongs to a fixed window. No timestamp is rewritten.
export function summarizeResources(windows, phase) {
  if (windows.length === 0) return unavailable(`no [scry:resource] window during ${phase}`)
  const usable = windows.filter(window => window.main && Array.isArray(window.processes))
  if (usable.length === 0) return unavailable(`no [scry:resource] window during ${phase} carried a main/process sample`)
  const perWindow = usable.map(window => {
    const byType = {}
    for (const process of window.processes) {
      const entry = byType[process.type] ?? { workingSetBytes: 0, peakWorkingSetBytes: 0, processes: 0 }
      entry.workingSetBytes += process.workingSetBytes ?? 0
      entry.peakWorkingSetBytes += process.peakWorkingSetBytes ?? 0
      entry.processes += 1
      byType[process.type] = entry
    }
    return { sampledAt: window.sampledAt, windowMs: window.windowMs, main: window.main, byType,
      processes: window.processes.length,
      workingSetBytes: window.processes.reduce((total, process) => total + (process.workingSetBytes ?? 0), 0) }
  })
  const types = [...new Set(perWindow.flatMap(window => Object.keys(window.byType)))]
  const processesByType = {}
  for (const type of types) {
    const present = perWindow.filter(window => window.byType[type])
    processesByType[type] = {
      windowsPresent: present.length,
      processesPerWindow: distribution(present.map(window => window.byType[type].processes)),
      workingSetBytesPerWindow: distribution(present.map(window => window.byType[type].workingSetBytes)),
      peakWorkingSetBytesMaxPerWindow: Math.max(...present.map(window => window.byType[type].peakWorkingSetBytes))
    }
  }
  return {
    status: 'measured',
    source: 'main startPerformanceResourceMonitor (SCRY_PERF_LOG=1) windows',
    phase,
    windows: perWindow.length,
    incompleteWindows: windows.length - perWindow.length,
    windowMs: [...new Set(perWindow.map(window => window.windowMs))],
    sampledAt: { first: perWindow[0].sampledAt, last: perWindow.at(-1).sampledAt },
    processesPerWindow: distribution(perWindow.map(window => window.processes)),
    workingSetBytesPerWindow: distribution(perWindow.map(window => window.workingSetBytes)),
    // Windows are kept for memory, process counts and event-loop time only.
    cpuPercent: unavailable('percentCPUUsage is measured since the previous getAppMetrics() call and this harness takes its own '
      + 'boundary snapshots between production 5000 ms windows, so no percentage can be tied to a fixed window'),
    main: {
      rssBytes: distribution(perWindow.map(window => window.main.rssBytes)),
      heapUsedBytes: distribution(perWindow.map(window => window.main.heapUsedBytes)),
      externalBytes: distribution(perWindow.map(window => window.main.externalBytes)),
      arrayBuffersBytes: distribution(perWindow.map(window => window.main.arrayBuffersBytes)),
      eventLoopP95Ms: distribution(perWindow.map(window => window.main.eventLoopP95Ms)),
      eventLoopMaxMsMax: Math.max(...perWindow.map(window => window.main.eventLoopMaxMs))
    },
    processesByType,
    phaseAttribution: 'samples are split by sampling time; a window not fully inside one phase is classified spanning and reported separately, never attributed to a phase'
  }
}

export function summarizePhases(records) {
  const samples = records
    .filter(record => record?.observation?.kind === 'trace')
    .map(record => record.observation.sample)
    .filter(sample => typeof sample?.name === 'string' && (sample.name.startsWith('agent.') || sample.name.startsWith('ipc.agent:')))
  if (samples.length === 0) return unavailable('no agent/ipc named trace was recorded')
  const groups = new Map()
  for (const sample of samples) {
    const group = groups.get(sample.name) ?? { durations: [], outcomes: { completed: 0, error: 0, cancelled: 0, unavailable: 0 } }
    if (finite(sample.durationMs)) group.durations.push(sample.durationMs)
    group.outcomes[sample.outcome] = (group.outcomes[sample.outcome] ?? 0) + 1
    groups.set(sample.name, group)
  }
  return {
    status: 'measured',
    source: 'performance journal kind=trace (normal shutdown flush)',
    attribution: 'aggregate-only; PerformanceTrace carries only provider/platform, so a phase cannot be attributed to one run',
    names: Object.fromEntries([...groups].map(([name, group]) => [name, {
      samples: Object.values(group.outcomes).reduce((total, value) => total + value, 0),
      outcomes: group.outcomes,
      ...(group.durations.length > 0 ? { durationMs: distribution(group.durations) } : { durationMs: null })
    }]))
  }
}

// Production samples [scry:resource] every 5000 ms (src/main/bootstrap/app-lifecycle.ts), so a short
// stream can legitimately produce no window at all. A window covers [sampledAt - windowMs, sampledAt];
// it is assigned to a phase only when it lies inside that phase, otherwise it is reported as spanning,
// because the sample end point is not evidence that the whole interval belonged to one phase.
export function classifyWindowPhase(window, phases) {
  const end = Date.parse(window.sampledAt)
  const start = end - (finite(window.windowMs) ? window.windowMs : 0)
  if (!Number.isFinite(end) || !Number.isFinite(start)) return 'unknown'
  const overlapping = phases.filter(phase => start < phase.until && end > phase.since)
  if (overlapping.length === 0) return 'unknown'
  return overlapping.length === 1 ? overlapping[0].name : 'spanning'
}

// Two in-process boundaries taken by the fixture bootstrap over private Node IPC. The delta is main
// process CPU (user+system) over main's own monotonic clock, and it includes the in-process smoke
// Provider: this is not an isolated Provider CPU measurement, and boundary values are not peaks.
export function summarizeBoundaries({ before, after, cpuCount, startedAtEpochMs, endedAtEpochMs }) {
  if (!before || !after || before.status !== 'measured' || after.status !== 'measured') {
    const missing = (before && before.reason) || (after && after.reason)
    return unavailable(missing ? `boundary snapshots unavailable: ${missing}` : 'no boundary pair for this lane')
  }
  const start = before.snapshot
  const end = after.snapshot
  const cpuUs = (end.cpu.user - start.cpu.user) + (end.cpu.system - start.cpu.system)
  const wallMs = end.monotonicMs - start.monotonicMs
  if (!finite(cpuUs) || !finite(wallMs) || wallMs <= 0) {
    return unavailable('boundary snapshot deltas are not usable (a counter or the monotonic clock went backwards)')
  }
  const cpuMs = cpuUs / 1000
  const byType = {}
  for (const entry of end.metrics ?? []) {
    const type = byType[entry.type] ?? { processes: 0, workingSetBytes: 0 }
    type.processes += 1
    type.workingSetBytes += Number.isFinite(entry.workingSetKb) ? entry.workingSetKb * 1024 : 0
    byType[entry.type] = type
  }
  return {
    status: 'measured',
    source: 'fixture bootstrap Node IPC boundary snapshots: process.cpuUsage + process.hrtime + process.memoryUsage + app.getAppMetrics',
    attribution: 'main process CPU including the in-process offline smoke Provider; not an isolated Provider CPU and not a peak',
    window: { startedAtEpochMs, endedAtEpochMs, wallMs: round(wallMs) },
    cpuMs: round(cpuMs),
    cpuUserMs: round((end.cpu.user - start.cpu.user) / 1000),
    cpuSystemMs: round((end.cpu.system - start.cpu.system) / 1000),
    avgCoresBusy: round(cpuMs / wallMs),
    cpuPercentOfOneCore: round((cpuMs / wallMs) * 100),
    cpuPercentOfMachine: finite(cpuCount) && cpuCount > 0 ? round((cpuMs / wallMs / cpuCount) * 100) : null,
    main: {
      rssBytesStart: start.memory.rss, rssBytesEnd: end.memory.rss, rssDeltaBytes: end.memory.rss - start.memory.rss,
      heapUsedBytesStart: start.memory.heapUsed, heapUsedBytesEnd: end.memory.heapUsed,
      externalBytesEnd: end.memory.external, arrayBuffersBytesEnd: end.memory.arrayBuffers
    },
    appMetricsEnd: { processes: end.metrics?.length ?? 0, byType },
    note: 'sample count 2 (start/end); a peak working set would need continuous sampling and is not claimed'
  }
}

// Per-process CPU from the from-start counter (CPUUsage.cumulativeCPUUsage), matched by pid AND creationTime.
// Only Electron-reported processes present at both boundaries with a usable counter are claimed; new,
// vanished, identity-less, missing-counter or regressed ones are listed, never zeroed, and no OS descendant
// is inferred. Never added to mainProcessCpu (Browser here IS that process) or to task time.
export function summarizeProcessCpu({ before, after, startedAtEpochMs, endedAtEpochMs } = {}) {
  if (!before || !after || before?.status !== 'measured' || after?.status !== 'measured') {
    const missing = (before && before.reason) || (after && after.reason)
    return unavailable(missing ? `boundary snapshots unavailable: ${missing}` : 'no boundary pair for this lane')
  }
  const startMetrics = before.snapshot?.metrics
  const endMetrics = after.snapshot?.metrics
  if (!Array.isArray(startMetrics) || !Array.isArray(endMetrics)) return unavailable('a boundary snapshot carried no getAppMetrics() list')
  const key = entry => (Number.isFinite(entry?.pid) && Number.isFinite(entry?.creationTime)
    ? `${entry.pid}@${entry.creationTime}` : null)
  const startByKey = new Map()
  const unidentified = []
  for (const entry of startMetrics) {
    const identity = key(entry)
    if (identity) startByKey.set(identity, entry)
    else unidentified.push({ pid: entry?.pid ?? null, type: entry?.type ?? null, sample: 'before' })
  }
  const byType = {}
  const added = []
  const removed = []
  const missingCounter = []
  const regressed = []
  let totalMs = 0
  let matched = 0
  const endKeys = new Set()
  for (const entry of endMetrics) {
    const identity = key(entry)
    if (!identity) { unidentified.push({ pid: entry?.pid ?? null, type: entry?.type ?? null, sample: 'after' }); continue }
    endKeys.add(identity)
    const start = startByKey.get(identity)
    if (!start) { added.push({ pid: entry.pid, type: entry.type }); continue }
    if (!finite(entry.cumulativeCpuSeconds) || !finite(start.cumulativeCpuSeconds)) {
      missingCounter.push({ pid: entry.pid, type: entry.type }); continue
    }
    const deltaMs = (entry.cumulativeCpuSeconds - start.cumulativeCpuSeconds) * 1000
    if (deltaMs < 0) { regressed.push({ pid: entry.pid, type: entry.type, deltaMs: round(deltaMs) }); continue }
    const bucket = byType[entry.type] ?? { processes: 0, cpuMs: 0 }
    bucket.processes += 1
    bucket.cpuMs = round(bucket.cpuMs + deltaMs)
    byType[entry.type] = bucket
    totalMs += deltaMs
    matched += 1
  }
  for (const [identity, entry] of startByKey) {
    if (!endKeys.has(identity)) removed.push({ pid: entry.pid, type: entry.type })
  }
  const coverage = {
    endProcesses: endMetrics.length,
    matchedProcesses: matched,
    addedProcesses: added.length,
    removedProcesses: removed.length,
    unidentifiedProcesses: unidentified.length,
    missingCounterProcesses: missingCounter.length,
    regressedProcesses: regressed.length,
    matchedShare: endMetrics.length > 0 ? round(matched / endMetrics.length) : null
  }
  const incomplete = coverage.addedProcesses + coverage.removedProcesses + coverage.unidentifiedProcesses
    + coverage.missingCounterProcesses + coverage.regressedProcesses > 0
  if (matched === 0) {
    return { status: 'unavailable', reason: 'no Electron-reportable process matched by pid + creationTime carried a valid cumulative CPU counter',
      coverage, added, removed, unidentified, missingCounter, regressed,
      note: 'process CPU is not inferred; no OS descendant is assumed' }
  }
  return {
    status: incomplete ? 'partial' : 'measured',
    source: 'app.getAppMetrics() cumulativeCPUUsage delta across the same two boundaries, matched by pid + creationTime',
    attribution: 'Electron-reported processes only; never added to mainProcessCpu (Browser here is that process) or task time',
    window: { startedAtEpochMs, endedAtEpochMs },
    byType,
    totalCpuMs: round(totalMs),
    coverage,
    ...(added.length > 0 ? { added } : {}),
    ...(removed.length > 0 ? { removed } : {}),
    ...(unidentified.length > 0 ? { unidentified } : {}),
    ...(missingCounter.length > 0 ? { missingCounter } : {}),
    ...(regressed.length > 0 ? { regressed } : {}),
    note: incomplete ? 'partial: only the matched processes are claimed; the rest are listed, not zeroed'
      : 'every described process matched by pid + creationTime; unreported processes are unknown'
  }
}

// Renderer main-thread task time from the browser's own counters. Not renderer process CPU, not a
// frame budget, and not React commit latency.
export function summarizeRendererTask({ before, after, cpuCount }) {
  if (!finite(before?.taskDurationSeconds) || !finite(after?.taskDurationSeconds) || !finite(before?.timestampSeconds) || !finite(after?.timestampSeconds)) {
    return unavailable('CDP Performance.getMetrics TaskDuration was not readable at both boundaries')
  }
  const taskMs = (after.taskDurationSeconds - before.taskDurationSeconds) * 1000
  const wallMs = (after.timestampSeconds - before.timestampSeconds) * 1000
  if (!(taskMs >= 0) || !(wallMs > 0)) return unavailable('renderer metric deltas are not usable')
  return {
    status: 'measured',
    source: 'CDP Performance.getMetrics TaskDuration delta across the same two boundaries',
    attribution: 'renderer main thread task time; not renderer process CPU, not frame time, not React commit latency',
    taskMs: round(taskMs),
    wallMs: round(wallMs),
    taskShareOfRendererWall: round(taskMs / wallMs),
    jsHeapUsedBytesEnd: finite(after.jsHeapUsedBytes) ? after.jsHeapUsedBytes : null,
    nodesEnd: finite(after.nodes) ? after.nodes : null,
    machineShare: finite(cpuCount) && cpuCount > 0 ? round((taskMs / wallMs / cpuCount) * 100) / 100 : null
  }
}

// Boundary pairing is the guarantee that the active CPU window never includes the quiet wait: the
// active pair always ends at a boundary taken right after the last terminal, and quiet is measured only
// from that boundary to a separate after-quiet boundary. Non-quiet scenarios produce no quiet pair at
// all instead of reusing the active numbers.
export function pairBoundaries({ before, afterTerminal, afterQuiet, quietWindowMs }) {
  assert.ok(before && afterTerminal, 'active boundary pair requires the before and after-terminal samples')
  const mainPair = (from, to) => ({ before: from.main, after: to.main,
    startedAtEpochMs: from.takenAtEpochMs, endedAtEpochMs: to.takenAtEpochMs })
  const rendererPair = (from, to) => ({ before: from.renderer, after: to.renderer })
  return {
    active: { main: mainPair(before, afterTerminal), renderer: rendererPair(before, afterTerminal) },
    quiet: quietWindowMs > 0 && afterQuiet
      ? { main: mainPair(afterTerminal, afterQuiet), renderer: rendererPair(afterTerminal, afterQuiet) }
      : null,
    quietIncomplete: quietWindowMs > 0 && !afterQuiet
  }
}

// Overlap of the observed intervals, reported as two different numbers that must never be mixed:
// `requested` is dispatch -> terminal and can include time queued before a run is accepted, while
// `acceptedActive` starts at the start reply and is only a lower bound on overlapping activity. A run
// whose terminal arrived before its start reply is recorded as a zero-length accepted window with
// terminalBeforeReply set, so a negative duration is never clamped into a normal-looking interval.
export function summarizeObservedConcurrency({ configured, intervals }) {
  const usable = (intervals ?? []).filter(interval => finite(interval.requestedStartEpochMs)
    && finite(interval.requestedEndEpochMs))
  if (usable.length === 0) return unavailable('no usable run interval was recorded')
  const peakOf = spans => {
    const events = spans.flatMap(span => [{ at: span.start, delta: 1 }, { at: span.end, delta: -1 }])
      .sort((left, right) => left.at - right.at || left.delta - right.delta)
    let live = 0
    let peak = 0
    let peakAt = null
    for (const event of events) {
      live += event.delta
      if (live > peak) { peak = live; peakAt = event.at }
    }
    const spanStart = Math.min(...spans.map(span => span.start))
    const spanEnd = Math.max(...spans.map(span => span.end))
    return { peak, peakAt, spanMs: round(spanEnd - spanStart) }
  }
  const verdictOf = peak => peak >= configured ? 'overlap-confirmed' : 'below-configured'
  const requestedSpans = usable.map(interval => ({ runId: interval.runId,
    start: interval.requestedStartEpochMs, end: interval.requestedEndEpochMs }))
  const missingReply = usable.filter(interval => !finite(interval.acceptedStartEpochMs))
  const acceptedSpans = usable.filter(interval => finite(interval.acceptedStartEpochMs)).map(interval => {
    const terminalBeforeReply = interval.requestedEndEpochMs < interval.acceptedStartEpochMs
    return { runId: interval.runId, acceptedStartEpochMs: interval.acceptedStartEpochMs,
      terminalAtEpochMs: interval.requestedEndEpochMs, terminalBeforeReply,
      start: interval.acceptedStartEpochMs,
      end: terminalBeforeReply ? interval.acceptedStartEpochMs : interval.requestedEndEpochMs,
      durationMs: terminalBeforeReply ? 0 : interval.requestedEndEpochMs - interval.acceptedStartEpochMs }
  })
  const requested = peakOf(requestedSpans)
  const accepted = acceptedSpans.length > 0 ? peakOf(acceptedSpans) : null
  return {
    status: 'measured',
    source: 'page-clock intervals: requested = dispatch -> terminal, accepted = start reply -> terminal',
    configured,
    runs: usable.length,
    requested: { peakConcurrentRuns: requested.peak, peakAtEpochMs: requested.peakAt, spanMs: requested.spanMs,
      verdict: verdictOf(requested.peak),
      note: 'includes time a run spent dispatched but not yet accepted; not CPU-level parallelism',
      intervals: requestedSpans },
    acceptedActive: accepted === null
      ? unavailable(`start reply time is missing for ${missingReply.length} run(s)`)
      : { peakConcurrentRuns: accepted.peak, peakAtEpochMs: accepted.peakAt, spanMs: accepted.spanMs,
        verdict: verdictOf(accepted.peak),
        terminalBeforeReplyRuns: acceptedSpans.filter(span => span.terminalBeforeReply).length,
        note: 'lower bound on overlapping activity: a run whose terminal preceded its start reply counts as a '
          + 'zero-length accepted window, so its duration is not a normal sustained interval',
        intervals: acceptedSpans },
    note: 'neither number proves CPU-level parallelism or a native Provider process count'
  }
}

// Native DOM check of what the transcript actually mounted at the end of the run. Only the focused
// run is mirrored, so an unmounted run is a fact about mirroring, not a failed run.
export function summarizeRendererMount(rows) {
  const usable = (rows ?? []).filter(row => typeof row?.runId === 'string')
  if (usable.length === 0) return unavailable('no run was queried for transcript mounting')
  const mounted = usable.filter(row => row.mounted === true)
  return {
    status: 'measured',
    source: 'document.querySelector([data-run-id]) on the real transcript after all runs settled',
    runs: usable.length,
    mountedRuns: mounted.length,
    textChars: Object.fromEntries(usable.map(row => [row.runId, row.textChars ?? 0])),
    note: 'mirrors the focused run only; a mounted transcript is DOM evidence, not a commit or paint proof'
  }
}
