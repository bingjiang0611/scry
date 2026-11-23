import type { BackgroundServiceOrchestrationStatus } from '../shared/background-service'
import type { SubscribeHint, SubscribeHistoryPage, SubscribeRequest, SubscribeResponse } from '../shared/orchestration-subscribe'
import type { DesktopHostRead, DesktopRemoteHistory } from '../shared/desktop-remote'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type { ProviderContext } from '../shared/provider'
import { isSessionProviderId } from '../main/app-store'
import { assembleByteChunks } from '../main/remote/desktop-byte-chunks'
import { isCanonicalRemoteProjectDirectory } from '../main/remote/remote-directory-browser'
import type { HostController } from '../main/remote/host-controller'
import type { RemoteHostService } from '../main/remote/remote-host-service'
import type { AuthorityEngine } from '../host-runtime/orchestration/authority-engine'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { SubscribeEngine, type SubscribeEngineOptions } from '../host-runtime/orchestration/subscribe-engine'
import type { SessionProjectionRow } from '../host-runtime/orchestration/types'
import { SubscribeHub } from '../host-runtime/orchestration/subscribe-hub'
import { paginateSubscribeReplies } from './orchestration-subscribe-chunks'
import { parseWorkspacePrepareProgress } from '../shared/workspace-selection-input'

export interface AuthoritySubscribeRuntimeDeps {
  hostId: () => string
  authorizePeer: (peer: string) => void
  grantScope: (peer: string) => 'local' | 'remote'
  attentionSnapshot?: () => SessionAttentionSnapshot
  readFirstPage?: SubscribeEngineOptions['readFirstPage']
  readRemoteFirstPage?: SubscribeEngineOptions['readRemoteFirstPage']
  remoteCwdAuthorizer?: SubscribeEngineOptions['remoteCwdAuthorizer']
  remoteHostNotices?: SubscribeEngineOptions['remoteHostNotices']
  runQuestions?: SubscribeEngineOptions['runQuestions']
  scans?: SubscribeEngineOptions['scans']
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
): (peer: string, request: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeResponse> {
  const engine = new SubscribeEngine({
    sink,
    hub,
    hostId: deps.hostId,
    authorizePeer: deps.authorizePeer,
    grantScope: deps.grantScope,
    readFirstPage: deps.readFirstPage,
    readRemoteFirstPage: deps.readRemoteFirstPage,
    remoteCwdAuthorizer: deps.remoteCwdAuthorizer,
    remoteHostNotices: deps.remoteHostNotices,
    runQuestions: deps.runQuestions,
    scans: deps.scans
  })
  return paginateSubscribeReplies(sink, deps, (peer, request, signal) => engine.subscribe(peer, request, signal))
}

export function authoritySubscribeDeps(
  service: () => RemoteHostService,
  roots: () => readonly string[]
): Pick<AuthoritySubscribeRuntimeDeps, 'hostId' | 'authorizePeer' | 'grantScope' | 'remoteCwdAuthorizer' | 'readRemoteFirstPage'> {
  const authorizedScope = (peer: string) => {
    const scope = service().authority.grantScope(peer)
    if (!scope) throw new Error('device_not_authorized')
    return scope
  }
  return {
    hostId: () => service().hostId,
    authorizePeer: (peer) => service().controller.authorizeDevicePeer(peer),
    grantScope: authorizedScope,
    remoteCwdAuthorizer: () => {
      const authorizedRoots = roots()
      return (cwd) => isCanonicalRemoteProjectDirectory(cwd, authorizedRoots)
    },
    readRemoteFirstPage: (peer, session, format, signal) => readRemoteDetailPage(service().controller, peer, session, format, signal)
  }
}

const invalidPage = (): never => { throw new Error('invalid_subscribe_history_page') }

// Use the profile-bound device history reader. The App history loader can
// change its selection, abort other local loads and hydrate local file URLs.
async function readRemoteDetailPage(
  controller: HostController,
  peer: string,
  session: SessionProjectionRow,
  format?: SubscribeRequest['historyFormat'],
  signal?: AbortSignal
): Promise<SubscribeHistoryPage | null> {
  const { conversationId, cwd, provider, profile, catalog, sessionKey } = session
  const externalSessionId = catalog ? catalog.nativeSessionId : sessionKey
  if (conversationId || !cwd || !isSessionProviderId(provider) || provider === 'legacy_unknown' || !externalSessionId) return null
  if (format === 'turns') {
    signal?.throwIfAborted()
    return { kind: 'mobileHistory', page: await controller.readHistoryTurnsPage(peer, {
      providerId: provider, cwd, externalSessionId, historyScope: 'session', agentProfileId: profile, limit: 3
    }) }
  }
  const query: Extract<DesktopHostRead, { kind: 'history' }> = {
    kind: 'history',
    historyScope: 'session',
    context: { providerId: provider, cwd, externalSessionId, ...(profile ? { agentProfileId: profile } : {}) },
    byteChunks: true,
    images: true
  }
  const read = (chunk?: { id: string; offset: number }) => {
    signal?.throwIfAborted()
    return controller.readDesktop(peer, { ...query, ...(chunk ? { chunk } : {}) })
  }
  const first = await read()
  const reply = first.kind === 'history_chunk'
    ? await assembleByteChunks(first, read, invalidPage)
    : first
  if (reply.kind !== 'history' || !reply.history || typeof reply.history !== 'object') return invalidPage()
  // Only the typed host history producer above supplies these chunks.
  return { kind: 'remoteHistory', history: reply.history as DesktopRemoteHistory }
}

export function createAuthorityDetailReader(
  historyChannels: Record<string, (event: unknown, ...args: never[]) => unknown>,
  readConversation: (id: string) => Promise<import('../shared/conversation-api').ConversationPage>
): NonNullable<SubscribeEngineOptions['readFirstPage']> {
  const load = historyChannels['agent:loadSession'] as
    (event: undefined, context: ProviderContext) => Promise<{ page: SubscribeHistoryPage } | null>
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
    } else if (marker.event === 'workspaceProgress') {
      const progress = parseWorkspacePrepareProgress(marker.progress)
      if (progress) hub.noteRunWorkspaceProgress(canonicalRunId, progress)
    }
  } catch {
  }
}

export type AppHint = Exclude<SubscribeHint, { kind: 'run' | 'window' }>
  | { kind: 'run'; runId: string }
  | { kind: 'window'; channel: string; payload: unknown }

export function forwardAppHintToSubscribeHub(
  hub: SubscribeHub,
  event: AppHint,
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
  if (event.kind === 'hostNotice') {
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
  }
}

export function buildAuthorityStatus(sink: EventSink): BackgroundServiceOrchestrationStatus {
  return { mode: 'on', writeIndeterminate: sink.isWriteIndeterminate() }
}
