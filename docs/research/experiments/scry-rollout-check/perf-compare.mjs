#!/usr/bin/env node
// Turn two or more perf-bench runs from the same machine into one baseline.
//
//   node perf-compare.mjs baseline-A.json baseline-B.json [more...] [--threshold 20] [--out <dir>]
//
// Files may hold both phases or only one (`perf-bench --only recorder|uploader`). Each phase is
// compared across the files that contain it, so two recorder-only runs and two uploader-only runs
// can be combined. Every file must come from the same machine; within a phase, the versions and
// workload inputs must match too. Any difference is refused with the field named, because a
// baseline that mixes environments says nothing.
//
// For every metric: the p50 of each run, spread = (max - min) / median of those p50s, and
// stable = spread <= threshold (default 20 %). Only stable metrics enter the baseline; unstable and
// unavailable ones are listed separately with their reasons. Unavailable is never turned into 0.
// The output is informational, not a ratchet gate.
//
// Exit: 0 written, 2 refused (environment mismatch or fewer than two runs for every phase), 1 error.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
const threshold = Number(opt('threshold', 20))
const outDir = resolve(opt('out', process.cwd()))

function refuse(message) { console.error(`perf-compare: refused: ${message}`); process.exit(2) }
if (files.length < 2) refuse('need at least two baseline-*.json files')
if (!Number.isFinite(threshold) || threshold <= 0) refuse('--threshold must be a positive number (percent)')

const runs = files.map((file) => {
  const report = JSON.parse(readFileSync(file, 'utf8'))
  if (!report.environment) throw new Error(`${file} is not a perf-bench baseline (no environment)`)
  const phases = ['recorder', 'uploader'].filter((p) => report[p] !== undefined)
  return { file: basename(file), report, phases }
})

// ---------- environment checks ----------
const get = (obj, path) => path.split('.').reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), obj)
const MACHINE = ['environment.platform', 'environment.release', 'environment.arch', 'environment.cpu', 'environment.cpuCount',
  'environment.memoryGiB', 'environment.macos', 'environment.node']
const PHASE_FIELDS = {
  recorder: ['environment.git', 'versions.scry', 'rounds', 'recorder.provider', 'repository.name', 'repository.tracked',
    'repository.commits', 'repository.gitDirMiB', 'repository.submodules'],
  // The uploader payload is built from the copy's recorder records, so it is part of the workload.
  uploader: ['versions.uploader', 'rounds', 'uploader.payload', 'uploader.transport', 'uploader.contentBlobs']
}
// ignoreMissing: a run whose phase failed has no workload description; it cannot contradict
// the others, and its metrics are reported as unavailable anyway.
function mismatches(group, fields, ignoreMissing = false) {
  const out = []
  for (const field of fields) {
    const pairs = group.map((r) => [r.file, get(r.report, field)]).filter(([, v]) => !ignoreMissing || (v !== undefined && v !== null))
    const values = pairs.map(([, v]) => JSON.stringify(v ?? null))
    if (new Set(values).size > 1) out.push(`${field}: ${pairs.map(([f], i) => `${f}=${values[i]}`).join(', ')}`)
  }
  return out
}
const machine = mismatches(runs, MACHINE)
if (machine.length) refuse(`files come from different machines or setups:\n  ${machine.join('\n  ')}`)

// ---------- metric extraction ----------
const UNIT_BY_NAME = [[/Ms$/, 'ms'], [/MiB$/, 'MiB'], [/KiB/, 'KiB'], [/PerSecond$/, 'rec/s'], [/cpuSeconds/, 's'], [/Pcpu$/, '%cpu']]
const unitOf = (name) => UNIT_BY_NAME.find(([re]) => re.test(name))?.[1] ?? 'count'

// One metric value: { value, unit, p95? } or { unavailable: reason }.
function metric(raw, name) {
  if (raw === undefined || raw === null) return { unavailable: 'not reported' }
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, unit: unitOf(name) } : { unavailable: 'not a finite number' }
  if (typeof raw === 'object' && raw.status === 'measured' && typeof raw.p50 === 'number') return { value: raw.p50, p95: raw.p95, n: raw.n, unit: raw.unit ?? unitOf(name) }
  if (typeof raw === 'object' && raw.status === 'unavailable') return { unavailable: raw.reason ?? 'unavailable' }
  return { unavailable: `unrecognised value ${JSON.stringify(raw).slice(0, 80)}` }
}

