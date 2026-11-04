#!/usr/bin/env node
// Performance baseline for the Scry recorder (hook path) and the uploader.
//
// It never touches the source repository: it works on a copy (APFS clone when
// available), strips any uploader commit hook from the copy's config, points the
// copy's origin at an invalid host, and drives synthetic hook events through the
// copy's own `.scry/provider-hook.sh` — the same entry a Provider calls. The
// uploader part runs in temporary HOME/XDG directories against the fake transport
// in this folder, so nothing is uploaded.
//
//   node perf-bench.mjs --source <repo> --work <copy dir> --scry <scry cli> \
//     --uploader <uploader dist/cli.js> [--rounds 7] [--out <dir>] [--only recorder|uploader|hookwrap]
//     [--skip-hookwrap] [--uploader-scry <scry cli for the uploader instead of its bundled one>]
//     [--workload-name <alias written instead of the source repo name>] [--provider qoder]
//     [--phases recorder,hookwrap] [--label <build under test>] [--protocol <protocol.json outside the repo>]
//   node perf-bench.mjs e2e --work <copy dir> --cmd '<provider command with {prompt}>' --runs 5
//
// Milliseconds are wall time on this machine under its current load; the report
// records load average per phase. Run nothing else heavy at the same time and do
// not run two copies of this script at once (it takes a lock).

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUNDS, argv, now, opt, outDir, sub } from './bench-args.mjs'
import { MARKER, prepareCopy } from './bench-copy.mjs'
import { HOOKWRAP_FIELDS, hookwrapPhase } from './bench-hookwrap.mjs'
import { recorderPhase } from './bench-recorder.mjs'
import { uploaderPhase } from './bench-uploader.mjs'
import { environment, hook, load, stats, tryRun, unavailable } from './bench-util.mjs'
import { commit } from './bench-uploader.mjs'
import { node, repoStats, run } from './bench-util.mjs'

