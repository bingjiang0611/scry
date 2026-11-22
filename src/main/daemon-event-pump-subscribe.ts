import type { AgentDataUpdated } from '../shared/runtime'
import type { HostAdminNotice } from '../shared/host-admin'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type {
  SubscribeEventItem,
  SubscribeHint,
  SubscribeKnownCursor,
  SubscribeReply,
  SubscribeRequest,
  SubscribeSnapshot
} from '../shared/orchestration-subscribe'
import { DaemonRunError } from './daemon-run-transport'
import { KNOWN_SUBSCRIBE_EVENT_TYPES } from './daemon-subscribe-parse'

const RESYNCHRONIZE: AgentDataUpdated = { kind: 'resynchronize' }

export interface SubscribePumpDeps {
  subscribe: (input: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeReply>
  send: (channel: string, payload: unknown) => void
  waitMs: number
  retry: { initialMs: number; maxMs: number }
  sleep: (ms: number) => Promise<void>
  signal: AbortSignal
  detailFocus?: () => { sessionKey: string | null; signal: AbortSignal }
  onWarn?: (message: string, detail?: unknown) => void
  onSnapshot?: (snapshot: SubscribeSnapshot, meta: { isReset: boolean; logIdChanged: boolean }) => Promise<void> | void
  onSubscribeEvent?: (event: SubscribeEventItem) => Promise<void> | void
  onRunHint?: (hint: Extract<SubscribeHint, { kind: 'run' }>) => void
  onLogIdChanged?: (prevLogId: string, nextLogId: string) => void
  onResync?: () => void
  onAttention?: (snapshot: SessionAttentionSnapshot) => void
  onTerminal?: () => void
  onOAuth?: (url: string) => void
  onHostAdmin?: (notice: HostAdminNotice) => void
  onWindow?: (channel: string, payload: Record<string, unknown>) => Promise<void> | void
}

/**
 * P4-3 local `subscribe` loop for `DaemonEventPump` (active ONLY when daemon reports `subscribe: 1`).
 * Maintains the cursor while connected. A reconnect or changed event set opens a new snapshot.
 */
export async function runSubscribeLoop(deps: SubscribePumpDeps): Promise<void> {
  let known: SubscribeKnownCursor | undefined
  let lastLogId: string | undefined
  let pause = deps.retry.initialMs
  let missed = false
  let subscribedFocus: AbortSignal | undefined

  while (!deps.signal.aborted) {
    const focus = deps.detailFocus?.()
    const session = focus?.sessionKey ? { sessionKey: focus.sessionKey } : undefined
    let reply: SubscribeReply
    try {
      reply = await deps.subscribe(
        {
          views: session ? ['activeRuns', 'sessions', 'detail'] : ['activeRuns', 'sessions'],
          ...(session ? { session, detailWatch: focus?.signal === subscribedFocus && known ? 'continue' : 'open' } : {}),
          ...(known ? { known } : {}),
          waitMs: deps.waitMs,
          eventSet: 1
        },
        focus ? AbortSignal.any([deps.signal, focus.signal]) : deps.signal
      )
    } catch (error) {
      if (deps.signal.aborted) return
      if (focus?.signal.aborted) continue
      if (error instanceof DaemonRunError && error.reason === 'daemon_run_control_unavailable') {
        deps.onWarn?.('daemon subscribe unavailable', error)
        return
      }
      if (known !== undefined) {
        missed = true
        known = undefined
      }
      await deps.sleep(pause)
      pause = Math.min(pause * 2, deps.retry.maxMs)
      continue
    }

    if (deps.signal.aborted) return
    subscribedFocus = focus?.signal
    let unknownEvents = false
    pause = deps.retry.initialMs

    const logIdChanged = lastLogId !== undefined && lastLogId !== reply.logId
    if (logIdChanged) {
      deps.onLogIdChanged?.(lastLogId!, reply.logId)
    }
    lastLogId = reply.logId

    if (reply.mode === 'snapshot') {
      const isReset = known !== undefined || missed || logIdChanged
      await deps.onSnapshot?.(reply.snapshot, { isReset, logIdChanged })
      if (isReset) {
        deps.send('agent:dataUpdated', RESYNCHRONIZE)
        deps.onResync?.()
      }
      missed = false
    } else if (reply.mode === 'events') {
      const hasUnknown = reply.events.some((ev) => !KNOWN_SUBSCRIBE_EVENT_TYPES.has(ev.type))
      if (hasUnknown) {
        // protocol §5.2: unknown event type drops local cursor so next request pulls a full snapshot.
        // The reply's volatile hints (host notices, attention) are still delivered below.
        unknownEvents = true
        missed = true
      } else if (missed) {
        deps.send('agent:dataUpdated', RESYNCHRONIZE)
        deps.onResync?.()
        missed = false
      }
      // Apply volatile `run` binding/admission hints BEFORE events in the same reply so
      // a fast run that bound, admitted, and settled within one batch has its scryRunId
      // and admitted state populated before its terminal event finalizes the cursor.
      if (!unknownEvents) {
        if (reply.hints) {
          for (const hint of reply.hints) {
            if (hint.kind === 'run') deps.onRunHint?.(hint)
          }
        }
        for (const ev of reply.events) {
          await deps.onSubscribeEvent?.(ev)
        }
        if (reply.events.some((event) => event.type.startsWith('session.')) &&
            !reply.hints?.some((hint) => hint.kind === 'data')) {
          deps.send('agent:dataUpdated', { kind: 'catalog_recovered' })
        }
      }
    } else if (missed) {
      deps.send('agent:dataUpdated', RESYNCHRONIZE)
      deps.onResync?.()
      missed = false
    }

    if (reply.hints) {
      const skipRunHints = reply.mode === 'events' || unknownEvents
      for (const hint of reply.hints) {
        if (hint.kind === 'run') {
          if (!skipRunHints) deps.onRunHint?.(hint)
        } else if (hint.kind === 'terminal') deps.onTerminal?.()
        else if (hint.kind === 'oauth') deps.onOAuth?.(hint.url)
        else if (hint.kind === 'hostNotice') deps.onHostAdmin?.(hint.notice)
        else if (hint.kind === 'attention') deps.onAttention?.(hint.snapshot)
        else if (hint.kind === 'data') deps.send('agent:dataUpdated', hint.event)
        else if (hint.kind === 'window') {
          if (deps.onWindow) await deps.onWindow(hint.channel, hint.payload)
          else deps.send(hint.channel, hint.payload)
        }
      }
    }

    known = unknownEvents ? undefined : { hostId: reply.hostId, logId: reply.logId, seq: reply.seq }
  }
}