function recorderMetrics(rec) {
  const out = {}
  if (!rec || rec.status === 'unavailable' || !rec.modes) return { out, phaseReason: rec?.reason ?? 'recorder phase not measured' }
  for (const [mode, scenarios] of Object.entries(rec.modes)) {
    for (const [scenario, m] of Object.entries(scenarios)) {
      for (const field of ['turnStart', 'toolEvent', 'stop', 'hookTotalPerTurn', 'stopToRecordVisible'])
        out[`recorder / ${mode} / ${scenario} / ${field}`] = metric(m[field], field)
    }
  }
  const d = rec.daemon ?? {}
  const daemonMissing = d.status === 'unavailable' ? { unavailable: d.reason } : undefined
  for (const k of ['afterWarmup', 'afterRun', 'after30sIdle']) out[`recorder / daemon / rssMiB.${k}`] = daemonMissing ?? metric(d.rssMiB?.[k], 'rssMiB')
  for (const k of ['cpuSecondsDuringRun', 'cpuSecondsIn30sIdle']) out[`recorder / daemon / ${k}`] = daemonMissing ?? metric(d[k], k)
  out['recorder / disk / kibPerRecord'] = metric(rec.disk?.kibPerRecord, 'diskKiB')
  out['recorder / hookSkips'] = metric(rec.hookSkips, 'hookSkips')
  return { out }
}

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
    for (const f of UPLOADER_FIELDS) out[`${p} / ${f}`] = metric(get(r, f), f.split('.').pop())
  }
  return { out, phaseReason: up.status === 'unavailable' ? up.reason : undefined }
}
const UPLOADER_FIELDS = ['notify', 'commitPhaseMs', 'drainAfterLastCommitMs', 'recordsPerSecond', 'transportRequests', 'recordsPerRequest',
  'requestKiB', 'capabilityCalls', 'deadLetters', 'worker.peakConcurrent', 'worker.peakRssMiB', 'uploadDirKiBPerRecord']

// ---------- per phase comparison ----------
const median = (v) => { const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const round = (v) => Math.round(v * 10) / 10
const result = { baseline: {}, unstable: {}, unavailable: {} }
const phaseSummary = {}

for (const phase of ['recorder', 'uploader']) {
  const group = runs.filter((r) => r.phases.includes(phase))
  if (group.length === 0) continue
  if (group.length < 2) { phaseSummary[phase] = { compared: false, reason: `only ${group[0].file} contains this phase`, files: group.map((r) => r.file) }; continue }
  const diff = mismatches(group, PHASE_FIELDS[phase], true)
  if (diff.length) refuse(`${phase} runs differ in versions or workload:\n  ${diff.join('\n  ')}`)
  const extracted = group.map((r) => (phase === 'recorder' ? recorderMetrics(r.report.recorder) : uploaderMetrics(r.report.uploader)))
  const keys = [...new Set(extracted.flatMap((e) => Object.keys(e.out)))]
  for (const key of keys) {
    const perRun = extracted.map((e, i) => e.out[key] ?? { unavailable: e.phaseReason ? `phase failed: ${e.phaseReason}` : 'metric missing in this run' })
    const missing = perRun.map((m, i) => (m.unavailable !== undefined ? `${group[i].file}: ${m.unavailable}` : null)).filter(Boolean)
    if (missing.length) { result.unavailable[key] = missing; continue }
    const values = perRun.map((m) => m.value)
    const mid = median(values)
    const spread = mid === 0 ? (Math.max(...values) === Math.min(...values) ? 0 : Infinity) : ((Math.max(...values) - Math.min(...values)) / Math.abs(mid)) * 100
    const entry = { unit: perRun[0].unit, p50ByRun: values.map(round), p95ByRun: perRun.some((m) => m.p95 !== undefined) ? perRun.map((m) => (m.p95 === undefined ? null : round(m.p95))) : undefined,
      samplesPerRun: perRun.some((m) => m.n !== undefined) ? perRun.map((m) => m.n ?? null) : undefined,
      baseline: round(mid), spreadPct: Number.isFinite(spread) ? round(spread) : 'infinite' }
    if (Number.isFinite(spread) && spread <= threshold) result.baseline[key] = entry
    else result.unstable[key] = entry
  }
  phaseSummary[phase] = { compared: true, files: group.map((r) => r.file), versions: phase === 'recorder' ? group[0].report.versions?.scry : group[0].report.versions?.uploader }
}
if (!Object.values(phaseSummary).some((p) => p.compared)) refuse('no phase is present in two or more files')

// ---------- output ----------
const first = runs[0].report
const generatedAt = new Date().toISOString()
const doc = {
  generatedAt, kind: 'scry perf baseline (informational, not a ratchet gate)', thresholdPct: threshold,
  spreadDefinition: '(max - min) / median of per-run p50, in percent',
  machine: Object.fromEntries(MACHINE.map((f) => [f.replace('environment.', ''), get(first, f)])),
  repository: runs.find((r) => r.report.repository)?.report.repository && (({ name, tracked, untracked, commits, gitDirMiB, submodules }) => ({ name, tracked, untracked, commits, gitDirMiB, submodules }))(runs.find((r) => r.report.repository).report.repository),
  phases: phaseSummary,
  inputs: runs.map((r) => ({ file: r.file, at: r.report.environment.at, phases: r.phases, rounds: r.report.rounds,
    loadAverage: { start: r.report.environment.loadAverage, end: r.report.environment.loadAverageAtEnd } })),
  counts: { baseline: Object.keys(result.baseline).length, unstable: Object.keys(result.unstable).length, unavailable: Object.keys(result.unavailable).length },
  ...result
}
mkdirSync(outDir, { recursive: true })
const stamp = generatedAt.slice(0, 10)
const jsonPath = join(outDir, `BASELINE-${stamp}.json`)
writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + '\n')

