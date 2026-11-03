#!/usr/bin/env node
// Baseline vs candidate verdict for perf-bench runs: the "verify" step of a performance climb.
//
//   node perf-ab.mjs --base A1.json A2.json [...] --cand B1.json B2.json [...] \
//     [--phases recorder,hookwrap,uploader] [--min-gain 10] [--ms-floor 5] [--min-runs 2] \
//     [--allow allowed-regressions.json] [--calibration AA.json] [--alpha 0.01] [--out <dir>]
//
// All files must come from the same machine, and within each phase from the same workload
// (perf-metrics WORKLOAD). Versions may differ: that is the point of an A/B run. Run base and
// candidate interleaved (A B A B) in one session so machine drift hits both sides.
//
// Per metric (perf-metrics definitions):
//   count (git calls, transport requests, ...): exact. Each side must agree across its runs; any
//     increase is a regression, any decrease an improvement (L1).
//   time / resource / rate: compare the median of per-run p50s. A change counts only when (1) it is at
//     least --min-gain % of the base, --ms-floor ms (time only) and, with --calibration <A/A AB json>,
//     twice the change the same metric showed in that A/A session; (2) every candidate run is on the
//     same side of every base run; (3) when raw samples exist, a Mann-Whitney U test on the pooled
//     samples gives p < --alpha (default 0.01); without samples the larger side's spread of per-run
//     values is required as extra margin instead. Otherwise it is "no clear change" (L2).
//   Unavailable on either side is listed, never treated as 0 or as a pass.
//
// --allow names regressions accepted on purpose: {"<metric key or prefix>": "reason"}. Every allowed
// regression is still listed with its reason.
//
// Exit: 0 no unallowed regression, 1 unallowed regression (or unstable counts), 2 refused, 3 error.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { MACHINE, PHASES, VERSIONS, WORKLOAD, get, higherIsBetter, mannWhitneyP, median, mismatches, phaseFailure, phaseMetrics, round } from './perf-metrics.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
function listAfter(flag) {
  const i = argv.indexOf(flag)
  if (i < 0) return []
  const out = []
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j])
  return out
}
function refuse(message) { console.error(`perf-ab: refused: ${message}`); process.exit(2) }

