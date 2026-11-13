import { execFileSync } from 'node:child_process'
import { basename, resolve } from 'node:path'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'

const processLimit = 32

function cpuMilliseconds(value) {
  const match = value.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/)
  if (!match) throw new Error('Unrecognized ps CPU time')
  const [, days = '0', hours = '0', minutes, seconds, fraction = '0'] = match
  return ((Number(days) * 24 + Number(hours)) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(`0.${fraction}`) * 1000
}

export function parseRunnerProcesses(output) {
  return output.trim().split('\n').map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(.+)$/)
    // Do not emit raw lines in errors: even executable paths can contain private data.
    if (!match) throw new Error('Unrecognized ps process record')
    const [, pid, parentPid, startedAt, cpuTime, cpuPercent, executable] = match
    return { pid: Number(pid), parentPid: Number(parentPid), startedAt: startedAt.replace(/\s+/g, ' '),
      cpuMs: cpuMilliseconds(cpuTime), psCpuPercent: Number(cpuPercent), executable: basename(executable) }
  })
}

// Diagnostic only, outside Native benchmark windows. ps %cpu is a platform-weighted
// average, not CPU for this workload interval. Cumulative deltas require matching
// pid + start identity across snapshots; new/exited or omitted processes remain unknown.
export function runnerSnapshot(label) {
  const header = { schema: 1, label, observedAt: new Date().toISOString(), platform: platform(),
    revision: process.env.GITHUB_SHA ?? null, timezoneOffsetMinutes: new Date().getTimezoneOffset() }
  if (header.platform !== 'darwin') return { ...header, status: 'unavailable', reason: 'This diagnostic targets the macOS Native runner.' }
  let operation = 'collect'
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,time=,pcpu=,comm=', '-ww'], {
      encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 2000, maxBuffer: 2 * 1024 * 1024
    })
    operation = 'parse'
    const processes = parseRunnerProcesses(output)
    processes.sort((a, b) => b.psCpuPercent - a.psCpuPercent || a.pid - b.pid)
    return { ...header, status: 'available', source: 'ps comm (no arguments), lstart, cumulative time, weighted %cpu',
      processCount: processes.length, processLimit, truncated: processes.length > processLimit,
      processes: processes.slice(0, processLimit) }
  } catch (error) {
    // Observability must not replace or rewrite a benchmark failure. The workflow
    // also retains collector-process failures separately from its primary measurements.
    return { ...header, status: 'unavailable', reason: 'Process snapshot could not be collected or parsed.',
      operation, code: error.code, signal: error.signal, exitStatus: error.status }
  }
}

// Explicit diagnostic runs only: ordinary timing measurements never start this sampler.
export function observeRunnerProcesses() {
  const snapshots = []
  const intervalMs = 1000
  const sampleLimit = 128
  let truncated = false
  const capture = label => {
    if (snapshots.length === sampleLimit) { truncated = true; clearInterval(timer); return }
    const snapshot = runnerSnapshot(label)
    snapshots.push(snapshot)
    if (snapshot.status === 'unavailable') clearInterval(timer)
  }
  const timer = setInterval(() => capture('interval'), intervalMs)
  timer.unref()
  capture('start')
  return () => {
    clearInterval(timer)
    if (snapshots.at(-1).status === 'available') capture('end')
    return { intervalMs, sampleLimit, truncated, snapshots }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(runnerSnapshot(process.argv[2])))
}
