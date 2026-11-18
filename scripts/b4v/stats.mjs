// Percentiles and load gating for the S0-6 startup timing (b4s-startup-timing.mjs).
//
// Same percentile convention as daemon-mode-timing.mjs (nearest rank on the sorted
// samples, index floor(n * fraction)), so numbers from both scripts compare directly.
// A measurement that could not be taken stays out of the sample set: it is reported as
// missing, never as 0.

export const DEFAULT_MAX_LOAD_PER_CORE = 0.5

export function finiteSamples(values) {
  return (values ?? []).filter((value) => typeof value === 'number' && Number.isFinite(value))
}

export function percentile(values, fraction) {
  if (!(fraction >= 0 && fraction <= 1)) throw new Error(`percentile fraction out of range: ${fraction}`)
  const samples = finiteSamples(values)
  if (samples.length === 0) return null
  const sorted = [...samples].sort((left, right) => left - right)
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(2))
}

export function summarize(values) {
  const samples = finiteSamples(values)
  const missing = (values ?? []).length - samples.length
  if (samples.length === 0) return { samples: 0, missing, p50: null, p95: null, min: null, max: null }
  return {
    samples: samples.length,
    missing,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    min: Number(Math.min(...samples).toFixed(2)),
    max: Number(Math.max(...samples).toFixed(2))
  }
}

export function loadPerCore(reading) {
  if (!reading || !(reading.cores > 0) || !Number.isFinite(reading.load1)) return null
  return Number((reading.load1 / reading.cores).toFixed(3))
}

/**
 * The round is void when any reading exceeds the bound or could not be taken: a
 * millisecond number measured on a busy machine is the machine's number, not Scry's.
 */
export function loadVerdict(readings, maxPerCore = DEFAULT_MAX_LOAD_PER_CORE) {
  const evaluated = (readings ?? []).map((reading) => ({ ...reading, perCore: loadPerCore(reading) }))
  const unreadable = evaluated.filter((reading) => reading.perCore === null)
  const exceeded = evaluated.filter((reading) => reading.perCore !== null && reading.perCore > maxPerCore)
  const worst = evaluated.reduce((max, reading) => reading.perCore !== null && reading.perCore > max ? reading.perCore : max, 0)
  return {
    maxPerCore,
    readings: evaluated.length,
    worstPerCore: evaluated.length === 0 ? null : worst,
    exceeded: exceeded.map(({ at, label, perCore }) => ({ at, label, perCore })),
    unreadable: unreadable.length,
    void: evaluated.length === 0 || exceeded.length > 0 || unreadable.length > 0
  }
}

/** Every reason a round must not be reported, in a stable order. */
export function voidReasons({ load, underTimingLock, invalidSamples = 0, error }) {
  const reasons = []
  if (error) reasons.push('round_error')
  if (!load || load.void) reasons.push(load && load.readings > 0 && load.unreadable === 0 ? 'load_exceeded' : 'load_unavailable')
  if (underTimingLock !== true) reasons.push('not_under_timing_lock')
  if (invalidSamples > 0) reasons.push('invalid_samples')
  return reasons
}

/**
 * Per case and metric: P50/P95 only when the round is valid. A void round keeps its raw
 * samples for diagnosis, but publishes no percentile that could be quoted as a result.
 */
export function timingSummary(cases, { reasons }) {
  const isVoid = reasons.length > 0
  const summary = {}
  for (const [name, samples] of Object.entries(cases)) {
    const metrics = new Set(samples.flatMap((sample) => Object.keys(sample.metrics ?? {})))
    summary[name] = {}
    for (const metric of [...metrics].sort()) {
      const values = samples.filter((sample) => sample.valid === true).map((sample) => sample.metrics[metric])
      const stats = summarize(values)
      summary[name][metric] = isVoid ? { samples: stats.samples, missing: stats.missing, p50: null, p95: null, void: true } : stats
    }
  }
  return { void: isVoid, reasons, cases: summary }
}
