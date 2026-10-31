// Identity hashing, boundary deltas and archive convergence for the live lane (R6.3).
//
// Separated from the launcher so the entry file stays readable and so the numbers have
// one definition: content hashes identify the measurement subject, boundary deltas turn
// two process snapshots into an identity-checked phase delta, and the archive reader
// takes both real roots with provenance instead of guessing one.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readArchiveTurns } from '../session-concurrency-evidence.mjs'

export const delay = (ms) => new Promise((done) => setTimeout(done, ms))

export const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Content identity of a fixed file list, relative to `base`. */
export function hashFiles(base, files) {
  const digest = createHash('sha256')
  for (const file of [...files].sort()) digest.update(`${file}\0${hashFile(join(base, file))}\n`)
  return digest.digest('hex')
}

/** Content identity of a whole directory tree (the built fixture output). */
export function hashTree(directory) {
  const digest = createHash('sha256')
  for (const name of readdirSync(directory, { recursive: true }).sort()) {
    const path = join(directory, name)
    if (statSync(path).isFile()) digest.update(`${name}\0${hashFile(path)}\n`)
  }
  return digest.digest('hex')
}

/**
 * Shape of one boundary sample as the launcher stores it: a label, when it was taken, and
 * the snapshot channel reply. `renderer` is present only when that boundary had a CDP
 * session; a missing side is reported as unavailable, never as zero.
 */
export function sampleShape(sample) {
  const issues = []
  if (!sample || typeof sample !== 'object') return { ok: false, issues: ['sample is not an object'] }
  if (typeof sample.label !== 'string' || sample.label.length === 0) issues.push('label is missing')
  if (!Number.isFinite(sample.takenAtEpochMs)) issues.push('takenAtEpochMs is not a finite number')
  const main = sample.main
  if (!main || typeof main !== 'object') issues.push('main envelope is missing')
  else if (main.status !== 'measured') {
    if (typeof main.reason !== 'string' || main.reason.length === 0) issues.push('unavailable main envelope has no reason')
  } else if (!main.snapshot || typeof main.snapshot !== 'object') issues.push('measured main envelope has no snapshot')
  return { ok: issues.length === 0, issues }
}

const cpuNumbers = (snapshot) => ({
  user: snapshot?.cpu?.user,
  system: snapshot?.cpu?.system,
  monotonicMs: snapshot?.monotonicMs
})

function deltaCounter(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { value: null, reason: 'counter_unavailable' }
  if (end < start) return { value: null, reason: 'counter_reset' }
  return { value: end - start, reason: null }
}

/**
 * Phase delta between two boundary samples of one process tree.
 *
 * Identity is checked, not assumed: a pid that changed creation time was restarted, a pid
 * that disappeared has no after value, and a process that appeared has no before value.
 * Only finite, non-decreasing cumulative CPU counters produce a number; everything else is
 * `null` with the reason. Memory is the level at the end boundary, never summed, and never
 * taken from a process that already exited.
 */
