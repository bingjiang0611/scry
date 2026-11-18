// Three complete and three stopped runs through the shipped preload API, in either App
// runtime (in-process main, or the daemon with SCRY_HOST_DAEMON=1).
export async function measureLifecycle({ evaluate, cwd }) {
  // Real main/preload/SQLite/archive lifecycle with an explicit offline Provider fixture.
  // These are IPC/terminal/disk boundaries, NOT native send-button or visible-output timings.
  const lifecycleSamples = []
  for (const stopped of [false, true, false, true, false, true]) {
    const result = await evaluate(`(async () => {
      const cwd = ${JSON.stringify(cwd)}
      const stopped = ${stopped}
      const prompt = stopped ? 'performance long stream' : 'desktop remote performance'
      let firstTextAt, resolveFirst, resolveDone, rejectFailure
      const firstText = new Promise(resolve => { resolveFirst = resolve })
      const terminal = new Promise(resolve => { resolveDone = resolve })
      const failure = new Promise((_, reject) => { rejectFailure = reject })
      const timer = setTimeout(() => rejectFailure(new Error('native lifecycle terminal deadline exceeded')), 15000)
      const offTrace = window.scry.onTrace(events => {
        if (firstTextAt === undefined && events.some(event => event.kind === 'model' && ['text', 'text_delta'].includes(event.stage))) {
          firstTextAt = performance.now(); resolveFirst()
        }
      })
      const offDone = window.scry.onTurnDone(event => resolveDone({ event, at: performance.now() }))
      const offError = window.scry.onError(event => rejectFailure(new Error(event.message)))
      try {
        return await Promise.race([failure, (async () => {
          const startedAt = performance.now()
          const started = await window.scry.start({ providerId: 'codex', cwd, prompt })
          const receiptAt = performance.now()
          await window.scry.focusRun(started.runId)
          await firstText
          let stopRequestedAt, stopReceiptMs
          if (stopped) {
            stopRequestedAt = performance.now()
            if (await window.scry.stop(started.runId) !== true) throw new Error('stop was not accepted')
            stopReceiptMs = performance.now() - stopRequestedAt
          }
          const { event: done, at: terminalAt } = await terminal
          if (done.runId !== started.runId || Boolean(done.stopped) !== stopped) throw new Error('wrong terminal identity/outcome')
          const externalSessionId = done.externalSessionId || done.sessionId
          const page = await window.scry.loadSession({ providerId: 'codex', cwd, externalSessionId })
          const archiveReadableAt = performance.now()
          const turn = page.turns.find(turn => turn.runId === started.runId)
          if (!turn?.done || turn.userText !== prompt) throw new Error('terminal turn not durably readable')
          if (!stopped && !turn.items.some(item => item.text === 'isolated remote assistant evidence')) throw new Error('archive lost full assistant output')
          if ((await window.scry.activeRuns()).some(run => run.runId === started.runId)) throw new Error('run did not settle')
          return { runId: started.runId, stopped, startedAtEpochMs: performance.timeOrigin + startedAt,
            terminalAtEpochMs: performance.timeOrigin + terminalAt,
            ...(stopped ? { stopRequestedAtEpochMs: performance.timeOrigin + stopRequestedAt } : {}),
            startReceiptMs: receiptAt - startedAt, firstOutputReceiptMs: firstTextAt - startedAt,
            startToTerminalMs: terminalAt - startedAt, terminalToReadableArchiveMs: archiveReadableAt - terminalAt,
            ...(stopped ? { stopReceiptMs, stopToTerminalMs: terminalAt - stopRequestedAt } : {}),
            durableTurns: 1, terminalConfirmed: true }
        })()])
      } finally { clearTimeout(timer); offTrace(); offDone(); offError() }
    })()`)
    lifecycleSamples.push(result)
  }
  return lifecycleSamples
}