const lines = [`# Scry 性能基线 ${stamp}`, '',
  `由 ${runs.length} 次 perf-bench 运行合成。只收录各次 p50 波动 ≤ ${threshold}% 的指标；波动 = (最大 − 最小) / 各次 p50 的中位数。这是同一台机器上的参考值，不是门禁。`, '',
  '## 环境', '', '```json', JSON.stringify({ machine: doc.machine, repository: doc.repository, phases: phaseSummary }, null, 2), '```', '',
  '| 输入 | 时间 | 阶段 | 轮数 | 负载（开始 → 结束） |', '| --- | --- | --- | --- | --- |',
  ...doc.inputs.map((i) => `| ${i.file} | ${i.at} | ${i.phases.join(', ')} | ${i.rounds ?? ''} | ${JSON.stringify(i.loadAverage.start)} → ${JSON.stringify(i.loadAverage.end)} |`), '']
const table = (title, entries) => {
  lines.push(`## ${title}（${Object.keys(entries).length} 项）`, '')
  if (!Object.keys(entries).length) { lines.push('无', ''); return }
  lines.push('| 指标 | 基线 | 单位 | 各次 p50 | 各次 p95 | 波动 % |', '| --- | --- | --- | --- | --- | --- |')
  for (const [k, e] of Object.entries(entries)) lines.push(`| ${k} | ${e.baseline} | ${e.unit} | ${e.p50ByRun.join(' / ')} | ${e.p95ByRun ? e.p95ByRun.map((v) => v ?? '–').join(' / ') : '–'} | ${e.spreadPct} |`)
  lines.push('')
}
table('基线（稳定）', result.baseline)
table('不稳定，不能作基线', result.unstable)
lines.push(`## 测不到（${Object.keys(result.unavailable).length} 项）`, '')
if (!Object.keys(result.unavailable).length) lines.push('无', '')
else { lines.push('| 指标 | 原因 |', '| --- | --- |'); for (const [k, r] of Object.entries(result.unavailable)) lines.push(`| ${k} | ${r.join('；').replaceAll('|', '\\|')} |`); lines.push('') }
const skipped = Object.entries(phaseSummary).filter(([, p]) => !p.compared)
if (skipped.length) lines.push('## 未比较的阶段', '', ...skipped.map(([p, s]) => `- ${p}：${s.reason}`), '')
lines.push('测不到的项不等于 0。毫秒值只和同一台机器、相同版本和负载条件下的后续结果比较。', '')
const mdPath = jsonPath.replace(/\.json$/, '.md')
writeFileSync(mdPath, lines.join('\n'))
console.log(`baseline ${doc.counts.baseline}, unstable ${doc.counts.unstable}, unavailable ${doc.counts.unavailable}`)
console.log(`written: ${jsonPath}\nwritten: ${mdPath}`)
