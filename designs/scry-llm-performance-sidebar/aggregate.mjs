// Prototype evidence contract: live-output means authoritative main-output
// token counts aligned to the measured stream interval, not final-only usage.
export function aggregateRunning(runs) {
  const active = runs.filter(run => run.running)
  const average = values => {
    const measured = values.filter(value => value !== null)
    return {
      value: measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null,
      measured: measured.length
    }
  }
  return {
    running: active.length,
    outputting: active.filter(run => run.phase === 'output').length,
    current: average(active.map(run => run.phase === 'output' && run.tokenEvidence === 'live-output' ? run.currentTokenRate : null)),
    wait: average(active.map(run => run.firstWait)),
    sessionAverage: average(active.map(run => run.tokenEvidence === 'live-output' ? run.averageTokenRate : null))
  }
}

export function prototypeRuns(state = 'stream') {
  const runs = [
    {running:true, phase:'output', tokenEvidence:'live-output', currentTokenRate:38, firstWait:1, averageTokenRate:30},
    {running:true, phase:'output', tokenEvidence:'live-output', currentTokenRate:30, firstWait:1.4, averageTokenRate:28},
    {running:true, phase:'output', tokenEvidence:'live-output', currentTokenRate:28, firstWait:1.8, averageTokenRate:26},
    {running:true, phase:'tool', tokenEvidence:'live-output', currentTokenRate:null, firstWait:1.3, averageTokenRate:29},
    {running:true, phase:'tool', tokenEvidence:'live-output', currentTokenRate:null, firstWait:1.5, averageTokenRate:27}
  ]
  if (state === 'empty' || state === 'complete') return []
  if (state === 'tool') return runs.map(run => ({...run, phase:'tool', currentTokenRate:null}))
  if (state === 'waiting') return runs.map(run => ({...run, phase:'waiting', currentTokenRate:null, firstWait:null, averageTokenRate:null}))
  if (state === 'unavailable') {
    return runs.map(run => ({...run, tokenEvidence:'final-only', currentTokenRate:null, averageTokenRate:null}))
  }
  if (state === 'partial') {
    return runs.map((run, index) => index === 0 ? run : {...run, tokenEvidence:'final-only', currentTokenRate:null, averageTokenRate:null})
  }
  if (state === 'long') {
    return runs.map(run => ({...run, currentTokenRate:run.currentTokenRate === null ? null : 12804, firstWait:128.6, averageTokenRate:9800}))
  }
  return runs
}
