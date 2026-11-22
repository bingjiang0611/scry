import type { BackgroundServiceOrchestrationStatus } from '../shared/background-service'
import type { SubscribeReply, SubscribeRequest } from '../shared/orchestration-subscribe'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type { AppEvent } from '../main/remote/app-event-feed'
import type { AuthorityEngine } from '../host-runtime/orchestration/authority-engine'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { SubscribeEngine } from '../host-runtime/orchestration/subscribe-engine'
import { SubscribeHub } from '../host-runtime/orchestration/subscribe-hub'

export interface AuthoritySubscribeRuntimeDeps {
  hostId: () => string
  authorizePeer: (peer: string) => void
  grantScope: (peer: string) => 'local' | 'remote'
  attentionSnapshot?: () => SessionAttentionSnapshot
}

export function createAuthoritySubscribeHub(
  sink: EventSink,
  stateHints?: () => Array<{ kind: 'attention'; snapshot: SessionAttentionSnapshot }>
): SubscribeHub {
  const hub = new SubscribeHub(stateHints ? { stateHints } : {})
  sink.setCommitObserver((seq) => hub.notifyCommit(seq))
  return hub
}

export function createAuthoritySubscribeHandler(
  sink: EventSink,
  hub: SubscribeHub,
  deps: AuthoritySubscribeRuntimeDeps
): (peer: string, request: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeReply> {
  const engine = new SubscribeEngine({
    sink,
    hub,
    hostId: deps.hostId,
    authorizePeer: deps.authorizePeer,
    grantScope: deps.grantScope
  })
  return (peer, request, signal) => engine.subscribe(peer, request, signal)
}

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
  }
}

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
        nativeSessionId: marker.externalSessionId
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
  }
}

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
