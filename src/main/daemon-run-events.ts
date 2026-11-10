import type { AgentStopState } from '../shared/runtime'
import type { ActiveRun } from '../shared/trace'
import { sessionAttentionKey } from '../shared/session-attention'
import type { DockBadgeState } from './dock-badge'
import type { RunTraceRouter } from './run-trace-router'
import { DaemonEventPump } from './daemon-event-pump'
import { DaemonRunDiscovery } from './daemon-run-discovery'
import type { DaemonRunRuntime } from './daemon-run-runtime'
import type { DaemonRunTransport } from './daemon-run-transport'

// What the daemon changes outside any run read (P3f), wired to this window: one long
// poll on its own lane. Data notices reach the window as they did in process (E1); a
// run notice wakes that run (E2) and reveals one this window does not follow yet (E3);
// the daemon's unread set feeds this window's badge, which says what was viewed (E1b).

export interface DaemonRunEventsDeps {
  transport: Pick<DaemonRunTransport, 'appEvents' | 'liveRuns' | 'attentionViewed'>
  runtime: Pick<DaemonRunRuntime, 'wake' | 'wakeAll' | 'setWakesLive' | 'isTracking' | 'follow' | 'deliverAfterRead'>
  send: (channel: string, payload: unknown) => void
  dockBadge?: Pick<DockBadgeState, 'setDaemon' | 'bindDaemon' | 'forgetDaemon' | 'view'>
  // The run this window shows: its session, once known, is the one on screen.
  focusedRun?: () => Promise<ActiveRun | null>
  isWindowFocused?: () => boolean
  onWarn?: (message: string, detail?: unknown) => void
  waitMs?: number
  // W2: stop progress also goes to the run's own subscription, as in process.
  runTraces?: Pick<RunTraceRouter, 'publishStopState'>
}

export function startDaemonRunEvents(deps: DaemonRunEventsDeps): { dispose(): void } {
  const { transport, runtime, dockBadge } = deps
  const warn = deps.onWarn ? { onWarn: deps.onWarn } : {}
  const discovery = new DaemonRunDiscovery({
    liveRuns: () => transport.liveRuns({ waitMs: 0 }),
    isTracking: (runId) => runtime.isTracking(runId),
    follow: (input) => runtime.follow(input),
    ...warn
  })
  // In process, a focused run that learns its native session views it (run-session.ts),
  // so its reply never counts as unread while the user watches it. The daemon cannot
  // know what this window shows; the window says so here.
  const viewFocusedSession = (payload: Record<string, unknown>): void => {
    const { runId, sessionId } = payload
    if (!dockBadge || !deps.focusedRun || typeof runId !== 'string' || typeof sessionId !== 'string' || !sessionId) return
    void deps.focusedRun().then((run) => {
      if (!run || run.runId !== runId) return
      const providerId = typeof payload.providerId === 'string' ? payload.providerId : run.providerId
      if (!providerId) return
      const agentProfileId = typeof payload.agentProfileId === 'string' ? payload.agentProfileId : run.agentProfileId
      dockBadge.view(sessionAttentionKey({ providerId, agentProfileId, cwd: run.cwd ?? '', sessionId }), deps.isWindowFocused?.() ?? false)
    }).catch((error) => deps.onWarn?.('daemon focused session view failed', error))
  }
  const pump = new DaemonEventPump({
    source: transport, send: deps.send, ...warn, ...(deps.waitMs !== undefined ? { waitMs: deps.waitMs } : {}),
    onRun: (runId, intentSeq) => { runtime.wake(runId); discovery.notice(runId, intentSeq) },
    // Lost notices may include a new run's: look at the live list as well.
    onResync: () => { runtime.wakeAll(); discovery.resynchronize() },
    onLive: (live) => runtime.setWakesLive(live),
    onAttention: (snapshot) => dockBadge?.setDaemon(snapshot, deps.isWindowFocused?.() ?? false),
    // W1: the pipeline's own notices, each after the run text it follows.
    onWindow: (channel, payload) => runtime.deliverAfterRead(
      typeof payload.runId === 'string' ? payload.runId : undefined,
      () => {
        if (channel === 'agent:stopState') deps.runTraces?.publishStopState(payload as unknown as AgentStopState)
        deps.send(channel, payload)
        if (channel === 'agent:session') viewFocusedSession(payload)
      }
    )
  })
  // Viewing is idempotent: a lost report is repaired by the next snapshot and view.
  dockBadge?.bindDaemon((sessionKey) => {
    void transport.attentionViewed(sessionKey).catch((error) => deps.onWarn?.('daemon attention viewed failed', error))
  })
  pump.start()
  return { dispose: () => { pump.dispose(); dockBadge?.forgetDaemon() } }
}