try {
  const minGain = Number(opt('min-gain', 10))
  const msFloor = Number(opt('ms-floor', 5))
  const minRuns = Number(opt('min-runs', 2))
  const outDir = resolve(opt('out', process.cwd()))
  const wanted = (opt('phases') ?? PHASES.join(',')).split(',').map((p) => p.trim()).filter(Boolean)
  for (const p of wanted) if (!PHASES.includes(p)) refuse(`unknown phase ${p}`)
  const allow = opt('allow') ? JSON.parse(readFileSync(opt('allow'), 'utf8')) : {}
  const alpha = Number(opt('alpha', 0.01))
  // --calibration <AB json of an A/A session>: per metric |change| seen with identical builds.
  const calibration = {}
  if (opt('calibration')) for (const r of JSON.parse(readFileSync(opt('calibration'), 'utf8')).rows ?? []) if (typeof r.delta === 'number' && r.kind !== 'count') calibration[r.key] = Math.abs(r.delta)
  const load = (side) => listAfter(`--${side}`).map((file) => {
    const report = JSON.parse(readFileSync(file, 'utf8'))
    if (!report.environment) throw new Error(`${file} is not a perf-bench result (no environment)`)
    return { side, file: basename(file), report }
  })
  const base = load('base'), cand = load('cand')
  if (!base.length || !cand.length) refuse('need --base <files...> and --cand <files...>')
  const all = [...base, ...cand]
  const machine = mismatches(all, MACHINE)
  if (machine.length) refuse(`files come from different machines or setups:\n  ${machine.join('\n  ')}`)

  const phases = {}
  const rows = []
  for (const phase of wanted) {
    const sides = {}
    for (const [side, group] of [['base', base], ['cand', cand]]) {
      const present = group.filter((r) => r.report[phase] !== undefined)
      const excluded = present.map((r) => ({ file: r.file, reason: phaseFailure(phase, r.report) })).filter((e) => e.reason)
      sides[side] = { runs: present.filter((r) => !excluded.some((e) => e.file === r.file)), excluded }
    }
    if (sides.base.runs.length < minRuns || sides.cand.runs.length < minRuns) {
      phases[phase] = { compared: false, reason: `complete runs: base ${sides.base.runs.length}, candidate ${sides.cand.runs.length}; need ${minRuns} each`,
        excluded: [...sides.base.excluded, ...sides.cand.excluded] }
      continue
    }
    const workload = mismatches([...sides.base.runs, ...sides.cand.runs], WORKLOAD[phase], true)
    if (workload.length) refuse(`${phase}: base and candidate ran different workloads:\n  ${workload.join('\n  ')}`)
    const versions = Object.fromEntries(['base', 'cand'].map((side) => [side, Object.fromEntries(VERSIONS[phase].map((f) => [f.replace('versions.', ''),
      [...new Set(sides[side].runs.map((r) => JSON.stringify(get(r.report, f) ?? null)))].map((v) => JSON.parse(v))]))]))
    phases[phase] = { compared: true, base: sides.base.runs.map((r) => r.file), cand: sides.cand.runs.map((r) => r.file),
      excluded: [...sides.base.excluded, ...sides.cand.excluded], versions }

    const extracted = { base: sides.base.runs.map((r) => phaseMetrics(phase, r.report).out), cand: sides.cand.runs.map((r) => phaseMetrics(phase, r.report).out) }
    const keys = [...new Set([...extracted.base, ...extracted.cand].flatMap((o) => Object.keys(o)))]
    for (const key of keys) {
      const per = (side) => extracted[side].map((o) => o[key] ?? { unavailable: 'metric missing in this run' })
      const b = per('base'), c = per('cand')
      const missing = [...b.map((m, i) => [sides.base.runs[i].file, m]), ...c.map((m, i) => [sides.cand.runs[i].file, m])]
        .filter(([, m]) => m.unavailable !== undefined).map(([f, m]) => `${f}: ${m.unavailable}`)
      if (missing.length) { rows.push({ phase, key, verdict: 'unavailable', reason: missing.join('; ') }); continue }
      const unit = b[0].unit, kind = b[0].kind
      const bv = b.map((m) => m.value), cv = c.map((m) => m.value)
      const bMid = median(bv), cMid = median(cv)
      const row = { phase, key, unit, kind, base: round(bMid), cand: round(cMid), baseRuns: bv.map(round), candRuns: cv.map(round) }
      if (kind === 'derived') { rows.push({ ...row, delta: round(cMid - bMid), verdict: 'info', reason: 'derived from other metrics, not judged on its own' }); continue }
      if (kind === 'evidence') {
        const bSame = new Set(bv).size === 1, cSame = new Set(cv).size === 1
        const short = (v) => String(v).slice(0, 12)
        const r = { ...row, base: short(bv[0]), cand: short(cv[0]), baseRuns: bv.map(short), candRuns: cv.map(short) }
        if (!bSame || !cSame) rows.push({ ...r, verdict: 'unstable count', reason: 'the evidence digest differed between runs of the same side (non-deterministic record content)' })
        else rows.push({ ...r, verdict: bv[0] === cv[0] ? 'same' : 'worse', reason: bv[0] === cv[0] ? undefined : 'the candidate records different evidence for the same scripted turn' })
        continue
      }
      if (kind === 'count') {
        const stable = new Set(bv).size === 1 && new Set(cv).size === 1
        if (!stable) { rows.push({ ...row, verdict: 'unstable count', reason: 'an exact count differed between runs of the same side' }); continue }
        row.delta = round(cMid - bMid)
        row.verdict = cMid < bMid ? 'better' : cMid > bMid ? 'worse' : 'same'
        rows.push(row)
        continue
      }
      const up = higherIsBetter(key, unit)
      const gain = up ? cMid - bMid : bMid - cMid
      // Margin: minimum relative change, millisecond floor, and (with --calibration) twice the change
      // the same metric showed in an A/A session on this machine.
      const aa = calibration[key]
      const bs = b.every((m) => Array.isArray(m.samples)) ? b.flatMap((m) => m.samples) : undefined
      const cs = c.every((m) => Array.isArray(m.samples)) ? c.flatMap((m) => m.samples) : undefined
      // Without raw samples there is no test, so the spread between runs (the larger side's max - min
      // of per-run values) is required as an extra margin.
      const noise = bs && cs ? 0 : Math.max(Math.max(...bv) - Math.min(...bv), Math.max(...cv) - Math.min(...cv))
      const needed = Math.max((minGain / 100) * Math.abs(bMid), kind === 'time' ? msFloor : 0, aa !== undefined ? 2 * aa : 0, noise)
      // Consistency: every candidate run must sit on the same side of every base run.
      const consistent = gain > 0 ? (up ? Math.min(...cv) > Math.max(...bv) : Math.max(...cv) < Math.min(...bv))
        : gain < 0 ? (up ? Math.max(...cv) < Math.min(...bv) : Math.min(...cv) > Math.max(...bv)) : false
      // Significance on the pooled raw samples when the runs carry them (times).
      const p = bs && cs ? mannWhitneyP(bs, cs) : undefined
      const significant = p === undefined ? true : p < alpha
      row.delta = round(cMid - bMid)
      row.changePct = bMid === 0 ? null : round(((cMid - bMid) / Math.abs(bMid)) * 100)
      row.neededToCount = round(needed)
      row.pValue = p === undefined ? null : Number(p.toPrecision(3))
      row.consistentRuns = consistent
      const big = Math.abs(gain) >= needed && gain !== 0
      row.verdict = big && consistent && significant ? (gain > 0 ? 'better' : 'worse') : 'no clear change'
      if (row.verdict === 'no clear change' && big) row.reason = [!consistent && 'runs overlap', !significant && `p=${row.pValue} >= ${alpha}`].filter(Boolean).join('; ')
      rows.push(row)
    }
  }
  if (!Object.values(phases).some((p) => p.compared))
    refuse(`no phase with enough complete runs:\n  ${Object.entries(phases).map(([p, s]) => `${p}: ${s.reason}`).join('\n  ')}`)

  const allowedReason = (key) => Object.entries(allow).find(([k]) => key === k || key.startsWith(k))?.[1]
  for (const r of rows) if (r.verdict === 'worse') { const why = allowedReason(r.key); if (why) { r.allowed = why } }
  const by = (v) => rows.filter((r) => r.verdict === v)
  const unallowed = by('worse').filter((r) => !r.allowed)
  const summary = {
    better: by('better').length, betterCounts: by('better').filter((r) => r.kind === 'count').length, betterTimes: by('better').filter((r) => r.kind === 'time').length,
    worse: by('worse').length, worseUnallowed: unallowed.length, unstableCounts: by('unstable count').length,
    noClearChange: by('no clear change').length, same: by('same').length, unavailable: by('unavailable').length, info: by('info').length
  }
  const pass = unallowed.length === 0 && summary.unstableCounts === 0
  const verdict = !pass ? 'REGRESSION' : summary.better ? 'IMPROVED' : 'NO CLEAR CHANGE'
  const generatedAt = new Date().toISOString()
  const doc = { generatedAt, kind: 'scry perf A/B (informational unless your climb rules make it a gate)', verdict, rules: { minGainPct: minGain, msFloor, minRuns, alpha,
    calibration: opt('calibration') ? 'A/A deltas x2' : 'none', consistency: 'every candidate run beyond every base run', counts: 'exact; any increase is worse' },
  machine: Object.fromEntries(MACHINE.map((f) => [f.replace('environment.', ''), get(base[0].report, f)])), phases, summary, allow, rows }

  mkdirSync(outDir, { recursive: true })
  const stamp = generatedAt.replace(/[:.]/g, '-')
  const jsonPath = join(outDir, `AB-${stamp}.json`)
  writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + '\n')
  const label = { better: '变好', worse: '变差', 'no clear change': '无明确变化', same: '相同', unavailable: '测不到', 'unstable count': '计数不稳定' }
  const lines = [`# 性能 A/B：${verdict}`, '',
    `基线 ${base.length} 份、候选 ${cand.length} 份。计数（L1）任何增加即变差。耗时/资源（L2）要同时满足才算变化：幅度至少为基线的 ${minGain}%、${msFloor} ms（仅耗时）${opt('calibration') ? '和 A/A 校准变化的 2 倍' : ''}；候选每次运行都落在基线每次运行的同一侧；有原始样本时 Mann-Whitney 检验 p < ${alpha}。测不到的不算通过。`, '',
    `汇总：变好 ${summary.better}（计数 ${summary.betterCounts}，耗时 ${summary.betterTimes}）；变差 ${summary.worse}（未豁免 ${summary.worseUnallowed}）；计数不稳定 ${summary.unstableCounts}；无明确变化 ${summary.noClearChange}；相同 ${summary.same}；测不到 ${summary.unavailable}`, '',
    '## 阶段', '', '```json', JSON.stringify(phases, null, 2), '```', '']
  const section = (title, list) => {
    lines.push(`## ${title}（${list.length}）`, '')
    if (!list.length) { lines.push('无', ''); return }
    lines.push('| 指标 | 类别 | 基线 | 候选 | 变化 | 需要超过 | p | 各次（基线 / 候选） | 备注 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const r of list) lines.push(`| ${r.key} | ${r.kind ?? ''} | ${r.base ?? ''} ${r.unit ?? ''} | ${r.cand ?? ''} | ${r.delta ?? ''}${r.changePct != null ? ` (${r.changePct}%)` : ''} | ${r.neededToCount ?? (r.kind === 'count' ? '任何变化' : '')} | ${r.pValue ?? '–'} | ${(r.baseRuns ?? []).join(', ')} / ${(r.candRuns ?? []).join(', ')} | ${(r.allowed ? `已豁免：${r.allowed}` : r.reason ?? '').replaceAll('|', '\\|')} |`)
    lines.push('')
  }
  section('变差', by('worse'))
  section('计数不稳定', by('unstable count'))
  section('变好', by('better'))
  section('测不到', by('unavailable'))
  section('无明确变化', by('no clear change'))
  section('仅供参考（派生指标，不参与判定）', by('info'))
  lines.push(`相同的计数 ${summary.same} 项未列出。只能宣称已达到的级别：计数变好是 L1，受控耗时变好是 L2；日常使用（L3）需要发布后另行对比。`, '')
  const mdPath = jsonPath.replace(/\.json$/, '.md')
  writeFileSync(mdPath, lines.join('\n'))
  console.log(`verdict ${verdict}: better ${summary.better} (counts ${summary.betterCounts}, times ${summary.betterTimes}), worse ${summary.worse} (unallowed ${summary.worseUnallowed}), unstable counts ${summary.unstableCounts}, no clear change ${summary.noClearChange}, unavailable ${summary.unavailable}`)
  for (const r of unallowed) console.log(`worse: ${r.key} ${r.base} -> ${r.cand} ${r.unit}`)
  console.log(`written: ${jsonPath}\nwritten: ${mdPath}`)
  process.exit(pass ? 0 : 1)
} catch (error) {
  console.error(`perf-ab: ${error.message}`)
  process.exit(3)
}
