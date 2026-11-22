import type { AgentStopState } from '../shared/runtime'
import type { HostAdminNotice } from '../shared/host-admin'
import type { ActiveRun } from '../shared/trace'
import { sessionAttentionKey } from '../shared/session-attention'
import type { DockBadgeState } from './dock-badge'
import type { RunTraceRouter } from './run-trace-router'
import { DaemonEventPump } from './daemon-event-pump'
import { DaemonTerminalReader } from './daemon-terminal-reader'
import { deliverDaemonOAuthUrl } from './bootstrap/mcp-daemon'
import type { DesktopTerminalEvents } from '../shared/desktop-workbench'
import type { DaemonRunRuntime } from './daemon-run-runtime'
import type { DaemonRunTransport } from './daemon-run-transport'

// What the daemon changes outside any run read (P3f), wired to this window: one long
// poll on its own lane. Data notices reach the window as they did in process (E1); a
// run notice wakes that run (E2) and reveals one this window does not follow yet (E3);
// the daemon's unread set feeds this window's badge, which says what was viewed (E1b).

export interface DaemonRunEventsDeps {
  transport: Pick<DaemonRunTransport, 'subscribe' | 'attentionViewed' | 'forward'>
  runtime: Pick<DaemonRunRuntime, 'deliverAfterRead'> &
    Partial<Pick<DaemonRunRuntime, 'applySubscribeSnapshot' | 'applySubscribeEvent' | 'applyRunHint' | 'setOnSessionBound'>>
  send: (channel: string, payload: unknown) => void
  onLogIdChanged?: (prevLogId: string, nextLogId: string) => void
  dockBadge?: Pick<DockBadgeState, 'setDaemon' | 'bindDaemon' | 'forgetDaemon' | 'view'>
  // The run this window shows: its session, once known, is the one on screen.
  focusedRun?: () => Promise<ActiveRun | null>
  isWindowFocused?: () => boolean
  onWarn?: (message: string, detail?: unknown) => void
  waitMs?: number
  // W2: stop progress also goes to the run's own subscription, as in process.
  runTraces?: Pick<RunTraceRouter, 'publishStopState'>
  // Whether the window can take terminal output now (P3-terminal.md).
  rendererCanReceive?: () => boolean
  // P5-7: host CLI admin notice to surface via system notification and open-devices click.
  onHostAdmin?: (notice: HostAdminNotice) => void
}

export function startDaemonRunEvents(deps: DaemonRunEventsDeps): { watchDetail(key: string | null): boolean; dispose(): void } {
  const { transport, runtime, dockBadge } = deps
  let watchedSession: string | null = null
  let watchAbort = new AbortController()
  const watchDetail = (key: string | null): boolean => {
    if (key !== watchedSession) {
      const previous = watchAbort
      watchedSession = key
      watchAbort = new AbortController()
      previous.abort()
    }
    return true
  }
  const warn = deps.onWarn ? { onWarn: deps.onWarn } : {}
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
  // Terminal output waits in the daemon's queue; a notice (or a resync, which may have
  // lost one) drains it onto the window's terminal channels.
  const terminals = new DaemonTerminalReader({
    read: async (cursor) => {
      const reply = await transport.forward({ op: 'terminalFeed', method: 'read', ...(cursor ? { cursor } : {}) }, true)
      const page = reply.terminal as DesktopTerminalEvents | undefined
      if (!page || typeof page.cursor !== 'string' || !Array.isArray(page.events)) throw new Error('invalid_daemon_response')
      return page
    },
    send: deps.send,
    canSend: deps.rendererCanReceive ?? (() => true),
    ...warn
  })
  runtime.setOnSessionBound?.(viewFocusedSession)
  const pump = new DaemonEventPump({
    source: transport, send: deps.send, ...warn, ...(deps.waitMs !== undefined ? { waitMs: deps.waitMs } : {}),
    detailFocus: () => ({ sessionKey: watchedSession, signal: watchAbort.signal }),
    onSnapshot: async (snapshot) => {
      if (snapshot.activeRuns) await runtime.applySubscribeSnapshot?.(snapshot.activeRuns.rows)
    },
    onSubscribeEvent: async (event) => {
      await runtime.applySubscribeEvent?.(event)
    },
    onRunHint: (hint) => { runtime.applyRunHint?.(hint) },
    ...(deps.onLogIdChanged ? { onLogIdChanged: deps.onLogIdChanged } : {}),
    onResync: () => { terminals.notice() },
    onTerminal: () => terminals.notice(),
    onOAuth: (url) => deliverDaemonOAuthUrl(url),
    ...(deps.onHostAdmin ? { onHostAdmin: deps.onHostAdmin } : {}),
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
  return { watchDetail, dispose: () => { runtime.setOnSessionBound?.(undefined); pump.dispose(); terminals.dispose(); dockBadge?.forgetDaemon() } }
}
