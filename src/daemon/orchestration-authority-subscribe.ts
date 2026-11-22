import type { BackgroundServiceOrchestrationStatus } from '../shared/background-service'
import type { SubscribeRequest, SubscribeResponse } from '../shared/orchestration-subscribe'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type { ProviderContext } from '../shared/provider'
import { isSessionProviderId } from '../main/app-store'
import type { AppEvent } from '../main/remote/app-event-feed'
import type { AuthorityEngine } from '../host-runtime/orchestration/authority-engine'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { SubscribeEngine, type SubscribeEngineOptions } from '../host-runtime/orchestration/subscribe-engine'
import { SubscribeHub } from '../host-runtime/orchestration/subscribe-hub'
import { paginateSubscribeReplies } from './orchestration-subscribe-chunks'

export interface AuthoritySubscribeRuntimeDeps {
  hostId: () => string
  authorizePeer: (peer: string) => void
  grantScope: (peer: string) => 'local' | 'remote'
  attentionSnapshot?: () => SessionAttentionSnapshot
  readFirstPage?: SubscribeEngineOptions['readFirstPage']
  scans?: SubscribeEngineOptions['scans']
}

/** Creates the volatile hint hub + commit wakeup binding for `SCRY_ORCHESTRATION=on`. */
export function createAuthoritySubscribeHub(
  sink: EventSink,
  stateHints?: () => Array<{ kind: 'attention'; snapshot: SessionAttentionSnapshot }>
): SubscribeHub {
  const hub = new SubscribeHub(stateHints ? { stateHints } : {})
  sink.setCommitObserver((seq) => hub.notifyCommit(seq))
  return hub
}

