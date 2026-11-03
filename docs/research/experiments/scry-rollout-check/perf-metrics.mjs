// Shared definitions for reading perf-bench results: which fields identify the machine and the
// workload of each phase, and how every phase is flattened into named metrics. perf-compare
// (baseline from repeated runs) and perf-ab (baseline vs candidate) both use this module, so a
// metric means the same thing in both.
//
// Metric value: { value, unit, p95?, n?, kind } or { unavailable: reason }.
// kind "time" = wall-clock milliseconds (noisy, L2); "count" = exact work counts such as git
// subprocesses or transport requests (L1); "resource" = memory, CPU, disk; "rate" = records/s;
// "evidence" = digest of the normalised record of a fixed dirty turn (must not change);
// "derived" = computed from other metrics (e.g. wrapper overhead); shown, not judged.

export const PHASES = ['recorder', 'uploader', 'hookwrap']

export const get = (obj, path) => path.split('.').reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), obj)

// Same machine and setup: required for any comparison.
export const MACHINE = ['environment.platform', 'environment.release', 'environment.arch', 'environment.cpu', 'environment.cpuCount',
  'environment.memoryGiB', 'environment.macos', 'environment.node']

// Workload of each phase: must match between runs that are compared. Versions are listed
// separately because an A/B comparison is expected to change them.
export const WORKLOAD = {
  recorder: ['environment.git', 'rounds', 'recorder.provider', 'repository.name', 'repository.tracked', 'repository.commits',
    'repository.gitDirMiB', 'repository.submodules', 'repository.nestedRepos'],
  // The uploader payload is built from the copy's recorder records, so it is part of the workload.
  uploader: ['rounds', 'uploader.payload', 'uploader.transport', 'uploader.contentBlobs'],
  hookwrap: ['environment.git', 'rounds', 'hookwrap.provider', 'hookwrap.uploaderScry', 'repository.name', 'repository.tracked',
    'repository.commits', 'repository.submodules', 'repository.nestedRepos']
}
export const VERSIONS = {
  recorder: ['versions.scry'],
  uploader: ['versions.uploader'],
  hookwrap: ['versions.scry', 'versions.uploader']
}

const UNIT_BY_NAME = [[/Ms$/, 'ms'], [/MiB$/, 'MiB'], [/KiB/, 'KiB'], [/PerSecond$/, 'rec/s'], [/cpuSeconds/, 's'], [/Pcpu$/, '%cpu']]
const unitOf = (name) => UNIT_BY_NAME.find(([re]) => re.test(name))?.[1] ?? 'count'
const KIND_BY_UNIT = { ms: 'time', count: 'count', 'rec/s': 'rate' }
const kindOf = (unit) => KIND_BY_UNIT[unit] ?? 'resource'

export function metric(raw, name) {
  if (raw === undefined || raw === null) return { unavailable: 'not reported' }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { unavailable: 'not a finite number' }
    const unit = unitOf(name)
    return { value: raw, unit, kind: kindOf(unit) }
  }
  if (typeof raw === 'object' && raw.status === 'measured' && typeof raw.p50 === 'number') {
    const unit = raw.unit ?? unitOf(name)
    return { value: raw.p50, p95: raw.p95, n: raw.n, unit, kind: kindOf(unit), ...(Array.isArray(raw.samples) ? { samples: raw.samples } : {}) }
  }
  if (typeof raw === 'object' && raw.status === 'unavailable') return { unavailable: raw.reason ?? 'unavailable' }
  return { unavailable: `unrecognised value ${JSON.stringify(raw).slice(0, 80)}` }
}

const TURN_FIELDS = ['turnStart', 'toolEvent', 'stop', 'hookTotalPerTurn', 'stopToRecordVisible']
const COUNT_FIELDS = ['turnStart', 'toolEvents', 'stop', 'total']