export function boundaryDelta(before, after, { pids = null } = {}) {
  const issues = []
  const shapeBefore = sampleShape(before)
  const shapeAfter = sampleShape(after)
  if (!shapeBefore.ok || !shapeAfter.ok) {
    return {
      status: 'unavailable',
      reason: 'a boundary sample was malformed',
      issues: [...shapeBefore.issues, ...shapeAfter.issues],
      scope: { pids },
      perProcess: []
    }
  }
  if (before.main.status !== 'measured' || after.main.status !== 'measured') {
    return {
      status: 'unavailable',
      reason: 'a boundary sample was unavailable',
      before: before.main.status,
      after: after.main.status,
      beforeReason: before.main.reason ?? null,
      afterReason: after.main.reason ?? null,
      scope: { pids },
      perProcess: []
    }
  }
  const first = before.main.snapshot
  const second = after.main.snapshot
  const start = cpuNumbers(first)
  const end = cpuNumbers(second)
  const wall = deltaCounter(start.monotonicMs, end.monotonicMs)
  if (wall.reason) issues.push(`wall clock ${wall.reason}`)
  const mainUser = deltaCounter(start.user, end.user)
  const mainSystem = deltaCounter(start.system, end.system)
  if (mainUser.reason) issues.push(`main cpu user ${mainUser.reason}`)
  if (mainSystem.reason) issues.push(`main cpu system ${mainSystem.reason}`)

  const firstMetrics = Array.isArray(first.metrics) ? first.metrics : []
  const secondMetrics = Array.isArray(second.metrics) ? second.metrics : []
  const wanted = pids ?? [...new Set([...firstMetrics, ...secondMetrics].map((entry) => entry.pid))]
  const perProcess = wanted.map((pid) => {
    const startEntry = firstMetrics.find((entry) => entry.pid === pid)
    const endEntry = secondMetrics.find((entry) => entry.pid === pid)
    const base = { pid, type: endEntry?.type ?? startEntry?.type ?? null }
    if (!startEntry && !endEntry) return { ...base, identity: 'absent', cpuSeconds: null, workingSetKb: null, reason: 'absent_in_both_samples' }
    if (!startEntry) return { ...base, identity: 'appeared', cpuSeconds: null, workingSetKb: endEntry?.workingSetKb ?? null, reason: 'process_appeared_during_phase' }
    if (!endEntry) return { ...base, identity: 'exited', cpuSeconds: null, workingSetKb: null, reason: 'process_exited_during_phase' }
    const sameIdentity = Number.isFinite(startEntry.creationTime) && Number.isFinite(endEntry.creationTime) && startEntry.creationTime === endEntry.creationTime
    if (!sameIdentity) {
      return { ...base, identity: 'restarted', createdAt: startEntry.creationTime ?? null, endedAt: endEntry.creationTime ?? null, cpuSeconds: null, workingSetKb: endEntry.workingSetKb ?? null, reason: 'pid_reused_by_another_process' }
    }
    const cpu = deltaCounter(startEntry.cumulativeCpuSeconds, endEntry.cumulativeCpuSeconds)
    if (cpu.reason) issues.push(`pid ${pid} cpu ${cpu.reason}`)
    return { ...base, identity: 'same', createdAt: startEntry.creationTime, cpuSeconds: cpu.value, workingSetKb: endEntry.workingSetKb ?? null, reason: cpu.reason }
  })
  if (wanted.length === 0) issues.push('no process was selected for this scope')
  // The snapshot's `cpu` counters belong to the process that took the sample (client main, host
  // main or the launcher Node), not to the filtered pids. Under a filtered scope such as one
  // renderer that number is not renderer evidence, so it is reported as unavailable instead of
  // being read as renderer cost — and never as 0. It is kept only when the filter provably
  // selects the sampling pid (the launcher samples itself with `pids: [process.pid]`).
  const samplerPid = Number.isInteger(first.pid) ? first.pid : (Number.isInteger(second.pid) ? second.pid : null)
  const samplerSelected = pids === null || (samplerPid !== null && pids.includes(samplerPid))
  return {
    status: 'measured',
    wallMs: wall.value,
    mainProcessCpu: samplerSelected
      ? { status: 'measured', samplerPid, userUs: mainUser.value, systemUs: mainSystem.value }
      : { status: 'unavailable', reason: 'outside_filtered_scope', samplerPid, pids },
    perProcess,
    scope: { pids: pids === null ? 'every reported process' : pids },
    issues
  }
}

/**
 * Named phase deltas over one set of marks. `includes` spells out what a range covers so a
 * reader can see that nested ranges overlap and must not be added together.
 */
