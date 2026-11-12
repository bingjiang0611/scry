// Process identity for the B4-V scripts: the same evidence the daemon writes into
// `daemon.lock` and `scry-userdata.lock`, read the same way, so a script can tell "the
// daemon that wrote this lock" from "some process that now has its pid".
//
// Linux: `${pid}:linux:${boot_id}:${starttime}` from /proc, exactly like
// src/main/process-diagnostics.ts. macOS: `${pid}:${lstart}` from `ps` with LC_ALL=C and
// TZ=UTC, again exactly like the product, so a recorded key compares byte for byte.
//
// Nothing here signals a process it has not re-verified immediately before the signal,
// and nothing selects processes by name: only by recorded identity, by parentage of a
// verified process, or by an environment value that names this run's temporary directory.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/
const PS_ENV = { ...process.env, LC_ALL: 'C', TZ: 'UTC' }

export function parsePsRows(output) {
  const rows = new Map()
  for (const line of String(output).split('\n')) {
    const match = PS_ROW.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    rows.set(pid, { pid, ppid: Number(match[2]), status: match[3], startedAt: match[4], identityKey: `${pid}:${match[4]}`, command: match[5] })
  }
  return rows
}

export function linuxRow(pid, readFile = (path) => readFileSync(path, 'utf8')) {
  let stat
  try { stat = readFile(`/proc/${pid}/stat`) } catch { return undefined }
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const open = stat.indexOf('(')
  const commandName = open >= 0 ? stat.slice(open + 1, close) : ''
  const fields = stat.slice(close + 1).trim().split(/\s+/)
  const starttime = fields[19]
  const ppid = Number(fields[1])
  if (!starttime || !Number.isSafeInteger(ppid)) return undefined
  let bootId
  try { bootId = readFile('/proc/sys/kernel/random/boot_id').trim() } catch { return undefined }
  if (!bootId) return undefined
  let command = commandName
  try { command = readFile(`/proc/${pid}/cmdline`).replaceAll('\0', ' ').trim() || commandName } catch { /* exited between reads */ }
  return { pid, ppid, status: fields[0] ?? '', startedAt: `linux:${bootId}:${starttime}`, identityKey: `${pid}:linux:${bootId}:${starttime}`, command }
}

const defaultPs = (args) => execFileSync('/bin/ps', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: PS_ENV })

export function readIdentity(pid, { platform = process.platform, readFile, ps = defaultPs } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (platform === 'linux') return linuxRow(pid, readFile)
  let output
  try { output = ps(['-o', 'pid=,ppid=,stat=,lstart=,command=', '-p', String(pid)]) } catch { return undefined }
  return parsePsRows(output).get(pid)
}

/**
 * What a lock record proves about its holder right now. Only `verified` means "the
 * process that wrote this record is alive"; every other answer is a reason not to act.
 */
export function verifyHolder(record, observed) {
  if (!record || !Number.isSafeInteger(record.pid)) return 'unrecorded'
  if (typeof record.identityKey !== 'string' || record.identityKey.length === 0) return 'unrecorded'
  if (!observed) return 'gone'
  if (String(observed.status).startsWith('Z')) return 'zombie'
  return observed.identityKey === record.identityKey ? 'verified' : 'pid-reused'
}

export function readLockRecord(path, readFile = (target) => readFileSync(target, 'utf8')) {
  let raw
  try { raw = readFile(path) } catch { return null }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : { unreadable: true }
  } catch {
    return { unreadable: true }
  }
}

/** `startedBy: supervisor:<pid>` is free text in the product; it only nominates a candidate. */
export function supervisorPidFromLock(record) {
  const match = /^supervisor:(\d+)$/.exec(String(record?.startedBy ?? ''))
  return match ? Number(match[1]) : undefined
}

export function classifyDaemonCommand(command) {
  const text = String(command ?? '')
  if (/daemon-supervisor\.js(\s|$)/.test(text)) return 'supervisor'
  if (/(^|[/\s])daemon\.js(\s|$)/.test(text)) return 'daemon'
  return 'other'
}

