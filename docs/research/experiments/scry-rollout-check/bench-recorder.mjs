import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUNDS, opt, sleep } from './bench-args.mjs'
import { dirtyTree, processUsage } from './bench-copy.mjs'
import { countGitCalls, evidenceDigest } from './bench-gitcalls.mjs'
import { hook, load, node, recordCount, run, skipCount, stats, tryRun, turn, unavailable } from './bench-util.mjs'

async function recorderPhase(scry, work, report) {
  const provider = opt('provider', 'qoder')
  node(scry, ['init', '--workspace', work, '--providers', provider, '--json'])
  if (existsSync(join(work, 'scry.config.json'))) {
    const config = JSON.parse(readFileSync(join(work, 'scry.config.json'), 'utf8'))
    if (config.commitHook) throw new Error('copy still has a commitHook after init; refusing to run (it could upload)')
  }
  const r = { provider, note: 'synthetic hook payloads through the copy\'s provider-hook.sh; measures recorder work, not the Provider', modes: {} }
  // Warm-up turn: starts the daemon and fills OS caches; not counted.
  await turn(work, provider, 1, {}, undefined)
  const daemon = () => { try { return JSON.parse(node(scry, ['recorder', 'status', '--workspace', work])) } catch { return {} } }
  const startStatus = daemon()
  const startUsage = startStatus.pid ? processUsage(startStatus.pid) : undefined
  const dirty = dirtyTree(work)
  const scenarios = [
    ['clean, 0 tools', 0, undefined], ['clean, 5 tools', 5, undefined], ['clean, 30 tools', 30, undefined],
    [`${dirty.label}, 5 tools`, 5, dirty]
  ]
  for (const [mode, env] of [['daemon fast path', {}], ['CLI fallback', { SCRY_RECORDER_TRANSPORT: 'direct' }]]) {
    const out = {}
    for (const [name, tools, d] of scenarios) {
      const loadBefore = load()
      const samples = []
      for (let i = 0; i < ROUNDS; i++) samples.push(await turn(work, provider, tools, env, d))
      const totals = samples.map((s) => s.start + s.tool.reduce((a, b) => a + b, 0) + s.stop)
      const visible = samples.map((s) => s.visibleMs).filter((v) => v !== undefined)
      out[name] = {
        turnStart: stats(samples.map((s) => s.start)),
        toolEvent: tools ? stats(samples.flatMap((s) => s.tool)) : unavailable('no tool events in this scenario'),
        stop: stats(samples.map((s) => s.stop)),
        hookTotalPerTurn: stats(totals),
        stopToRecordVisible: visible.length === samples.length ? stats(visible) : { ...stats(visible), missing: samples.length - visible.length },
        loadAverage: { before: loadBefore, after: load() }
      }
      process.stdout.write(`  recorder ${mode} / ${name}: start p50 ${out[name].turnStart.p50}ms, stop p50 ${out[name].stop.p50}ms, turn total p50 ${out[name].hookTotalPerTurn.p50}ms\n`)
    }
    r.modes[mode] = out
  }
  const endStatus = daemon()
  const endUsage = endStatus.pid ? processUsage(endStatus.pid) : undefined
  await sleep(30_000)
  const idleUsage = endStatus.pid ? processUsage(endStatus.pid) : undefined
  r.daemon = endStatus.pid ? {
    pid: endStatus.pid, restartedDuringRun: startStatus.pid !== endStatus.pid,
    rssMiB: { afterWarmup: startUsage?.rssMiB, afterRun: endUsage?.rssMiB, after30sIdle: idleUsage?.rssMiB },
    cpuSecondsDuringRun: startUsage && endUsage && startStatus.pid === endStatus.pid ? Math.round((endUsage.cpuSeconds - startUsage.cpuSeconds) * 10) / 10 : unavailable('daemon restarted or not sampled'),
    cpuSecondsIn30sIdle: endUsage && idleUsage ? Math.round((idleUsage.cpuSeconds - endUsage.cpuSeconds) * 10) / 10 : unavailable('not sampled'),
    errorCount: endStatus.errorCount
  } : unavailable('recorder status reported no daemon pid')
  // L1 counts, untimed, after the resource sampling above (they restart the daemon).
  for (const [mode, env] of [['daemon fast path', {}], ['CLI fallback', { SCRY_RECORDER_TRANSPORT: 'direct' }]]) {
    for (const [name, tools, d] of scenarios) {
      r.modes[mode][name].gitCalls = await countGitCalls(work, provider, tools, env, d, undefined,
        () => tryRun(process.execPath, [scry, 'recorder', 'stop', '--workspace', work]))
      const g = r.modes[mode][name].gitCalls
      process.stdout.write(`  recorder ${mode} / ${name}: git calls start ${g.turnStart ?? '-'}, tools ${g.toolEvents ?? '-'}, stop ${g.stop ?? '-'}\n`)
    }
  }
  r.evidence = await evidenceDigest(work, provider, dirty)
  process.stdout.write(`  recorder evidence digest (dirty turn): ${r.evidence.digest ?? r.evidence.reason}\n`)
  tryRun(process.execPath, [scry, 'recorder', 'stop', '--workspace', work])
  const records = recordCount(work)
  const scryKiB = Number(tryRun('du', ['-sk', join(work, '.scry')])?.split(/\s+/)[0] ?? NaN)
  r.disk = { records, scryMiB: Math.round(scryKiB / 102.4) / 10, kibPerRecord: records ? Math.round(scryKiB / records) : null }
  r.hookSkips = skipCount(work)
  r.verify = tryRun(process.execPath, [scry, 'turns', 'verify', '--workspace', work]) !== undefined ? 'ok' : 'failed'
  tryRun(process.execPath, [scry, 'recorder', 'stop', '--workspace', work])
  report.recorder = r
  return r
}

export { recorderPhase }
