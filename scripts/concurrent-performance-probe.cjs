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
const hookTrees = []
const gitCalls = []
const fileCalls = []
let fileCallsTruncated = false
// API attempts, not successful writes or kernel/SQLite/Git-child syscalls. Never record contents.
const recordFileCall = (operation, method, path, fd, flags) => {
  if (fileCalls.length >= 20000) { fileCallsTruncated = true; return }
  const call = { at: Date.now(), operation, method, path: typeof path === 'string' ? path : null,
    fd: typeof fd === 'number' ? fd : null, flags: typeof flags === 'string' || typeof flags === 'number' ? flags : null }
  fileCalls.push(call)
  return call
}
const finishRead = (call, error, content) => {
  if (!call) return
  call.endedAt = Date.now()
  call.outcome = error ? 'error' : 'read'
  if (error) call.errorCode = error.code ?? null
  else if (Buffer.isBuffer(content)) call.returnedBytes = content.length
}
let gitCallsTruncated = false
const recordGit = (argv, cwd) => {
  if (gitCalls.length < 10000) gitCalls.push({ at: Date.now(), argv, cwd })
  else gitCallsTruncated = true
}
const open = fs.promises.open
fs.promises.open = async function (...args) {
  const handle = await open.apply(this, args)
  for (const method of ['sync', 'datasync']) {
    const original = handle[method]
    handle[method] = function (...values) {
      counters.fsync++
      recordFileCall('sync', `FileHandle.${method}`, args[0], this.fd, args[1])
      return original.apply(this, values)
    }
  }
  return handle
}
for (const method of ['fsync', 'fsyncSync', 'fdatasync', 'fdatasyncSync']) {
  const original = fs[method]
  fs[method] = function (...args) {
    counters.fsync++
    recordFileCall('sync', `fs.${method}`, undefined, args[0])
    return original.apply(this, args)
  }
}
for (const [target, prefix] of [[fs, 'fs'], [fs.promises, 'fs.promises']]) {
  for (const method of target === fs ? ['readFile', 'readFileSync'] : ['readFile']) {
    const original = target[method]
    target[method] = function (...args) {
      const call = recordFileCall('readFile', `${prefix}.${method}`, args[0], args[0])
      try {
        if (target === fs && method === 'readFile') {
          const callback = args.at(-1)
          if (typeof callback === 'function') args[args.length - 1] = function (error, content) {
            finishRead(call, error, content)
            return callback.apply(this, arguments)
          }
          return original.apply(this, args)
        }
        const result = original.apply(this, args)
        if (method === 'readFileSync') finishRead(call, null, result)
        else result.then(content => finishRead(call, null, content), error => finishRead(call, error))
        return result
      } catch (error) {
        finishRead(call, error)
        throw error
      }
    }
  }
}
const spawn = ChildProcess.prototype.spawn
ChildProcess.prototype.spawn = function (options) {
  counters.children++
  if (basename(options.file) === 'git') {
    counters.git++
    recordGit(options.args, options.cwd)
  }
  const timedHook = role === 'main' && options.file === '/bin/sh' && options.args[1]?.endsWith('/.scry/provider-hook.sh')
  const argv = options.args
  if (timedHook) options = { ...options, file: '/usr/bin/time', args: ['/usr/bin/time', '-p', ...argv],
    envPairs: [...options.envPairs.filter(value => !value.startsWith('LC_ALL=')), 'LC_ALL=C'] }
  const result = spawn.call(this, options)
  if (timedHook) {
    let stderr = ''
    this.stderr.on('data', chunk => { stderr += String(chunk) })
    this.once('close', code => hookTrees.push({ argv, code, stderr }))
  }
  return result
}
for (const method of ['spawnSync', 'execFileSync']) {
  const original = childProcess[method]
  childProcess[method] = function (file, ...args) {
    counters.children++
    if (basename(file) === 'git') {
      counters.git++
      const hasArgv = Array.isArray(args[0])
      recordGit([file, ...(hasArgv ? args[0] : [])], (hasArgv ? args[1] : args[0])?.cwd)
    }
    return original.call(this, file, ...args)
  }
}
syncBuiltinESMExports()
const delay = monitorEventLoopDelay({ resolution: 10 })
delay.enable()
const samples = []
const scopedTrace = []
let scopedTraceTruncated = false
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
    // Observe the real scoped protocol; never add legacy polling to the workload.
    if (channel === 'runTraces:subscribe' || channel === 'runTraces:ack') {
      const entry = channel === 'runTraces:subscribe'
        ? { at, kind: 'subscribe', status: result.status, subscriptionId: result.subscriptionId, runId: result.run?.runId }
        : { at, kind: 'ack', subscriptionId: args[1].subscriptionId, accepted: result, bytes: args[1].receipt.bytes }
      if (scopedTrace.length < 10000) scopedTrace.push(entry)
      else scopedTraceTruncated = true
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
    counters, samples, ipc, hookTrees, gitCalls, gitCallsTruncated, fileCalls, fileCallsTruncated,
    ...(role === 'main' ? { scopedTrace, scopedTraceTruncated } : {}) }) + '\n')
}
process.on('exit', flush)
module.exports = { counters, flush }
