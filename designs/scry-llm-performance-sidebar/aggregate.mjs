// Design contract only: all numbers come from explicit prototype run samples.
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
    current: average(active.map(run => run.phase === 'output' ? run.currentRate : null)),
    wait: average(active.map(run => run.firstWait)),
    sessionAverage: average(active.map(run => run.averageRate))
  }
}

export function prototypeRuns(state = 'stream') {
  const runs = [
    {running:true, phase:'output', currentRate:92, firstWait:1, averageRate:86},
    {running:true, phase:'output', currentRate:80, firstWait:1.4, averageRate:75},
    {running:true, phase:'output', currentRate:80, firstWait:1.8, averageRate:73},
    {running:true, phase:'tool', currentRate:null, firstWait:1.3, averageRate:79},
    {running:true, phase:'tool', currentRate:null, firstWait:1.5, averageRate:77}
  ]
  if (state === 'empty' || state === 'complete') return []
  if (state === 'tool') return runs.map(run => ({...run, phase:'tool', currentRate:null}))
  if (state === 'waiting' || state === 'unavailable') {
    return runs.map(run => ({...run, phase:state, currentRate:null, firstWait:null, averageRate:null}))
  }
  if (state === 'partial') {
    return runs.map((run, index) => index === 0 ? run : {...run, phase:'unavailable', currentRate:null, firstWait:null, averageRate:null})
  }
  if (state === 'long') {
    return runs.map(run => ({...run, currentRate:run.currentRate === null ? null : 12804, firstWait:128.6, averageRate:9800}))
  }
  return runs
}