// ---------- optional end-to-end with a real Provider ----------
async function e2e() {
  const work = resolve(opt('work'))
  if (!existsSync(join(work, MARKER))) throw new Error('--work must be a perf-bench copy')
  const template = opt('cmd')
  const runs = Number(opt('runs', 5))
  if (!template || !template.includes('{prompt}')) throw new Error('--cmd must contain {prompt}')
  const results = { on: [], off: [] }
  // Alternate on/off so drift in model latency hits both sides equally.
  for (let i = 0; i < runs; i++) {
    for (const mode of i % 2 ? ['off', 'on'] : ['on', 'off']) {
      const prompt = `[perf-e2e-${mode}-${i}] 只回答“好”，不要调用任何工具。`
      const cmd = template.replaceAll('{prompt}', prompt.replaceAll("'", "'\\''"))
      const t = now()
      const r = spawnSync('/bin/sh', ['-c', cmd], { cwd: work, env: { ...process.env, ...(mode === 'off' ? { SCRY_RECORDER_ENABLED: '0' } : {}) }, stdio: 'ignore' })
      results[mode].push({ ms: now() - t, exit: r.status })
    }
  }
  const out = {
    at: new Date().toISOString(), cmd: template, runs, note: 'model latency dominates; record the difference, do not gate on it',
    recorderOn: stats(results.on.filter((r) => r.exit === 0).map((r) => r.ms)), recorderOff: stats(results.off.filter((r) => r.exit === 0).map((r) => r.ms)),
    failures: [...results.on, ...results.off].filter((r) => r.exit !== 0).length
  }
  const path = join(outDir, `e2e-${out.at.replace(/[:.]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
  console.log(JSON.stringify(out, null, 2))
  console.log(`written: ${path}`)
}

// ---------- report ----------
function markdown(report) {
  const lines = [`# Scry 性能基线 ${report.environment.at.slice(0, 10)}`, '', '## 环境', '', '```json', JSON.stringify({ environment: report.environment, versions: report.versions, repository: report.repository }, null, 2), '```', '']
  const gitCell = (g) => g?.status === 'measured' ? `${g.turnStart} / ${g.toolEvents} / ${g.stop}` : `unavailable${g?.reason ? `（${g.reason}）` : ''}`
  const cell = (m) => m?.status === 'measured' ? `${m.p50} / ${m.p95}` : `unavailable${m?.reason ? `（${m.reason}）` : ''}`
  if (report.recorder?.status === 'unavailable') lines.push('## Recorder hook 路径', '', `unavailable：${report.recorder.reason}`, '')
  if (report.recorder?.modes) {
    lines.push('## Recorder hook 路径（毫秒，p50 / p95）', '', `Provider 形状：${report.recorder.provider}；${report.recorder.note}；每格 ${ROUNDS} 轮。`, '')
    for (const [mode, scenarios] of Object.entries(report.recorder.modes)) {
      lines.push(`### ${mode}`, '', '| 场景 | 轮次开始 | 单个工具事件 | 轮次结束 | 每轮 hook 合计 | 结束到记录落盘 | git 调用（开始 / 全部工具 / 结束） |', '| --- | --- | --- | --- | --- | --- | --- |')
      for (const [name, m] of Object.entries(scenarios)) lines.push(`| ${name} | ${cell(m.turnStart)} | ${cell(m.toolEvent)} | ${cell(m.stop)} | ${cell(m.hookTotalPerTurn)} | ${cell(m.stopToRecordVisible)} | ${gitCell(m.gitCalls)} |`)
      lines.push('')
    }
    lines.push('```json', JSON.stringify({ daemon: report.recorder.daemon, disk: report.recorder.disk, hookSkips: report.recorder.hookSkips, verify: report.recorder.verify }, null, 2), '```', '')
  }
  if (report.uploader?.status === 'unavailable') lines.push('## Uploader', '', `unavailable：${report.uploader.reason}（下表只含失败前完成的场景）`, '')
  if (report.uploader) {
    lines.push('## Uploader（假传输层，不联网）', '', `载荷：${report.uploader.payload}`, '', `hook 路径 notify（上传进行中）：${cell(report.uploader.notifyWhileUploading)} ms`, '',
      'streaming：记录逐条到达、边提交边上传；backlog：先积压（不拉起 worker），再一次唤醒排空。', '',
      '| 场景 | notify p50 / p95 | 提交阶段 | 最后一条提交后排空 | 条/秒 | 请求数（条/请求） | 能力查询次数 | 请求体 KiB p50 / p95 | worker 峰值数 | worker 峰值 RSS | upload 目录 KiB/条 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const [name, m] of Object.entries(report.uploader.runs ?? {})) {
      if (m.status !== 'measured') { lines.push(`| ${name} | unavailable（${m.reason}${m.progress ? `；${JSON.stringify(m.progress).replaceAll('|', '\\|')}` : ''}${m.diagnostics ? `；${JSON.stringify(m.diagnostics).replaceAll('|', '\\|')}` : ''}） | | | | | | | | | |`); continue }
      lines.push(`| ${name} | ${cell(m.notify)} | ${m.commitPhaseMs} ms | ${m.drainAfterLastCommitMs} ms | ${m.recordsPerSecond} | ${m.transportRequests}（${m.recordsPerRequest}） | ${m.capabilityCalls ?? 'unavailable'} | ${cell(m.requestKiB)} | ${m.worker.peakConcurrent} | ${m.worker.peakRssMiB ? `${m.worker.peakRssMiB} MiB` : 'unavailable（采样时没有 worker）'} | ${m.uploadDirKiBPerRecord} |`)
    }
    lines.push('')
  }
  if (report.hookwrap?.status === 'unavailable') lines.push('## Uploader hook 包装（每轮关键路径）', '', `unavailable：${report.hookwrap.reason}`, '')
  if (report.hookwrap?.modes && Object.keys(report.hookwrap.modes).length) {
    const h = report.hookwrap
    lines.push('## Uploader hook 包装（每轮关键路径，毫秒 p50 / p95）', '',
      `Provider 形状：${h.provider}；uploader 读记录用：${h.uploaderScry}；${h.note}；每格 ${ROUNDS} 轮。“增加”= 包装后 − 包装前（同一副本、同一次运行）。`, '',
      `wakeup 启动器单独计时：${cell(h.wakeup)}；上传核对：${h.uploads?.uploaded ?? 'unavailable'}/${h.uploads?.records ?? 'unavailable'} 条经假传输层上传，死信 ${h.uploads?.deadLetters ?? 'unavailable'}，hook-skip ${h.hookSkips ?? 'unavailable'}`, '')
    const label = { turnStart: '轮次开始', toolEvent: '单个工具事件', stop: '轮次结束', hookTotalPerTurn: '每轮 hook 合计', stopToRecordVisible: '结束到记录落盘' }
    for (const [mode, scenarios] of Object.entries(h.modes)) {
      lines.push(`### ${mode}`, '', '| 场景 | 指标 | 包装前 | 包装后 | 增加 |', '| --- | --- | --- | --- | --- |')
      for (const [name, m] of Object.entries(scenarios)) {
        for (const f of HOOKWRAP_FIELDS) lines.push(`| ${name} | ${label[f]} | ${cell(m.plain[f])} | ${cell(m.wrapped[f])} | ${cell(m.overhead[f])} |`)
        lines.push(`| ${name} | git 调用（开始 / 全部工具 / 结束） | ${gitCell(m.plain.gitCalls)} | ${gitCell(m.wrapped.gitCalls)} | ${gitCell(m.gitCallsAdded)} |`)
      }
      lines.push('')
    }
  }
  lines.push('## 说明', '', '- 毫秒值是本机在记录的负载下的墙钟时间，只和同一台机器上的后续结果比较。', '- 这是受控测量（L2），不是日常使用下的结论；不写入 `scripts/performance-ratchet.json`。', '- `unavailable` 表示没测到，原因写在旁边，不等于 0。', '')
  return lines.join('\n')
}

async function baseline() {
  const scry = opt('scry') && resolve(opt('scry'))
  const uploader = opt('uploader') && resolve(opt('uploader'))
  const only = opt('only')
  const listed = opt('phases') ? opt('phases').split(',').map((p) => p.trim()).filter(Boolean) : only ? [only] : undefined
  for (const p of listed ?? []) if (!['recorder', 'uploader', 'hookwrap'].includes(p)) throw new Error('--only/--phases take recorder, uploader, hookwrap')
  const phases = listed ?? ['recorder', 'uploader', ...(scry && uploader && !argv.includes('--skip-hookwrap') ? ['hookwrap'] : [])]
  // --label names the build under test (e.g. "base 1a2b3c" / "cand 4d5e6f"); perf-ab shows it.
  const report = { environment: environment(), versions: {}, rounds: ROUNDS, ...(opt('label') ? { label: opt('label') } : {}) }
  let work
  if (phases.includes('recorder') || phases.includes('hookwrap')) {
    if (!opt('work') || !scry) throw new Error('recorder and hookwrap phases need --work and --scry')
    const target = resolve(opt('work'))
    // hookwrap alone reuses an existing copy as is (it sets the copy's .scry aside and restores it);
    // the recorder phase always starts from a reset copy.
    if (!phases.includes('recorder') && existsSync(join(target, MARKER))) work = target
    else {
      if (!opt('source')) throw new Error('a new or reset copy needs --source')
      work = prepareCopy(opt('source'), target)
    }
    const copyInfo = JSON.parse(readFileSync(join(work, MARKER), 'utf8'))
    report.versions.scry = tryRun(process.execPath, [scry, 'version'])
    // --workload-name keeps a private repository name out of results that may be shared.
    report.repository = { name: opt('workload-name', basename(copyInfo.source)), copy: work, copyInfo, ...repoStats(work) }
  }
  if (phases.includes('recorder')) {
    console.log(`recorder phase on ${work} (${report.repository.tracked} tracked files)`)
    try { await recorderPhase(scry, work, report) } catch (error) {
      report.recorder = unavailable(`recorder phase failed: ${error.message}`)
      console.error(`recorder phase failed: ${error.message}`)
    }
  }
  if (phases.includes('uploader')) {
    if (!uploader) throw new Error('uploader phase needs --uploader')
    console.log('uploader phase (fake transport)')
    try { await uploaderPhase(uploader, report) } catch (error) {
      report.uploader = { ...(report.uploader ?? {}), status: 'unavailable', reason: `uploader phase failed: ${error.message}` }
      console.error(`uploader phase failed: ${error.message}`)
    }
    report.versions.uploader = report.uploader?.version ?? tryRun(process.execPath, [uploader, 'version'])
  }
  if (phases.includes('hookwrap')) {
    if (!uploader) throw new Error('hookwrap phase needs --uploader')
    console.log(`hookwrap phase on ${work} (uploader hook wrapper, fake transport)`)
    report.versions.uploader = report.versions.uploader ?? tryRun(process.execPath, [uploader, 'version'])
    try { await hookwrapPhase(scry, uploader, work, report) } catch (error) {
      report.hookwrap = { ...(report.hookwrap ?? {}), status: 'unavailable', reason: `hookwrap phase failed: ${error.message}` }
      console.error(`hookwrap phase failed: ${error.message}`)
    }
  }
  report.environment.loadAverageAtEnd = load()
  const stamp = report.environment.at.replace(/[:.]/g, '-')
  const jsonPath = join(outDir, `baseline-${stamp}.json`)
  // Results may be pushed to a shared branch: never write the user's home directory (it names the user).
  const home = process.env.HOME && process.env.HOME !== '/' ? process.env.HOME : undefined
  const redact = (text) => (home ? text.split(home).join('~') : text)
  if (report.repository) { report.repository.copyInfo = { ...report.repository.copyInfo, source: opt('workload-name') ? `<${opt('workload-name')}>` : report.repository.copyInfo.source } }
  writeFileSync(jsonPath, redact(JSON.stringify(report, null, 2)) + '\n')
  writeFileSync(join(outDir, `baseline-${stamp}.md`), redact(markdown(report)))
  console.log(`written: ${jsonPath}\nwritten: ${jsonPath.replace(/\.json$/, '.md')}`)
}

try {
  if (sub === 'e2e') await e2e()
  else await baseline()
} catch (error) {
  console.error(`perf-bench: ${error.message}`)
  process.exit(1)
}

