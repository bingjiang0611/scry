// Report construction for one concurrency trace cell: source identity, before/after hashes and the
// bounded summaries the launcher prints. Data work only — nothing here starts, stops or inspects the
// measured process, so the launcher stays the single owner of the Electron lifecycle.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TASKS = 16
export const OUTPUT_TAIL_CHARS = 8_000

// The harness and helper files this launcher and cell are made of. Production code is covered only through
// the bundle hash, and equal before/after hashes cannot prove that no source changed between the build and
// the hash — they show only that these files and the bundle file did not change during the run.
export const SOURCE_FILES = [
  'scripts/concurrency-trace-bench.mjs',
  'scripts/concurrency-trace-launcher-report.mjs',
  'scripts/fixtures/concurrency-trace-electron.ts',
  'scripts/fixtures/concurrency-trace-trial.ts',
  'scripts/fixtures/concurrency-trace-trial-report.ts',
  'scripts/fixtures/concurrency-trace-host.ts',
  'scripts/fixtures/concurrency-trace-workload.ts',
  'scripts/owned-app-processes.mjs',
  'scripts/session-concurrency-electron.mjs'
]

export const UNAVAILABLE = {
  rendererCommit: 'no BrowserWindow exists in this cell: renderer mounts, commits, mirroring and UI evidence are unavailable',
  providerProcess: 'no Provider CLI or SDK runs in this cell: Provider usage, approvals and Provider timings are unavailable',
  tls: 'peers are served by the host fixture over an in-process JSON wire, not over the TLS transport',
  appRelease: 'the Electron entry is a fixture bundle built from this working tree: its versions are process facts, not a release claim'
}

export const TIMING = {
  lock: 'millisecond conclusions require the timing-run.mjs wrapper; this launcher only runs the cell',
  highLoad: 'reported by that wrapper footer alone; the launcher never claims a load level or L2 evidence'
}

export const errorMessage = (error) => (error instanceof Error ? error.message : String(error))
const hashOf = (value) => createHash('sha256').update(value).digest('hex')
export const hashFile = (path) => hashOf(readFileSync(path))
// Source identity is evidence about what was measured, not a build-freshness proof: the hashes below are
// taken before and after one run and can only show that the inputs did not change during it.
export function readIdentity(root) {
  const git = (args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
    { cwd: root, encoding: 'utf8' }).trim()
  let metadata = null
  try { metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch { metadata = null }
  const identity = { packageName: null, packageVersion: null, sourceSha: null, workingTreeDirty: null,
    launcherPlatform: process.platform, launcherArch: process.arch, launcherNode: process.version, error: null }
  if (metadata && typeof metadata.name === 'string') identity.packageName = metadata.name
  if (metadata && typeof metadata.version === 'string') identity.packageVersion = metadata.version
  try {
    identity.sourceSha = git(['rev-parse', 'HEAD'])
    identity.workingTreeDirty = git(['status', '--porcelain']).length > 0
  } catch (error) {
    identity.error = errorMessage(error)
  }
  return identity
}

export function hashSources(root) {
  try {
    return { status: 'measured', files: Object.fromEntries(SOURCE_FILES.map((file) => [file, hashFile(join(root, file))])) }
  } catch (error) {
    return { status: 'unavailable', reason: `could not hash the measured sources: ${errorMessage(error)}`, files: {} }
  }
}

export function cleanupEvidence(state) {
  // Stop confirmation, child close and temp removal are separate facts; none of them stands in for another.
  return { stop: state.stop, childClose: state.close, tempRemoval: state.tempRemoval, leftover: state.leftover,
    allocation: 'registered process identities only; descendants this process never registered stay unknown' }
}

export function hashEvidence(state) {
  return {
    before: state.hashesBefore, after: state.hashesAfter, bundleBefore: state.bundle ? state.bundle.sha256 : null,
    bundleAfter: state.bundleHashAfter, bundleError: state.hashError,
    note: 'harness/helper files and the bundle file, hashed before and after one run; unchanged hashes do not prove the bundle was built from these sources or that no other source changed'
  }
}

export function successSummary(state, config, startedAtMs) {
  return {
    status: 'measured',
    cell: { ...config, tasks: TASKS },
    identity: state.identity,
    runtime: state.payload.runtime,
    trial: state.payload.trial,
    memory: state.payload.memory,
    durations: { ...state.payload.durations, launcherWallMs: Date.now() - startedAtMs },
    cleanup: cleanupEvidence(state),
    hashChecks: hashEvidence(state),
    isolation: state.payload.isolation,
    unavailable: UNAVAILABLE,
    timing: TIMING
  }
}

export function failureSummary(state, config) {
  const text = state.captureText ?? ''
  return {
    status: 'failed',
    reason: state.reason,
    error: state.error,
    // Kept as separate fields so a cleanup or result-read failure cannot overwrite the primary reason.
    cleanupError: state.cleanupError,
    resultError: state.resultError,
    notificationError: state.notificationError,
    cell: { ...config, tasks: TASKS },
    identity: state.identity,
    runtime: state.payload ? state.payload.runtime : null,
    memory: state.payload ? state.payload.memory : null,
    notification: state.notification,
    trialStatus: state.payload ? state.payload.status : null,
    trial: state.payload ? state.payload.trial : null,
    trialError: state.payload ? state.payload.error : null,
    cleanup: cleanupEvidence(state),
    hashChecks: hashEvidence(state),
    diagnostics: {
      tempPath: state.temp,
      resultPath: state.paths ? state.paths.result : null,
      bundlePath: state.bundle ? state.bundle.bundlePath : null,
      logPath: state.logPath,
      logError: state.logError,
      outputTail: text.slice(-OUTPUT_TAIL_CHARS),
      outputChars: text.length,
      outputTruncated: state.captureTruncated
    }
  }
}
