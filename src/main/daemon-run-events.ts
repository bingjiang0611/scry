import type { DockBadgeState } from './dock-badge'
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
  runtime: Pick<DaemonRunRuntime, 'wake' | 'wakeAll' | 'setWakesLive' | 'isTracking' | 'follow'>
  send: (channel: string, payload: unknown) => void
  dockBadge?: Pick<DockBadgeState, 'setDaemon' | 'bindDaemon' | 'forgetDaemon'>
  isWindowFocused?: () => boolean
  onWarn?: (message: string, detail?: unknown) => void
  waitMs?: number
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
  const pump = new DaemonEventPump({
    source: transport, send: deps.send, ...warn, ...(deps.waitMs !== undefined ? { waitMs: deps.waitMs } : {}),
    onRun: (runId, intentSeq) => { runtime.wake(runId); discovery.notice(runId, intentSeq) },
    // Lost notices may include a new run's: look at the live list as well.
    onResync: () => { runtime.wakeAll(); discovery.resynchronize() },
    onLive: (live) => runtime.setWakesLive(live),
    onAttention: (snapshot) => dockBadge?.setDaemon(snapshot, deps.isWindowFocused?.() ?? false)
  })
  // Viewing is idempotent: a lost report is repaired by the next snapshot and view.
  dockBadge?.bindDaemon((sessionKey) => {
    void transport.attentionViewed(sessionKey).catch((error) => deps.onWarn?.('daemon attention viewed failed', error))
  })
  pump.start()
  return { dispose: () => { pump.dispose(); dockBadge?.forgetDaemon() } }
}
