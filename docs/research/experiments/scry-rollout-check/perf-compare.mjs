#!/usr/bin/env node
// Turn two or more perf-bench runs from the same machine into one baseline.
//
//   node perf-compare.mjs baseline-A.json baseline-B.json [more...] [--threshold 20] [--out <dir>]
//
// Files may hold any of the phases recorder, uploader, hookwrap (`perf-bench --only <phase>`). Each phase is
// compared across the files that contain it, so two recorder-only runs and two uploader-only runs
// can be combined. Every file must come from the same machine; within a phase, the versions and
// workload inputs must match too. Any difference is refused with the field named, because a
// baseline that mixes environments says nothing.
//
// For every metric: the p50 of each run, spread = (max - min) / median of those p50s, and
// stable = spread <= threshold (default 20 %). Only stable metrics enter the baseline; unstable and
// unavailable ones are listed separately with their reasons. Unavailable is never turned into 0.
//
// A file whose phase failed as a whole (the phase reports status "unavailable", e.g. "uploader phase
// failed: ...") has no measurement for that phase. It is excluded from that phase and listed with its
// reason, instead of turning every metric of the phase into "unavailable". Each phase needs at least
// two complete files; otherwise the phase is reported as not compared, with the reason.
// The output is informational, not a ratchet gate.
//
// Exit: 0 written, 2 refused (environment mismatch, or no phase with two complete runs), 1 error.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { MACHINE, PHASES, VERSIONS, WORKLOAD, get, median, mismatches, phaseFailure, phaseMetrics, round } from './perf-metrics.mjs'

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
  const phases = PHASES.filter((p) => report[p] !== undefined)
  return { file: basename(file), report, phases }
})

// ---------- environment checks ----------
const PHASE_FIELDS = Object.fromEntries(PHASES.map((p) => [p, [...VERSIONS[p], ...WORKLOAD[p]]]))
const machine = mismatches(runs, MACHINE)
if (machine.length) refuse(`files come from different machines or setups:\n  ${machine.join('\n  ')}`)

// ---------- per phase comparison ----------
const result = { baseline: {}, unstable: {}, unavailable: {} }
const phaseSummary = {}

for (const phase of PHASES) {
  const present = runs.filter((r) => r.phases.includes(phase))
  if (present.length === 0) continue
  const excluded = present.map((r) => ({ file: r.file, reason: phaseFailure(phase, r.report) })).filter((e) => e.reason)
  const group = present.filter((r) => !excluded.some((e) => e.file === r.file))
  if (group.length < 2) {
    phaseSummary[phase] = { compared: false, files: group.map((r) => r.file), excluded,
      reason: `${group.length} complete file(s) for this phase, need 2${excluded.length ? `; excluded: ${excluded.map((e) => `${e.file} (${e.reason})`).join('; ')}` : ''}` }
    continue
  }
  const diff = mismatches(group, PHASE_FIELDS[phase], true)
  if (diff.length) refuse(`${phase} runs differ in versions or workload:\n  ${diff.join('\n  ')}`)
  const extracted = group.map((r) => phaseMetrics(phase, r.report))
  const keys = [...new Set(extracted.flatMap((e) => Object.keys(e.out)))]
  for (const key of keys) {
    const perRun = extracted.map((e, i) => e.out[key] ?? { unavailable: e.phaseReason ? `phase failed: ${e.phaseReason}` : 'metric missing in this run' })
    const missing = perRun.map((m, i) => (m.unavailable !== undefined ? `${group[i].file}: ${m.unavailable}` : null)).filter(Boolean)
    if (missing.length) { result.unavailable[key] = missing; continue }
    const values = perRun.map((m) => m.value)
    if (perRun[0].kind === 'evidence') {
      const same = new Set(values).size === 1
      const entry = { unit: perRun[0].unit, p50ByRun: values.map((v) => String(v).slice(0, 12)), baseline: same ? values[0] : 'differs between runs', spreadPct: same ? 0 : 'differs' }
      if (same) result.baseline[key] = entry
      else result.unstable[key] = entry
      continue
    }
    const mid = median(values)
    const spread = mid === 0 ? (Math.max(...values) === Math.min(...values) ? 0 : Infinity) : ((Math.max(...values) - Math.min(...values)) / Math.abs(mid)) * 100
    const entry = { unit: perRun[0].unit, p50ByRun: values.map(round), p95ByRun: perRun.some((m) => m.p95 !== undefined) ? perRun.map((m) => (m.p95 === undefined ? null : round(m.p95))) : undefined,
      samplesPerRun: perRun.some((m) => m.n !== undefined) ? perRun.map((m) => m.n ?? null) : undefined,
      baseline: round(mid), spreadPct: Number.isFinite(spread) ? round(spread) : 'infinite' }
    if (Number.isFinite(spread) && spread <= threshold) result.baseline[key] = entry
    else result.unstable[key] = entry
  }
  phaseSummary[phase] = { compared: true, files: group.map((r) => r.file), excluded, versions: Object.fromEntries(VERSIONS[phase].map((f) => [f.replace('versions.', ''), get(group[0].report, f)])) }
}
if (!Object.values(phaseSummary).some((p) => p.compared))
  refuse(`no phase has two or more complete files:\n  ${Object.entries(phaseSummary).map(([p, s]) => `${p}: ${s.reason}`).join('\n  ')}`)

