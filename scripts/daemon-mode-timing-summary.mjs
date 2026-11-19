// Pure timeline selection and percentile/segment aggregation for S1 daemon timing.

export const percentile = (values, fraction) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(2))
}

export const selectTimeline = (marks, submittedWall, until, expectedRunId) => {
  const stages = {}
  const runIds = new Set()
  const sampleRunIds = new Set()
  if (typeof expectedRunId === 'string' && expectedRunId.length > 0) {
    runIds.add(expectedRunId)
    sampleRunIds.add(expectedRunId)
  }
  const pendingOrch = []
  for (const mark of marks) {
    if (typeof mark?.runId !== 'string' || typeof mark?.at !== 'number') continue
    if (mark.at < submittedWall - 200 || mark.at > until + 2_000) continue
    if (mark.stage === 'orchCommit') {
      pendingOrch.push(mark)
      continue
    }
    runIds.add(mark.runId)
    if (mark.stage === 'submit' || mark.stage === 'intentDurable' || mark.stage === 'dispatch') {
      sampleRunIds.add(mark.runId)
    }
    if (stages[mark.stage] === undefined || mark.at < stages[mark.stage]) stages[mark.stage] = mark.at
  }
  const matchIds = sampleRunIds.size > 0 ? sampleRunIds : runIds
  const orchCommits = pendingOrch
    .filter((mark) => matchIds.has(mark.runId) || (typeof mark.ledgerRunId === 'string' && matchIds.has(mark.ledgerRunId)))
    .map((mark) => ({
      runId: mark.runId,
      ledgerRunId: mark.ledgerRunId,
      commitKind: mark.commitKind,
      durationMs: mark.durationMs,
      ...(typeof mark.sinkDurationMs === 'number' ? { sinkDurationMs: mark.sinkDurationMs } : {}),
      ...(typeof mark.bodyBytes === 'number' ? { bodyBytes: mark.bodyBytes } : {}),
      preFirstToken: Boolean(mark.preFirstToken)
    }))
  return [...runIds].length === 0 ? null : { ...stages, runIds: [...runIds], orchCommits }
}

const SEGMENTS = {
  submittedToFirstText: (t) => t.firstTextReceivedAt - t.submittedWall,
  submittedToProvider: (t) => t.providerStart - t.submittedWall,
  submitToDurable: (t) => t.intentDurable - t.submit,
  durableToDispatch: (t) => t.dispatch - t.intentDurable,
  dispatchToProvider: (t) => t.providerStart - t.dispatch,
  providerToFirstOutput: (t) => t.firstOutput - t.providerStart,
  firstOutputToTraceRead: (t) => t.traceRead - t.firstOutput,
  traceReadToBridgeQueue: (t) => t.bridgeQueue - t.traceRead,
  bridgeQueueToFlush: (t) => t.bridgeFlush - t.bridgeQueue,
  traceReadToWatchReply: (t) => t.watchReply - t.traceRead,
  watchReplyToAppPush: (t) => t.rendererPush - t.watchReply,
  appPushToRenderer: (t, run) => run.firstTextReceivedAt - t.rendererPush,
  firstOutputToRenderer: (t, run) => run.firstTextReceivedAt - t.firstOutput,
  providerToRenderer: (t, run) => run.firstTextReceivedAt - t.providerStart,
  submitToFirstText: (t, run) => run.firstTextReceivedAt - t.submit
}

