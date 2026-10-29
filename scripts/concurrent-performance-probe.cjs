// Measurement-only instrumentation, loaded before production modules in the isolated App/CLI.
const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const childProcess = require('node:child_process')
const { ChildProcess } = childProcess
const { monitorEventLoopDelay } = require('node:perf_hooks')
const { basename } = require('node:path')
const role = process.env.SCRY_CONCURRENT_ROLE || 'main'
const counters = { fsync: 0, git: 0, children: 0, activeRunsCalls: 0, activeRunsJsonBytes: 0 }
const ipc = []
const open = fs.promises.open
fs.promises.open = async function (...args) {
  const handle = await open.apply(this, args)
  for (const method of ['sync', 'datasync']) {
    const original = handle[method]
    handle[method] = function (...values) {
      counters.fsync++
      return original.apply(this, values)
    }
  }
  return handle
}
for (const method of ['fsync', 'fsyncSync', 'fdatasync', 'fdatasyncSync']) {
  const original = fs[method]
  fs[method] = function (...args) { counters.fsync++; return original.apply(this, args) }
}
const spawn = ChildProcess.prototype.spawn
ChildProcess.prototype.spawn = function (options) {
  counters.children++
  if (basename(options.file) === 'git') counters.git++
  return spawn.call(this, options)
}
for (const method of ['spawnSync', 'execFileSync']) {
  const original = childProcess[method]
  childProcess[method] = function (file, ...args) {
    counters.children++
    if (basename(file) === 'git') counters.git++
    return original.call(this, file, ...args)
  }
}
syncBuiltinESMExports()
const delay = monitorEventLoopDelay({ resolution: 10 })
delay.enable()
const samples = []
let timer
let hooks
if (role === 'main') {
  const { app, ipcMain } = require('electron')
  hooks = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => hooks(channel, async (...args) => {
    const at = Date.now()
    const before = performance.now()
    const result = await listener(...args)
    if (channel === 'agent:activeRuns') {
      const bytes = Buffer.byteLength(JSON.stringify(result))
      counters.activeRunsCalls++
      counters.activeRunsJsonBytes += bytes
      ipc.push({ at, channel, runs: result.length, jsonBytes: bytes, ms: performance.now() - before })
    }
    return result
  })
  const sample = () => {
    samples.push({ at: Date.now(), counters: { ...counters }, rss: process.memoryUsage().rss,
      cpu: process.cpuUsage(), processes: app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({ pid, type, cpu, memory })),
      eventLoopP95Ms: delay.percentile(95) / 1e6, eventLoopMaxMs: delay.max / 1e6 })
    delay.reset()
  }
  app.whenReady().then(() => { timer = setInterval(sample, 250); timer.unref(); sample() })
  app.on('will-quit', () => { clearInterval(timer); sample(); flush() })
}
let written = false
const flush = () => {
  if (written) return
  written = true
  delay.disable()
  fs.appendFileSync(process.env.SCRY_CONCURRENT_LOG, JSON.stringify({ role, pid: process.pid, at: Date.now(),
    argv: process.argv.slice(2), cpu: process.cpuUsage(), usage: process.resourceUsage(), uptimeSeconds: process.uptime(),
    counters, samples, ipc }) + '\n')
}
process.on('exit', flush)
module.exports = { counters, flush }