/** Builds the `LocalEndpointHandlers['subscribe']` function backed by `SubscribeEngine`. */
export function createAuthoritySubscribeHandler(
  sink: EventSink,
  hub: SubscribeHub,
  deps: AuthoritySubscribeRuntimeDeps
): (peer: string, request: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeResponse> {
  const engine = new SubscribeEngine({
    sink,
    hub,
    hostId: deps.hostId,
    authorizePeer: deps.authorizePeer,
    grantScope: deps.grantScope,
    readFirstPage: deps.readFirstPage,
    scans: deps.scans
  })
  return paginateSubscribeReplies(sink, deps, (peer, request, signal) => engine.subscribe(peer, request, signal))
}

/** Resolves history using the projected session identity. */
export function createAuthorityDetailReader(
  historyChannels: Record<string, (event: unknown, ...args: never[]) => unknown>,
  readConversation: (id: string) => Promise<import('../shared/conversation-api').ConversationPage>
): NonNullable<SubscribeEngineOptions['readFirstPage']> {
  const load = historyChannels['agent:loadSession'] as
    (event: undefined, context: ProviderContext) => Promise<{ page: import('../shared/orchestration-subscribe').SubscribeHistoryPage } | null>
  return async (session, signal) => {
    const { conversationId, provider, profile, cwd, sessionKey, catalog } = session
    signal?.throwIfAborted()
    if (conversationId && conversationId === sessionKey) {
      const page = await readConversation(conversationId)
      return page.summary.cwd === cwd ? { kind: 'conversation', page } : null
    }
    const externalSessionId = catalog ? catalog.nativeSessionId : sessionKey
    if (conversationId || cwd === null || !externalSessionId || !isSessionProviderId(provider) || provider === 'legacy_unknown') return null
    const loaded = await load(undefined, {
      providerId: provider,
      agentProfileId: profile ?? undefined,
      cwd,
      externalSessionId
    })
    return loaded?.page ?? null
  }
}

/** Updates in-memory live run binding/admission metadata in `SubscribeHub` without extra SQLite fsyncs. */
export function noteProgressMarkerForSubscribeHub(
  hub: SubscribeHub,
  canonicalRunId: string,
  detail: string
): void {
  try {
    const marker = JSON.parse(detail) as Record<string, unknown>
    if (marker.event === 'bound' && typeof marker.scryRunId === 'string') {
      hub.noteRunBound(canonicalRunId, {
        scryRunId: marker.scryRunId,
        ...(typeof marker.cwd === 'string' ? { cwd: marker.cwd } : {}),
        ...(typeof marker.providerId === 'string' ? { providerId: marker.providerId } : {}),
        ...(typeof marker.agentProfileId === 'string' ? { agentProfileId: marker.agentProfileId } : {})
      })
    } else if (marker.event === 'admitted') {
      hub.noteRunAdmitted(
        canonicalRunId,
        typeof marker.scryRunId === 'string' ? marker.scryRunId : undefined
      )
    } else if (marker.event === 'session' && typeof marker.externalSessionId === 'string') {
      hub.noteRunSession(canonicalRunId, marker.externalSessionId)
    }
  } catch {
    // Non-JSON progress markers do not affect subscribe metadata.
  }
}

/**
 * Forwards shrunk P4-3 volatile hints from `AppEventFeed` into `SubscribeHub` (`protocol §5.3`).
 * `hostAdmin` becomes `hostNotice` with exact W11 payload; `window` drops run-lifecycle notices
 * (`agent:turnDone`, `agent:session`, `agent:stopState`) that now arrive as durable run events.
 */
export function forwardAppEventToSubscribeHub(
  hub: SubscribeHub,
  event: AppEvent,
  resolveCanonical: (runId: string) => string
): void {
  if (event.kind === 'run') {
    hub.noteRunOutput(resolveCanonical(event.runId))
    return
  }
  if (event.kind === 'terminal') {
    hub.emitTerminal()
    return
  }
  if (event.kind === 'oauth') {
    hub.emitOAuth(event.url)
    return
  }
  if (event.kind === 'hostAdmin') {
    hub.emitHostNotice(event.notice)
    return
  }
  if (event.kind === 'attention') {
    hub.emitAttention(event.snapshot)
    return
  }
  if (event.kind === 'window') {
    hub.emitWindowNotice(event.channel, event.payload)
    return
  }
  if (event.kind === 'data') {
    hub.emitDataNotice(event.event)
  }
}

/** Routes H1 run_progress markers into both `SubscribeHub` (live meta) and `AuthorityEngine` (durable events). */
export function handleAuthorityRunProgress(
  engine: AuthorityEngine,
  hub: SubscribeHub,
  canonicalRunId: string,
  detail: string,
  suffix: string
): void {
  noteProgressMarkerForSubscribeHub(hub, canonicalRunId, detail)
  if (detail === 'output_capture_failed' || detail === 'history_capture_failed') {
    engine.recordProgress({ runId: canonicalRunId, step: 'content_gap', commandSuffix: suffix, reason: detail })
    return
  }
  try {
    const marker = JSON.parse(detail) as Record<string, unknown>
    if (marker.event === 'session' && typeof marker.externalSessionId === 'string') {
      engine.recordProgress({
        runId: canonicalRunId,
        step: 'session_bound',
        commandSuffix: suffix,
        nativeSessionId: marker.externalSessionId,
        attachNative: true,
        catalogRunId: hub.liveRunMeta(canonicalRunId)?.scryRunId
      })
    } else if (marker.event === 'question_opened' && typeof marker.questionId === 'string') {
      engine.recordProgress({
        runId: canonicalRunId,
        step: 'question_opened',
        commandSuffix: `${marker.questionId}-${suffix}`,
        questionId: marker.questionId,
        questionKind: typeof marker.kind === 'string' ? marker.kind : 'question'
      })
    } else if (marker.event === 'question_closed' && typeof marker.questionId === 'string') {
      engine.recordProgress({
        runId: canonicalRunId,
        step: 'question_closed',
        commandSuffix: `${marker.questionId}-${suffix}`,
        questionId: marker.questionId,
        ...(typeof marker.reason === 'string' ? { reason: marker.reason } : {})
      })
    }
  } catch {
    // Opaque non-JSON progress marker; no orchestration state change needed.
  }
}

/** Builds the authoritative orchestration status self-report (Decision H + W16 fenced reporting). */
export function buildAuthorityStatus(
  sink: EventSink,
  readH1FallbackStatus?: () => { unavailable: boolean; reason?: string }
): BackgroundServiceOrchestrationStatus {
  const fenced = sink.isWriteIndeterminate()
  const live = readH1FallbackStatus?.()
  if (fenced) {
    const reason = live?.unavailable && live.reason ? live.reason : 'orchestration_write_indeterminate'
    return { mode: 'on', writeIndeterminate: true, h1FallbackUnavailable: true, h1FallbackReason: reason }
  }
  if (live) {
    return {
      mode: 'on',
      writeIndeterminate: false,
      h1FallbackUnavailable: live.unavailable,
      ...(live.unavailable && live.reason ? { h1FallbackReason: live.reason } : {})
    }
  }
  const unavailable = sink.handle.db.open && sink.getMeta('h1_fallback_unavailable') === '1'
  const reason = unavailable ? sink.getMeta('h1_fallback_reason') : undefined
  return {
    mode: 'on',
    writeIndeterminate: false,
    h1FallbackUnavailable: unavailable,
    ...(unavailable && reason ? { h1FallbackReason: reason } : {})
  }
}