const summarizeOrchCommits = (runs) => {
  const preCounts = []
  const preSums = []
  const preSinkSums = []
  const singles = []
  const singleSinks = []
  let maxBodyBytes = 0
  for (const run of runs) {
    const commits = run.timeline?.orchCommits ?? []
    if (commits.length === 0) continue
    const pre = commits.filter((c) => c.preFirstToken)
    preCounts.push(pre.length)
    preSums.push(Number(pre.reduce((acc, c) => acc + c.durationMs, 0).toFixed(3)))
    if (pre.every((c) => typeof c.sinkDurationMs === 'number')) {
      preSinkSums.push(Number(pre.reduce((acc, c) => acc + c.sinkDurationMs, 0).toFixed(3)))
    }
    for (const c of commits) {
      singles.push(c.durationMs)
      if (typeof c.sinkDurationMs === 'number') singleSinks.push(c.sinkDurationMs)
      if (typeof c.bodyBytes === 'number' && c.bodyBytes > maxBodyBytes) maxBodyBytes = c.bodyBytes
    }
  }
  return {
    runsMeasured: preCounts.length,
    preFirstTokenCountP50: percentile(preCounts, 0.5),
    preFirstTokenCountP95: percentile(preCounts, 0.95),
    preFirstTokenSumP50Ms: percentile(preSums, 0.5),
    preFirstTokenSumP95Ms: percentile(preSums, 0.95),
    preFirstTokenSinkSumP50Ms: percentile(preSinkSums, 0.5),
    preFirstTokenSinkSumP95Ms: percentile(preSinkSums, 0.95),
    singleCommitSamples: singles.length,
    singleCommitP50Ms: percentile(singles, 0.5),
    singleCommitP95Ms: percentile(singles, 0.95),
    singleSinkP50Ms: percentile(singleSinks, 0.5),
    singleSinkP95Ms: percentile(singleSinks, 0.95),
    maxBodyBytes
  }
}

export function buildTimingSummary(runs, perInstance) {
  const firstText = runs.map((run) => run.firstTextMs).filter((value) => typeof value === 'number')
  const intervals = runs.flatMap((run) => run.intervals)
  const settled = runs.map((run) => run.settledMs).filter((value) => typeof value === 'number')
  const lag = runs.flatMap((run) => run.lag)
  const stageValues = {}
  for (const run of runs) {
    for (const [stage, ms] of Object.entries(run.stages ?? {})) (stageValues[stage] ??= []).push(ms)
  }
  const stages = Object.fromEntries(
    Object.entries(stageValues).map(([stage, values]) => [
      stage,
      { samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
    ])
  )
  const segments = Object.fromEntries(
    Object.entries(SEGMENTS).map(([name, read]) => {
      const values = []
      for (const run of runs) {
        if (!run.timeline || typeof run.firstTextReceivedAt !== 'number') continue
        const timeline = { ...run.timeline, firstTextReceivedAt: run.firstTextReceivedAt, submittedWall: run.submittedWall }
        let value
        try { value = read(timeline, run) } catch { continue }
        if (typeof value === 'number' && Number.isFinite(value)) values.push(Number(value.toFixed(2)))
      }
      return [name, { samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }]
    })
  )
  const warmRuns = runs.filter((run) => run.index % perInstance !== 0)
  const warmFirstText = warmRuns.map((run) => run.firstTextMs).filter((value) => typeof value === 'number')
  const coldFirstText = runs
    .filter((run) => run.index % perInstance === 0 && typeof run.firstTextMs === 'number')
    .map((run) => Number(run.firstTextMs.toFixed(2)))
  return {
    stages,
    segments,
    summary: {
      runs: runs.length,
      runsWithFirstText: firstText.length,
      firstTextP50: percentile(firstText, 0.5),
      firstTextP95: percentile(firstText, 0.95),
      warmSamples: warmFirstText.length,
      warmFirstTextP50: percentile(warmFirstText, 0.5),
      warmFirstTextP95: percentile(warmFirstText, 0.95),
      coldFirstText,
      orchCommits: summarizeOrchCommits(runs),
      warmOrchCommits: summarizeOrchCommits(warmRuns),
      deltaSamples: intervals.length,
      deltaP50: percentile(intervals, 0.5),
      deltaP95: percentile(intervals, 0.95),
      settledP50: percentile(settled, 0.5),
      settledP95: percentile(settled, 0.95),
      eventLagSamples: lag.length,
      eventLagP50: percentile(lag, 0.5),
      eventLagP95: percentile(lag, 0.95)
    }
  }
}