function gitCountMetrics(out, prefix, g) {
  for (const f of COUNT_FIELDS) {
    if (!g) out[`${prefix} / gitCalls.${f}`] = { unavailable: 'git calls not counted (older perf-bench)' }
    else if (g.status !== 'measured') out[`${prefix} / gitCalls.${f}`] = { unavailable: g.reason ?? 'git calls not counted' }
    else out[`${prefix} / gitCalls.${f}`] = { value: g[f], unit: 'count', kind: 'count' }
  }
}

function recorderMetrics(rec) {
  const out = {}
  if (!rec || rec.status === 'unavailable' || !rec.modes) return { out, phaseReason: rec?.reason ?? 'recorder phase not measured' }
  for (const [mode, scenarios] of Object.entries(rec.modes)) {
    for (const [scenario, m] of Object.entries(scenarios)) {
      for (const field of TURN_FIELDS) out[`recorder / ${mode} / ${scenario} / ${field}`] = metric(m[field], field)
      if (m.gitCalls !== undefined) gitCountMetrics(out, `recorder / ${mode} / ${scenario}`, m.gitCalls)
    }
  }
  const d = rec.daemon ?? {}
  const daemonMissing = d.status === 'unavailable' ? { unavailable: d.reason } : undefined
  for (const k of ['afterWarmup', 'afterRun', 'after30sIdle']) out[`recorder / daemon / rssMiB.${k}`] = daemonMissing ?? metric(d.rssMiB?.[k], 'rssMiB')
  for (const k of ['cpuSecondsDuringRun', 'cpuSecondsIn30sIdle']) out[`recorder / daemon / ${k}`] = daemonMissing ?? metric(d[k], k)
  if (rec.evidence !== undefined) out['recorder / evidence digest (dirty turn)'] = rec.evidence?.status === 'measured'
    ? { value: rec.evidence.digest, unit: 'sha256', kind: 'evidence' } : { unavailable: rec.evidence?.reason ?? 'evidence not captured' }
  out['recorder / disk / kibPerRecord'] = metric(rec.disk?.kibPerRecord, 'diskKiB')
  out['recorder / hookSkips'] = metric(rec.hookSkips, 'hookSkips')
  return { out }
}

export const UPLOADER_FIELDS = ['notify', 'commitPhaseMs', 'drainAfterLastCommitMs', 'recordsPerSecond', 'transportRequests', 'recordsPerRequest',
  'requestKiB', 'capabilityCalls', 'deadLetters', 'worker.peakConcurrent', 'worker.peakRssMiB', 'uploadDirKiBPerRecord']

function uploaderMetrics(up) {
  const out = {}
  if (!up) return { out, phaseReason: 'uploader phase not run' }
  out['uploader / notifyWhileUploading'] = metric(up.notifyWhileUploading, 'notifyMs')
  for (const [name, r] of Object.entries(up.runs ?? {})) {
    const p = `uploader / ${name}`
    if (r.status !== 'measured') {
      for (const f of UPLOADER_FIELDS) out[`${p} / ${f}`] = { unavailable: r.reason ?? 'scenario not measured' }
      continue
    }
    for (const f of UPLOADER_FIELDS) {
      const m = metric(get(r, f), f.split('.').pop())
      // deadLetters and peak worker count are counts of outcomes, not work done: still exact.
      out[`${p} / ${f}`] = m
    }
  }
  return { out, phaseReason: up.status === 'unavailable' ? up.reason : undefined }
}