// ---------- output ----------
const first = runs[0].report
const generatedAt = new Date().toISOString()
const doc = {
  generatedAt, kind: 'scry perf baseline (informational, not a ratchet gate)', thresholdPct: threshold,
  spreadDefinition: '(max - min) / median of per-run p50, in percent',
  machine: Object.fromEntries(MACHINE.map((f) => [f.replace('environment.', ''), get(first, f)])),
  repository: runs.find((r) => r.report.repository)?.report.repository && (({ name, tracked, untracked, commits, gitDirMiB, submodules, nestedRepos }) => ({ name, tracked, untracked, commits, gitDirMiB, submodules, nestedRepos }))(runs.find((r) => r.report.repository).report.repository),
  phases: phaseSummary,
  inputs: runs.map((r) => ({ file: r.file, at: r.report.environment.at, phases: r.phases, rounds: r.report.rounds,
    loadAverage: { start: r.report.environment.loadAverage, end: r.report.environment.loadAverageAtEnd } })),
  counts: { baseline: Object.keys(result.baseline).length, unstable: Object.keys(result.unstable).length, unavailable: Object.keys(result.unavailable).length,
    excludedPhaseInputs: Object.values(phaseSummary).reduce((n, p) => n + (p.excluded?.length ?? 0), 0) },
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
const excludedRows = Object.entries(phaseSummary).flatMap(([p, s]) => (s.excluded ?? []).map((e) => `| ${p} | ${e.file} | ${String(e.reason).replaceAll('|', '\\|')} |`))
if (excludedRows.length) lines.push(`## 排除的输入（${excludedRows.length} 项）`, '', '这些文件的该阶段整体失败，没有可比较的测量，只从该阶段排除；文件里其他阶段照常参与。', '',
  '| 阶段 | 文件 | 原因 |', '| --- | --- | --- |', ...excludedRows, '')
const skipped = Object.entries(phaseSummary).filter(([, p]) => !p.compared)
if (skipped.length) lines.push('## 未比较的阶段', '', ...skipped.map(([p, s]) => `- ${p}：${s.reason}`), '')
lines.push('测不到的项不等于 0。毫秒值只和同一台机器、相同版本和负载条件下的后续结果比较。', '')
const mdPath = jsonPath.replace(/\.json$/, '.md')
writeFileSync(mdPath, lines.join('\n'))
console.log(`baseline ${doc.counts.baseline}, unstable ${doc.counts.unstable}, unavailable ${doc.counts.unavailable}, excluded phase inputs ${doc.counts.excludedPhaseInputs}`)
for (const [p, s] of Object.entries(phaseSummary)) for (const e of s.excluded ?? []) console.log(`excluded from ${p}: ${e.file} (${e.reason})`)
for (const [p, s] of Object.entries(phaseSummary)) if (!s.compared) console.log(`${p} not compared: ${s.reason}`)
console.log(`written: ${jsonPath}\nwritten: ${mdPath}`)