export function phaseDeltas(marks, ranges, { pids = null, scope = null } = {}) {
  return ranges.map(({ name, from, to, includes }) => {
    const before = marks[from]
    const after = marks[to]
    const missing = []
    if (!before) missing.push(from)
    if (!after) missing.push(to)
    return {
      name,
      from,
      to,
      includes,
      // Which process tree this range describes. Host, client and launcher scopes differ and
      // are never merged, so a reader can tell them apart without guessing from the pids.
      scope,
      delta: missing.length > 0
        ? { status: 'unavailable', reason: `missing marks: ${missing.join(', ')}`, scope: { pids }, perProcess: [] }
        : boundaryDelta(before, after, { pids })
    }
  })
}

/** Start of the launcher process (epoch ms), used as the creation identity of its sample. */
const NODE_STARTED_AT = performance.timeOrigin

const cumulativeSeconds = () => {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1_000_000
}

/**
 * Boundary sample of the launcher's own Node process (the driver/observer). It has the same
 * envelope as the host and client samples so one delta function applies, but the scope is
 * this process only: it is never mixed with the host tree or a peer renderer.
 */
export function nodeSample(label) {
  const memory = process.memoryUsage()
  return {
    label,
    takenAtEpochMs: Date.now(),
    main: {
      status: 'measured',
      snapshot: {
        // Own pid of the launcher: a filtered scope can prove that these `cpu` counters are
        // its own (see the sampler check in boundaryDelta). The metrics entry below is a
        // separate cumulative counter, so the pid is carried at both levels.
        pid: process.pid,
        monotonicMs: Number(process.hrtime.bigint() / 1_000_000n),
        cpu: process.cpuUsage(),
        memory,
        metrics: [{
          pid: process.pid,
          type: 'Node',
          creationTime: NODE_STARTED_AT,
          cumulativeCpuSeconds: cumulativeSeconds(),
          workingSetKb: Math.round(memory.rss / 1024)
        }]
      }
    },
    renderer: { status: 'unavailable', reason: 'the launcher Node process has no renderer' }
  }
}

/** Both durable roots the App really writes, in the order the App writes them. */
export const ARCHIVE_ROOTS = ['trace-archive-turns-v1', 'trace-archives-v2']

/**
 * Reads both archive roots and keeps provenance. A root that does not exist is reported
 * as absent, never as an empty success; a run found in both roots is listed once with
 * both sources so a reader can see where the evidence came from.
 */
export function readArchiveSources(userData, roots = ARCHIVE_ROOTS) {
  const sources = roots.map((name) => {
    const directory = join(userData, name)
    if (!existsSync(directory)) return { name, directory, present: false, segments: 0, ignored: 0 }
    const read = readArchiveTurns(directory)
    return { name, directory, present: true, segments: read.files.segments, ignored: read.files.ignored, turns: read.turns }
  })
  const byRun = new Map()
  for (const source of sources) {
    for (const turn of source.turns ?? []) {
      const entry = byRun.get(turn.runId) ?? { runId: turn.runId, turn: null, sources: [], variants: [] }
      entry.sources.push(source.name)
      // Every source's copy is kept so a duplicate can be compared instead of silently
      // shadowed by whichever root was read first.
      entry.variants.push({ source: source.name, turn })
      if (!entry.turn) entry.turn = turn
      byRun.set(turn.runId, entry)
    }
  }
  return {
    roots: sources.map(({ turns, ...rest }) => rest),
    turns: [...byRun.values()]
  }
}

/**
 * Waits (bounded) for the recorder's durable archive to contain every run of a wave.
 * A run still missing at the deadline is listed in `missing` and reported as a failure
 * with that deadline; the waiting time is recorded so the reader sees what it cost.
 */
export async function readArchiveFor(userData, runIds, timeoutMs) {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let last = readArchiveSources(userData)
  while (Date.now() < deadline && !runIds.every((runId) => last.turns.some((entry) => entry.runId === runId))) {
    await delay(100)
    last = readArchiveSources(userData)
  }
  const found = new Set(last.turns.map((entry) => entry.runId))
  return { ...last, waitedMs: Date.now() - startedAt, missing: runIds.filter((runId) => !found.has(runId)) }
}
