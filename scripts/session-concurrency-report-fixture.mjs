import { buildConcurrencyReport } from './session-concurrency-report.mjs'
import { selectScenario } from './session-concurrency-contract.mjs'

// Shared report fixture for the negative-control tests, so the two report test files build the same shape
// instead of drifting apart. Every measured lane is plausible; the tests then break one fact at a time.
export const MEASURED_MAIN = {
  status: 'measured', cpuMs: 250, window: { startedAtEpochMs: 1, endedAtEpochMs: 2, wallMs: 1_000 },
  attribution: 'main process CPU including the in-process offline smoke Provider; not an isolated Provider CPU and not a peak'
}

// The reported session fails every run, so the report is honestly incomplete: that keeps the lane and
// status contracts exercised without pretending a measurement happened.
// Fixed total work against a bounded in-flight limit: the reported batch here completed nothing, so the
// lane says so instead of scoring zero waits for tasks that never ran.
export const TASK_POOL = {
  status: 'incomplete',
  source: 'renderer performance.now() with one enqueue instant for the batch; every dispatch and terminal uses the same page clock',
  policy: 'fixture worker pool, not a product scheduler: at most limit drives in flight, tasks dispatched in index order, '
    + 'the first observed drive failure stops new dispatches while already-dispatched tasks still converge, and the '
    + 'remainder is not-started',
  tasks: 4, limit: 4, dispatched: 0, completed: 0, notStarted: [0, 1, 2, 3], failed: [],
  firstFailure: { index: 0, error: 'start failed' },
  queueWaitMs: null, batchMs: null, completedPerSecond: null,
  note: 'queueWait is waiting for a slot, not accepted concurrency; peak overlap stays in observedConcurrency against the '
    + 'configured level, and completedPerSecond is a batch throughput, not a per-run rate'
}

export function reportParts(overrides = {}) {
  return {
    scenario: selectScenario('stream'), concurrency: 4,
    identity: { sourceSha: 'd'.repeat(40), artifactSha256: 'e'.repeat(64), harnessSha256: 'f'.repeat(64),
      fixtureSha256: '1'.repeat(64), platform: 'darwin', arch: 'arm64', osRelease: '23.0.0', cpuModel: 'apple',
      cpuCount: 10, totalMemoryBytes: 1, node: 'v22.0.0', electron: '32.0.0', appVersion: '0.1.0' },
    runs: [], failures: [0, 1, 2, 3].map(index => ({ index, error: 'start failed' })),
    probe: null,
    resources: { status: 'unavailable', reason: 'no [scry:resource] window during active' },
    quietResources: { status: 'unavailable', reason: 'scenario has no quiet window' },
    startupResources: { status: 'unavailable', reason: 'no [scry:resource] window during startup' },
    spanningResources: { status: 'unavailable', reason: 'no [scry:resource] window during spanning' },
    resourceSampling: { intervalMs: 5000, source: 'src/main/bootstrap/app-lifecycle.ts', windows: 0,
      fullyInsidePhase: 0, spanning: 0, unknown: 0 },
    mainCpu: MEASURED_MAIN,
    rendererTask: { status: 'unavailable', reason: 'CDP Performance.getMetrics TaskDuration was not readable at both boundaries' },
    processCpu: PROCESS_CPU,
    taskPool: TASK_POOL,
    quietProcessCpu: { status: 'unavailable', reason: 'scenario has no quiet window' },
    observedConcurrency: { status: 'unavailable', reason: 'no usable run interval was recorded' },
    quietMainCpu: { status: 'unavailable', reason: 'scenario has no quiet window' },
    quietRendererTask: { status: 'unavailable', reason: 'scenario has no quiet window' },
    switchPreparation: [], switchStartedRows: [],
    rendererMount: { status: 'unavailable', reason: 'no run was queried for transcript mounting' },
    rendererWindows: [], phases: { status: 'unavailable', reason: 'no agent/ipc named trace was recorded' },
    journal: { status: 'measured', issues: [] }, sqlite: { status: 'ready', turns: 0, readMs: 1 },
    cleanup: { cleanupConfirmed: false, cleanupAttempted: true, leftoverOwnedProcesses: { state: 'observed' } },
    switches: { status: 'unavailable', reason: 'scenario performs no history switch' },
    archiveFiles: { roots: [] }, sidebarSessions: 0,
    diagnostics: { logLines: 0, malformedDiagnosticLines: 0, malformedSamples: [], logPath: '/tmp/x' },
    ...overrides
  }
}

export const PROCESS_CPU = {
  status: 'measured',
  source: 'app.getAppMetrics() CPUUsage.cumulativeCPUUsage delta across the same two boundaries, matched by pid + creationTime',
  attribution: 'Electron-reported processes only; never added to mainProcessCpu (Browser here is that process) or to task time',
  byType: { Browser: { processes: 1, cpuMs: 100 }, Tab: { processes: 1, cpuMs: 50 } },
  totalCpuMs: 150,
  coverage: { endProcesses: 2, matchedProcesses: 2, addedProcesses: 0, removedProcesses: 0,
    unidentifiedProcesses: 0, missingCounterProcesses: 0, regressedProcesses: 0, matchedShare: 1 },
  note: 'every described process matched by pid + creationTime with a valid counter; unreported processes are unknown'
}

export function minimalReport(overrides) {
  return buildConcurrencyReport(reportParts(overrides))
}