function hookwrapMetrics(h) {
  const out = {}
  if (!h || h.status === 'unavailable' || !h.modes || !Object.keys(h.modes).length) return { out, phaseReason: h?.reason ?? 'hookwrap phase not measured' }
  for (const [mode, scenarios] of Object.entries(h.modes)) {
    for (const [scenario, m] of Object.entries(scenarios)) {
      const p = `hookwrap / ${mode} / ${scenario}`
      for (const field of TURN_FIELDS) {
        out[`${p} / wrapped.${field}`] = metric(m.wrapped?.[field], field)
        out[`${p} / plain.${field}`] = metric(m.plain?.[field], field)
        // Derived (wrapped p50 - plain p50, no raw samples): reported, never judged on its own.
        const o = metric(m.overhead?.[field], field)
        out[`${p} / overhead.${field}`] = o.unavailable === undefined ? { ...o, kind: 'derived' } : o
      }
      if (m.wrapped?.gitCalls !== undefined) gitCountMetrics(out, `${p} / wrapped`, m.wrapped.gitCalls)
      if (m.plain?.gitCalls !== undefined) gitCountMetrics(out, `${p} / plain`, m.plain.gitCalls)
    }
  }
  out['hookwrap / wakeup launcher'] = metric(h.wakeup, 'wakeupMs')
  const u = h.uploads ?? {}
  out['hookwrap / uploads / notUploaded'] = typeof u.records === 'number' && typeof u.uploaded === 'number'
    ? { value: u.records - u.uploaded, unit: 'count', kind: 'count' } : { unavailable: 'upload check missing' }
  out['hookwrap / uploads / deadLetters'] = metric(u.deadLetters, 'deadLetters')
  out['hookwrap / hookSkips'] = metric(h.hookSkips, 'hookSkips')
  return { out }
}

export function phaseMetrics(phase, report) {
  if (phase === 'recorder') return recorderMetrics(report.recorder)
  if (phase === 'uploader') return uploaderMetrics(report.uploader)
  return hookwrapMetrics(report.hookwrap)
}

// A run that started a phase but produced no comparable measurement.
export function phaseFailure(phase, report) {
  const p = report[phase]
  if (!p) return 'phase not run'
  if (p.status === 'unavailable') return p.reason ?? `${phase} phase unavailable`
  if ((phase === 'recorder' || phase === 'hookwrap') && (!p.modes || !Object.keys(p.modes).length)) return `${phase} phase has no measured modes`
  return undefined
}

export function mismatches(group, fields, ignoreMissing = false) {
  const out = []
  for (const field of fields) {
    const pairs = group.map((r) => [r.file, get(r.report, field)]).filter(([, v]) => !ignoreMissing || (v !== undefined && v !== null))
    const values = pairs.map(([, v]) => JSON.stringify(v ?? null))
    if (new Set(values).size > 1) out.push(`${field}: ${pairs.map(([f], i) => `${f}=${values[i]}`).join(', ')}`)
  }
  return out
}

export const median = (v) => { const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
export const round = (v) => Math.round(v * 10) / 10

// Lower is better for everything except throughput.
export const higherIsBetter = (key, unit) => unit === 'rec/s'

// Two-sided Mann-Whitney U test (normal approximation with tie correction). Returns the p-value.
export function mannWhitneyP(a, b) {
  const n1 = a.length, n2 = b.length
  if (n1 < 2 || n2 < 2) return 1
  const all = [...a.map((v) => [v, 0]), ...b.map((v) => [v, 1])].sort((x, y) => x[0] - y[0])
  const ranks = new Array(all.length)
  let tieTerm = 0
  for (let i = 0; i < all.length;) {
    let j = i
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[k] = r
    const t = j - i + 1
    tieTerm += t * t * t - t
    i = j + 1
  }
  let r1 = 0
  for (let i = 0; i < all.length; i++) if (all[i][1] === 0) r1 += ranks[i]
  const u = r1 - (n1 * (n1 + 1)) / 2
  const n = n1 + n2
  const variance = (n1 * n2 / 12) * ((n + 1) - tieTerm / (n * (n - 1)))
  if (variance <= 0) return 1
  const z = Math.abs(u - (n1 * n2) / 2) / Math.sqrt(variance)
  return 2 * (1 - normalCdf(z))
}
function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26 erf approximation, enough for a p-value threshold.
  const x = z / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 0.5 * (1 + y)
}
