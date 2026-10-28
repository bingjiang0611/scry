import { RENDERER_COMMIT_UNAVAILABLE, rendererCommitLane, summarizeRendererObservation, summarizeTraceHealth,
  unavailable } from './session-concurrency-aggregate.mjs'
import { evaluateStatus } from './session-concurrency-contract.mjs'

export function buildConcurrencyReport(parts) {
  const { scenario, concurrency, tasks = concurrency, taskPool, identity, runs, failures, probe, resources,
    quietResources, startupResources,
    spanningResources, resourceSampling, mainCpu, rendererTask, processCpu, quietProcessCpu,
    quietMainCpu, quietRendererTask,
    switchPreparation, switchStartedRows, observedConcurrency, rendererMount,
    rendererWindows, phases, journal, sqlite, cleanup, switches, archiveFiles, diagnostics, sidebarSessions } = parts
  const lanes = {
    wallMs: { source: 'renderer performance.now() from the start request to the terminal event',
      runs: runs.map(run => ({ runId: run.runId, startReceiptMs: run.startReceiptMs,
        firstOutputReceiptMs: run.firstOutputReceiptMs, startToTerminalMs: run.startToTerminalMs,
        traceEvents: run.traceEvents, traceMirrored: run.traceMirrored })) },
    // Per-run terminal -> readable timing was removed: it was measured through agent:loadSession,
    // which aborts the previous global request in production, so it timed a cancellation race rather
    // than a readback. History is now verified once from the durable archive after exit.
    historyReadback: unavailable('per-run visible readback is removed: agent:loadSession aborts the previous global request '
      + '(src/main/bootstrap/history-load.ts), so concurrent readback cancels itself; the durable archive is read after exit'),
    mainProcessCpu: mainCpu,
    // Electron's own per-process counters, matched by pid + creationTime. Never summed with mainProcessCpu
    // (the Browser entry here is that process) or with rendererTask (task time is not CPU).
    processCpu: processCpu ?? unavailable('this report carried no per-process CPU lane'),
    quietProcessCpu: quietProcessCpu ?? unavailable('this report carried no quiet per-process CPU lane'),
    rendererTask,
    // Post-settlement idle, measured from the after-terminal boundary to a separate after-quiet one.
    // It is not an active Provider producing no output: every run had already reached its terminal.
    quietMainProcessCpu: quietMainCpu,
    quietRendererTask,
    switchPreparation: switchPreparation ?? [],
    // Admission per task after dispatch and before the first history click: start reply for that cwd plus its
    // rendered row. An unobserved fact means the "nothing shifted" claim is unproven, so it stays unavailable.
    switchStartedRows: switchStartedRows ?? [],
    observedConcurrency,
    // Fixed total work against a bounded in-flight limit. queueWait is queueing evidence, never accepted
    // concurrency, and an unstarted task is listed instead of scoring a zero wait.
    taskPool: taskPool ?? unavailable('this report carried no task pool lane'),
    rendererMount,
    resourceWindowSampling: resourceSampling,
    cpu: resources,
    quietCpu: quietResources,
    startupCpu: startupResources,
    spanningCpu: spanningResources,
    providerProcess: unavailable('in-process offline smoke adapter has no Provider child process'),
    // forced:false only means no collection was forced; this harness collects no GC events, so post-GC
    // residency cannot be observed and is not attributed to a natural GC.
    gc: { forced: false, postCollectionResidency: unavailable('GC events are not collected by this harness'),
      note: 'no GC was forced; that is not evidence that a natural collection ran or freed anything' },
    rendererCommit: rendererCommitLane(),
    rendererObservation: summarizeRendererObservation(probe),
    traceHealth: summarizeTraceHealth(probe),
    rendererWindows: rendererWindows.length === 0
      ? unavailable('no [scry:renderer-perf] window was published')
      : { status: 'measured', windows: rendererWindows.length,
        longTaskCount: rendererWindows.reduce((total, window) => total + (window.longTaskCount ?? 0), 0),
        maxFrameGapMsMax: Math.max(...rendererWindows.map(window => window.maxFrameGapMs ?? 0)) },
    phases,
    archive: {
      status: runs.length > 0 && runs.every(run => run.diskVerified === true) ? 'measured' : 'incomplete',
      diskVerifiedRuns: runs.filter(run => run.diskVerified === true).length,
      archiveFiles,
      runs: runs.map(run => ({ runId: run.runId, ...run.evaluation })),
      allRunsPassed: runs.length > 0 && runs.every(run => run.evaluation?.passed === true),
      streamedTextCharsMin: runs.length > 0 ? Math.min(...runs.map(run => run.evidence?.modelTextChars ?? 0)) : null,
      toolResultBytesMin: runs.length > 0 ? Math.min(...runs.map(run => run.evidence?.toolResultBytes ?? 0)) : null
    },
    persistence: journal,
    sqlite,
    switches,
    diagnostics,
    remoteReaders: unavailable('not yet implemented in this concurrency harness')
  }
  const status = evaluateStatus({ scenario, concurrency, tasks, runs, failures, switches,
    cleanupConfirmed: parts.cleanup?.cleanupConfirmed })
  return {
    measurementVersion: 2,
    // L1 attribution slice, not a user-visible SLO. Lanes stay separate so wall time is never
    // presented as CPU time.
    slice: 'p0-concurrency-attribution',
    scenario: scenario.name,
    prompt: scenario.prompt,
    // tasks and concurrency are different numbers on purpose: the same 16 task batch runs at 4 or 16 in
    // flight, so a wall-time difference is attributable to the limit and not to less work.
    workload: { concurrency, tasks, expected: scenario.expect, switches: scenario.switches,
      quietWindowMs: scenario.quietMs, seed: { turns: scenario.seedTurns, sections: scenario.seedSections } },
    status,
    identity,
    lanes,
    runs: runs.map(run => ({ runId: run.runId, prompt: run.prompt, externalSessionId: run.externalSessionId ?? null,
      startReceiptMs: run.startReceiptMs, firstOutputReceiptMs: run.firstOutputReceiptMs,
      startToTerminalMs: run.startToTerminalMs, queueWaitMs: run.queueWaitMs ?? null,
      startRequestedAtEpochMs: run.startRequestedAtEpochMs,
      startReplyAtEpochMs: run.startReplyAtEpochMs, terminalAtEpochMs: run.terminalAtEpochMs,
      traceEvents: run.traceEvents, traceMirrored: run.traceMirrored, settled: run.settled,
      terminalConfirmed: run.terminalConfirmed, archiveReadable: run.archiveReadable,
      diskVerified: run.diskVerified, evidence: run.evidence, evaluation: run.evaluation })),
    failures,
    switches: switches.blocked ?? [],
    sidebarSessions,
    processCleanup: cleanup,
    // Facts a reader must not have to infer from the numbers above.
    honesty: {
      paint: 'offscreen-hidden-window',
      offscreen: true,
      inputAttribution: 'run submission goes through the preload window.scry API, not synthetic OS input; the '
        + 'history-switch scenario drives the sidebar session row and the Overview pill/tab with real native pointer '
        + 'events, and only that scenario claims native input, proven by the switches lane (nativeClick receipt '
        + 'trusted + target matched, overviewVisible); App startup is not a native-input claim',
      memoryAttribution: 'RSS/working-set sums across processes are not exact physical memory; a max over periodic '
        + 'samples is not a continuous peak, and per-process peaks added together are not a simultaneous whole-App '
        + 'peak, so no peak and no post-GC residency is claimed beyond what a sample observed',
      gc: 'no GC is forced and no GC event is collected: post-collection residency is unavailable, not observed',
      providerProcess: 'unavailable (in-process offline fixture)',
      realProviderCost: 'not proven; this fixture exercises Scry paths only',
      rendererMirroring: 'main mirrors the focused run only',
      crossProcessClock: 'renderer boundaries use one clock; main windows are separate samples, never subtracted',
      commitLatency: RENDERER_COMMIT_UNAVAILABLE,
      childClose: 'stopOwnedApp returns before the child stdio drained; the harness awaits the close it '
        + 'subscribed to at spawn, so the log tail and the leftover inspect follow that event, and a missed '
        + 'close stays unknown instead of repeating the stop',
      archiveAuthority: 'durable turn archive plus the referenced app-trace content blob, re-read after process exit',
      phaseAttribution: 'main phases are aggregate-only; per-run boundaries are renderer samples',
      cpuAttribution: 'mainProcessCpu = main process + in-process smoke Provider from two boundary snapshots; rendererTask = CDP '
        + 'renderer main-thread task time; neither is Provider CPU and neither is React commit',
      gpuAttribution: 'the measured App runs hidden and offscreen with --disable-gpu; the GPU process CPU reported under '
        + 'that configuration is process CPU only, not hardware GPU utilisation and not the cost of a hardware-accelerated '
        + 'daily App, and no phase evidence attributes it to a specific renderer or CDP workload',
      processCpuAttribution: 'processCpu = app.getAppMetrics() cumulativeCPUUsage delta matched by pid + creationTime, for '
        + 'Electron-reported processes only, partial when any is new/gone/unidentified/missing/regressed; never added to '
        + 'mainProcessCpu or rendererTask',
      legacyWindowCpu: 'journal windows keep only memory, process counts and event-loop time; their percentCPUUsage is '
        + 'since-last-call, so per-window CPU percent is unavailable and no timestamp was rewritten',
      resourceWindowSampling: '[scry:resource] is sampled every 5000 ms, so a run shorter than one interval has no window; '
        + 'a window counts for a phase only when fully inside it, otherwise it is spanning',
      taskPoolPolicy: 'tasks is the fixed batch (one independent cwd and the same seed per task) and concurrency is the '
        + 'in-flight limit; what is fixed is the total background task and output work, not the renderer work of the '
        + 'intermediate frames. Only the last task is focused explicitly, but a production legacy start still auto-focuses '
        + 'itself, so earlier waves may have been foreground: mirrored runs, mirrored bytes and the final DOM are read from '
        + 'this report (rendererObservation, rendererMount) instead of assumed. queueWait measures waiting for a slot and is '
        + 'not accepted concurrency. This is a measurement fixture, not a product queue',
      observedConcurrency: 'requested overlap is dispatch->terminal (may include queueing before acceptance); acceptedActive '
        + 'overlap starts at the start reply and is only a lower bound; neither proves CPU-level parallelism or a native '
        + 'Provider process count',
      quietPhase: 'quiet is post-settlement idle after every run reached its terminal, not an idle Provider',
      rendererMountEvidence: 'transcript mounting is read from the real DOM after all runs settled; the renderer mirrors the focused run only',
      switchOrdering: scenario.switches === 0
        ? 'this scenario performs no history switch, so no sidebar ordering claim is made'
        : 'the history-switch scenario seeds a fixed pinned project order in the temp userData (real projects.json '
          + 'contract) so a session row cannot move between the geometry read and the native event; live unpinned '
          + 'project reordering is not proven by this result, and the other scenarios stay unpinned',
      historyStaging: scenario.switches === 0
        ? 'this scenario performs no history switch, so nothing waits for admission'
        : 'a history click changes the authorized cwd, so every task of the batch must first be admitted before the first '
          + 'click: the App returned a start reply for that cwd and its new session row is rendered, since a row alone is '
          + 'recorded before the run is registered (run-live-state.ts records pending state first). One bounded wait covers '
          + 'the whole batch, it is inside the active phase and counts in active time, the switches do not wait for '
          + 'terminals, and the wait is admission staging rather than input latency',
      overviewEvidence: 'each history switch must also show the Overview session tabpanel visibly open inside the right '
        + 'panel viewport; a zero-rect or hidden panel does not count',
      remoteReaders: 'not yet implemented in this concurrency harness; the remote trace host fixture exists but this harness does not use it',
      p0Scope: 'this result covers attribution for stream/quiet/big-output/history-switch only; renderer commit latency is unavailable and remote readers are not implemented, so neither is claimed'
    }
  }
}