export function listProcesses({ platform = process.platform, readFile, readDir = readdirSync, ps = defaultPs } = {}) {
  if (platform === 'linux') {
    const rows = []
    for (const name of readDir('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const row = linuxRow(Number(name), readFile)
      if (row) rows.push(row)
    }
    return rows
  }
  return [...parsePsRows(ps(['-axo', 'pid=,ppid=,stat=,lstart=,command='])).values()]
}

export function descendants(rows, rootPid) {
  const byParent = new Map()
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? []
    children.push(row)
    byParent.set(row.ppid, children)
  }
  const found = []
  const queue = [rootPid]
  const seen = new Set()
  while (queue.length > 0) {
    const pid = queue.shift()
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const child of byParent.get(pid) ?? []) {
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

export function parseEnviron(text) {
  const env = {}
  for (const entry of String(text).split('\0')) {
    const index = entry.indexOf('=')
    if (index > 0) env[entry.slice(0, index)] = entry.slice(index + 1)
  }
  return env
}

// `ps -E` appends the environment to the command, space separated. Values with spaces
// cannot be recovered from that text, which is why the scripts only ever look up keys
// whose values are paths this run created (no spaces).
export function envValueFromPsCommand(text, key) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`invalid env key: ${key}`)
  const match = new RegExp(`(?:^|\\s)${key}=(\\S*)`).exec(String(text))
  return match ? match[1] : undefined
}

export function readProcessEnv(pid, keys, { platform = process.platform, readFile = (path) => readFileSync(path, 'utf8'), ps = defaultPs } = {}) {
  try {
    if (platform === 'linux') {
      const env = parseEnviron(readFile(`/proc/${pid}/environ`))
      return { status: 'available', env: Object.fromEntries(keys.map((key) => [key, env[key]])) }
    }
    const text = ps(['-wwE', '-o', 'command=', '-p', String(pid)])
    return { status: 'available', env: Object.fromEntries(keys.map((key) => [key, envValueFromPsCommand(text, key)])) }
  } catch (error) {
    return { status: 'unavailable', reason: String(error?.code ?? error?.message ?? error) }
  }
}

/**
 * Processes whose environment names this value, e.g. SCRY_DAEMON_STATE_DIR of one fixture.
 * A process table that could not be read is `unavailable`, never an empty list: "no
 * leftover process" must be an observation, not the absence of one.
 */
export function processesWithEnv(key, value, options = {}) {
  const platform = options.platform ?? process.platform
  let rows
  try { rows = listProcesses(options) } catch (error) { return { status: 'unavailable', reason: `process_table:${error?.code ?? error}` } }
  if (platform === 'linux') {
    // Another user's environ is unreadable; those processes cannot carry this run's paths.
    return { status: 'available', rows: rows.filter((row) => readProcessEnv(row.pid, [key], options).env?.[key] === value) }
  }
  const ps = options.ps ?? defaultPs
  let text
  try { text = ps(['-wwEaxo', 'pid=,command=']) } catch (error) { return { status: 'unavailable', reason: `ps_environment:${error?.code ?? error}` } }
  const matching = new Set()
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match && envValueFromPsCommand(match[2], key) === value) matching.add(Number(match[1]))
  }
  return { status: 'available', rows: rows.filter((row) => matching.has(row.pid)) }
}

/** Re-read the identity immediately before signalling; a changed identity is never signalled. */
export function signalVerified(expected, signal, options = {}) {
  const observed = readIdentity(expected.pid, options)
  const verdict = verifyHolder(expected, observed)
  if (verdict !== 'verified') return { signalled: false, verdict }
  try {
    process.kill(expected.pid, signal)
    return { signalled: true, verdict }
  } catch (error) {
    return { signalled: false, verdict: error?.code === 'ESRCH' ? 'gone' : `error:${error?.code ?? error}` }
  }
}

/** Waits until none of these identities is alive; returns the ones that still are. */
export async function waitGone(identities, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs
  const alive = () => identities.filter((identity) => verifyHolder(identity, readIdentity(identity.pid, options)) === 'verified')
  let live = alive()
  while (live.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    live = alive()
  }
  return live
}
