import type {
  SubscribeActiveRunRow,
  SubscribeEventItem,
  SubscribeHistoryPage,
  SubscribeReply,
  SubscribeRequest,
  SubscribeHint,
  SubscribeSessionRef,
  SubscribeSnapshot,
  SubscribeView
} from '../../shared/orchestration-subscribe'
import type { AgentQuestionRequest } from '../../shared/runtime'
import type { HostAdminNotice } from '../../shared/host-admin'
import type { EventSink } from './event-sink'
import type { CatalogSubscriptionScans } from './catalog-subscription-scans'
import { mapEventRow } from './event-sink-statements'
import { mapTurnRow } from './projection-mappers'
import type { SubscribeHub } from './subscribe-hub'
import { deviceEventPayload, deviceHintKey, deviceOutcome, deviceTurn } from './subscribe-device-fields'
import { readSubscribedRuns } from './subscribe-active-runs'
import { projectSubscribeSession, readSessionsSnapshot } from './subscribe-sessions'
import { ORCHESTRATION_EVENT_TYPES, PROMPT_PREVIEW_MAX_CHARS, type OrchestrationEventRow, type RunProjectionRow, type SessionProjectionRow } from './types'

export const SUBSCRIBE_MAX_WAIT_MS = 25_000
export const SUBSCRIBE_MAX_SCAN_GAP = 4_096
export const SUBSCRIBE_MAX_EVENTS = 128
export const SUBSCRIBE_MAX_EVENT_BYTES = 256 * 1024
const DEFAULT_SESSIONS_PAGE_SIZE = 200

const SESSION_VIEW_EVENTS = new Set([
  'session.created',
  'session.renamed',
  'session.pinned',
  'session.unpinned',
  'session.archived',
  'session.restored',
  'session.deleted',
  'session.withdrawn',
  'session.forked',
  'session.discovered',
  'session.imported',
  'turn.began',
  'turn.delivery',
  'run.intent_recorded',
  'run.settled',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'run.question_opened',
  'run.question_closed'
])

export interface SubscribeEngineOptions {
  sink: EventSink
  hub: SubscribeHub
  hostId: string | (() => string)
  authorizePeer: (peerCertSHA256: string) => void
  grantScope: (peerCertSHA256: string) => 'local' | 'remote'
  remoteCwdAuthorizer?: () => (canonicalCwd: string) => boolean
  remoteHostNotices?: () => HostAdminNotice[]
  readFirstPage?: (session: SessionProjectionRow, signal?: AbortSignal) => Promise<SubscribeHistoryPage | null>
  readRemoteFirstPage?: (peer: string, session: SessionProjectionRow, format?: SubscribeRequest['historyFormat'], signal?: AbortSignal) => Promise<SubscribeHistoryPage | null>
  runQuestions?: (runId: string) => AgentQuestionRequest[] | undefined
  scans?: CatalogSubscriptionScans
  sessionsPageSize?: number
  clock?: () => number
}

type SubscribeAccess = { scope: 'local' | 'remote'; canReadCwd: (cwd: string | null) => boolean }

function matchesViews(event: OrchestrationEventRow, views: ReadonlySet<SubscribeView>, detailSessionKey?: string): boolean {
  if (views.has('activeRuns') && event.type.startsWith('run.')) return true
  if (views.has('sessions') && SESSION_VIEW_EVENTS.has(event.type)) return true
  if (views.has('detail') && detailSessionKey && event.sessionKey === detailSessionKey) return true
  return false
}

/**
 * Orchestration-backed `subscribe` read engine (`P4-orchestration-protocol.md` §5.1–§5.5).
 * Reads `orch_event` + projection tables synchronously in one better-sqlite3 turn so
 * snapshot `seq` matches projection state atomically, and wakes immediately on commits.
 */
export class SubscribeEngine {
  readonly #sink: EventSink
  readonly #hub: SubscribeHub
  readonly #hostId: () => string
  readonly #authorizePeer: (peer: string) => void
  readonly #grantScope: (peer: string) => 'local' | 'remote'
  readonly #remoteCwdAuthorizer: NonNullable<SubscribeEngineOptions['remoteCwdAuthorizer']>
  readonly #remoteHostNotices?: () => HostAdminNotice[]
  readonly #readFirstPage: SubscribeEngineOptions['readFirstPage']
  readonly #readRemoteFirstPage: SubscribeEngineOptions['readRemoteFirstPage']
  readonly #runQuestions: SubscribeEngineOptions['runQuestions']
  readonly #scans: CatalogSubscriptionScans | undefined
  readonly #sessionsPageSize: number
  readonly #clock: () => number

  constructor(options: SubscribeEngineOptions) {
    this.#sink = options.sink
    this.#hub = options.hub
    this.#hostId = typeof options.hostId === 'function' ? options.hostId : () => options.hostId as string
    this.#authorizePeer = options.authorizePeer
    this.#grantScope = options.grantScope
    this.#remoteCwdAuthorizer = options.remoteCwdAuthorizer ?? (() => () => false)
    this.#remoteHostNotices = options.remoteHostNotices
    this.#readFirstPage = options.readFirstPage
    this.#readRemoteFirstPage = options.readRemoteFirstPage
    this.#runQuestions = options.runQuestions
    this.#scans = options.scans
    this.#sessionsPageSize = Math.max(1, Math.min(500, options.sessionsPageSize ?? DEFAULT_SESSIONS_PAGE_SIZE))
    this.#clock = options.clock ?? (() => Date.now())
  }

  #accessFor(peer: string): SubscribeAccess {
    this.#authorizePeer(peer)
    const scope = this.#grantScope(peer)
    if (scope === 'local') return { scope, canReadCwd: () => true }
    const allowed = this.#remoteCwdAuthorizer()
    return { scope, canReadCwd: (cwd) => !!cwd && allowed(cwd) }
  }

  async subscribe(peer: string, request: SubscribeRequest, signal?: AbortSignal): Promise<SubscribeReply> {
    let access = this.#accessFor(peer)
    const localRead = access.scope === 'local'
    if (localRead) this.#hub.beginRead()
    let detachCatalog: (() => void) | undefined
    let detachDetail: (() => void) | undefined
    try {
      const waitMs = Math.min(Math.max(0, request.waitMs), SUBSCRIBE_MAX_WAIT_MS)
      const deadline = this.#clock() + waitMs
      const views = new Set<SubscribeView>(request.views)
      const hintPeer = access.scope === 'remote' ? deviceHintKey(peer, request) : peer
      const readsHints = !request.historyOnly && (access.scope === 'local' || views.has('activeRuns') || views.has('detail'))
      if (this.#scans && (views.has('sessions') || views.has('detail'))) {
        const opening = !request.known || request.known.hostId !== this.#hostId() ||
          request.known.logId !== this.#sink.getMeta('log_id')
        if (views.has('sessions')) detachCatalog = this.#scans.sessions(opening && !request.sessionsCursor)
        if (views.has('detail') && request.session && this.#detailSession(access, request.session)) {
          detachDetail = this.#scans.detail(request.session.sessionKey, opening || (access.scope === 'local' && request.detailWatch === 'open'))
        }
      }

      for (;;) {
        const reply = this.#evaluateOnce(hintPeer, access, views, request)
        if (reply.mode === 'snapshot' && request.session && reply.snapshot.detail &&
            (access.scope === 'local' ? this.#readFirstPage : this.#readRemoteFirstPage)) {
          const session = this.#detailSession(access, request.session)
          if (!session) return reply
          const firstPage = access.scope === 'local' ? await this.#readFirstPage!(session, signal)
            : await this.#readRemoteFirstPage!(peer, session, request.historyFormat, signal)
          signal?.throwIfAborted()
          const currentAccess = this.#accessFor(peer)
          const current = this.#detailSession(currentAccess, request.session)
          if (currentAccess.scope !== access.scope || !current || current.cwd !== session.cwd ||
              current.provider !== session.provider || current.profile !== session.profile ||
              current.catalog?.nativeSessionId !== session.catalog?.nativeSessionId) {
            return this.#evaluateOnce(hintPeer, currentAccess, views, { ...request, known: undefined })
          }
          if (firstPage) reply.snapshot.detail.firstPage = firstPage
          return reply
        }
        if (reply.mode !== 'idle' || (reply.hints && reply.hints.length > 0)) return reply

        const remaining = deadline - this.#clock()
        if (remaining <= 0 || this.#hub.closed || signal?.aborted) return reply

        const observedCommit = this.#hub.commitSeq
        if ((!readsHints || !this.#hub.hasPendingHints(hintPeer)) && observedCommit <= reply.seq) {
          await this.#hub.waitForWake(remaining, signal)
        }
        if (this.#hub.closed || signal?.aborted) {
          return this.#evaluateOnce(hintPeer, this.#accessFor(peer), views, request)
        }
        access = this.#accessFor(peer)
      }
    } finally {
      detachCatalog?.()
      detachDetail?.()
      if (localRead) this.#hub.endRead()
    }
  }

  #evaluateOnce(
    peer: string,
    access: SubscribeAccess,
    views: ReadonlySet<SubscribeView>,
    request: SubscribeRequest
  ): SubscribeReply {
    const db = this.#sink.handle.db
    const hostId = this.#hostId()
    const logId = this.#sink.getMeta('log_id') ?? ''
    const prunedThrough = Number(this.#sink.getMeta('pruned_through') ?? '0')
    const currentSeq = Number(
      (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM orch_event').get() as { seq: number }).seq
    )

    const known = request.known
    const mustSnapshot =
      !known ||
      Boolean(request.sessionsCursor) ||
      known.hostId !== hostId ||
      known.logId !== logId ||
      known.seq > currentSeq ||
      known.seq < prunedThrough ||
      currentSeq - known.seq > SUBSCRIBE_MAX_SCAN_GAP

    if (mustSnapshot) {
      return this.#buildSnapshotReply(peer, access, views, request, hostId, logId, currentSeq)
    }

    const eventSet = request.eventSet ?? 1
    if (currentSeq > known.seq) {
      const scan = this.#scanIncrementalEvents(access, views, request, known.seq, currentSeq, eventSet)
      if (scan.overflow) {
        return this.#buildSnapshotReply(peer, access, views, request, hostId, logId, currentSeq)
      }
      const hints = this.#drainHints(peer, access, views, request, false)
      if (scan.events.length > 0) {
        return {
          hostId,
          logId,
          seq: scan.scannedSeq,
          mode: 'events',
          events: scan.events,
          ...(hints.length > 0 ? { hints } : {})
        }
      }
      return {
        hostId,
        logId,
        seq: scan.scannedSeq,
        mode: 'idle',
        ...(hints.length > 0 ? { hints } : {})
      }
    }

    const hints = this.#drainHints(peer, access, views, request, false)
    return {
      hostId,
      logId,
      seq: currentSeq,
      mode: 'idle',
      ...(hints.length > 0 ? { hints } : {})
    }
  }

  #scanIncrementalEvents(
    access: SubscribeAccess,
    views: ReadonlySet<SubscribeView>,
    request: SubscribeRequest,
    afterSeq: number,
    upToSeq: number,
    eventSet: number
  ): { overflow: boolean; events: SubscribeEventItem[]; scannedSeq: number } {
    const db = this.#sink.handle.db
    const rows = db
      .prepare('SELECT * FROM orch_event WHERE seq > ? AND seq <= ? ORDER BY seq ASC')
      .all(afterSeq, upToSeq) as Array<Record<string, unknown>>

    const events: SubscribeEventItem[] = []
    let bytes = 0
    let scannedSeq = upToSeq
    const detailRef = request.session
    const detailSessionKey = detailRef && (
      access.scope === 'local' || !this.#sink.getSession(detailRef.sessionKey) || this.#detailSession(access, detailRef)
    ) ? detailRef.sessionKey : undefined

    for (const raw of rows) {
      const event = mapEventRow(raw)
      if (eventSet <= 1 && !ORCHESTRATION_EVENT_TYPES.has(event.type)) continue
      if (!access.canReadCwd(event.cwd)) continue
      if (!matchesViews(event, views, detailSessionKey)) continue

      const item: SubscribeEventItem = {
        seq: event.seq,
        type: event.type,
        stream: event.stream,
        at: event.at,
        ...(event.sessionKey !== null ? { sessionKey: event.sessionKey } : {}),
        ...(event.runId !== null ? { runId: event.runId } : {}),
        ...(event.cwd !== null ? { cwd: event.cwd } : {}),
        payload: access.scope === 'local' ? event.payload : deviceEventPayload(event.payload, access.canReadCwd),
        ...(access.scope === 'remote' ? this.#deviceProjections(access, views, event)
          : event.type.startsWith('run.question_') && event.runId
            ? this.#localQuestionProjection(access, event.runId) : {}),
        ...(access.scope === 'local' && event.evidence !== null ? { evidence: event.evidence } : {})
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
      if (events.length >= SUBSCRIBE_MAX_EVENTS || bytes + itemBytes > SUBSCRIBE_MAX_EVENT_BYTES) {
        return { overflow: true, events: [], scannedSeq: event.seq }
      }
      events.push(item)
      bytes += itemBytes
      scannedSeq = upToSeq
    }

    return { overflow: false, events, scannedSeq }
  }

  #buildSnapshotReply(
    peer: string,
    access: SubscribeAccess,
    views: ReadonlySet<SubscribeView>,
    request: SubscribeRequest,
    hostId: string,
    logId: string,
    currentSeq: number
  ): SubscribeReply {
    const snapshot: SubscribeSnapshot = {}
    if (views.has('sessions')) {
      snapshot.sessions = readSessionsSnapshot(this.#sink.handle.db, access.canReadCwd, access.scope, this.#sessionsPageSize, request.sessionsCursor)
    }
    if (views.has('activeRuns')) {
      const tracked = access.scope === 'local' ? request.trackedRunIds : undefined
      const rows = readSubscribedRuns(this.#sink, this.#clock(), tracked)
        .filter(run => access.canReadCwd(run.cwd))
        .map(run => this.#projectRun(run, access, Boolean(tracked)))
      snapshot.activeRuns = { rows }
    }
    if (views.has('detail') && request.session && !(access.scope === 'local' && request.detailWatch)) {
      snapshot.detail = this.#readDetailSnapshot(access, this.#detailSession(access, request.session))
    }
    const hints = request.sessionsCursor || request.trackedRunIds ? [] : this.#drainHints(peer, access, views, request, true, !request.known)
    return {
      hostId,
      logId,
      seq: currentSeq,
      mode: 'snapshot',
      snapshot,
      ...(hints.length > 0 ? { hints } : {})
    }
  }

  #projectRun(run: RunProjectionRow, access: SubscribeAccess, tracked = false): SubscribeActiveRunRow {
    const liveMeta = this.#hub.liveRunMeta(run.runId)
    const localMeta = access.scope === 'local' ? liveMeta : undefined
    const recoveredAppRunId = tracked && access.scope === 'local' ? run.appRunId : undefined
    const appRunId = localMeta?.scryRunId ?? recoveredAppRunId
    const session = run.sessionKey && (access.scope === 'remote' || (recoveredAppRunId && !liveMeta?.externalSessionId))
      ? this.#sink.getSession(run.sessionKey) : undefined
    const externalSessionId = liveMeta?.externalSessionId ??
      (session && access.canReadCwd(session.cwd) ? session.catalog?.nativeSessionId : undefined)
    const questions = liveMeta?.scryRunId ? this.#runQuestions?.(liveMeta.scryRunId)?.filter(request =>
      this.#sink.getInteraction(run.runId, request.questionId)?.state === 'open') : undefined
    const conversation = access.scope === 'local' && questions?.length && run.sessionKey ? this.#sink.getSession(run.sessionKey)?.conversationId : undefined
    const promptPreview =
      access.scope === 'remote' && run.promptPreview
        ? run.promptPreview.slice(0, PROMPT_PREVIEW_MAX_CHARS)
        : run.promptPreview
    return {
      runId: run.runId,
      ...(appRunId ? { scryRunId: appRunId } : {}),
      ...(access.scope === 'remote' && liveMeta?.scryRunId ? { traceRunId: liveMeta.scryRunId } : {}),
      ...(questions?.length ? { questions } : {}),
      ...(conversation ? { isConversationRun: true } : {}),
      ...(localMeta?.admitted || recoveredAppRunId ? { admitted: true } : {}),
      ...(externalSessionId ? { externalSessionId } : {}),
      sessionKey: run.sessionKey,
      scope: run.scope,
      origin: run.origin,
      provider: run.provider,
      profile: run.profile,
      cwd: run.cwd,
      promptPreview,
      lifecycle: run.lifecycle,
      stopState: run.stopState,
      outputSeq: liveMeta ? Math.max(liveMeta.outputSeq, run.outputSeq ?? 0) : run.outputSeq,
      intentSeq: run.intentSeq,
      settledAt: run.settledAt,
      recoveredAt: run.recoveredAt,
      outcome: access.scope === 'remote' ? deviceOutcome(run.outcome) : run.outcome,
      revSeq: run.revSeq
    }
  }

  #localQuestionProjection(access: SubscribeAccess, runId: string): { runRow?: SubscribeActiveRunRow } {
    const run = this.#sink.getRun(runId)
    return run ? { runRow: this.#projectRun(run, access) } : {}
  }

  #deviceProjections(
    access: SubscribeAccess, views: ReadonlySet<SubscribeView>, event: OrchestrationEventRow
  ): Pick<SubscribeEventItem, 'sessionRow' | 'runRow'> {
    const result: Pick<SubscribeEventItem, 'sessionRow' | 'runRow'> = {}
    if (views.has('sessions') && event.sessionKey) {
      const session = this.#sink.getSession(event.sessionKey)
      if (session && access.canReadCwd(session.cwd)) {
        result.sessionRow = projectSubscribeSession(session, access.canReadCwd, access.scope)
      } else if (event.type === 'session.deleted' || event.type === 'session.withdrawn') {
        result.sessionRow = null
      }
    }
    if ((views.has('activeRuns') || views.has('detail')) && event.runId) {
      const run = this.#sink.getRun(event.runId)
      if (run && access.canReadCwd(run.cwd)) result.runRow = this.#projectRun(run, access)
    }
    return result
  }

  #detailSession(access: SubscribeAccess, ref: SubscribeSessionRef): SessionProjectionRow | undefined {
    const session = this.#sink.getSession(ref.sessionKey)
    if (!session || !access.canReadCwd(session.cwd)) return undefined
    if ((ref.cwd !== undefined && ref.cwd !== session.cwd) ||
        (ref.providerId !== undefined && ref.providerId !== session.provider) ||
        (ref.agentProfileId !== undefined && ref.agentProfileId !== session.profile) ||
        (ref.externalSessionId !== undefined && ref.externalSessionId !== (session.catalog ? session.catalog.nativeSessionId : session.sessionKey))) {
      return undefined
    }
    return session
  }

  #readDetailSnapshot(access: SubscribeAccess, session: SessionProjectionRow | undefined): NonNullable<SubscribeSnapshot['detail']> {
    if (!session) return { turns: [] }
    const db = this.#sink.handle.db
    const rows = db
      .prepare('SELECT * FROM orch_p_turn WHERE session_key = ? ORDER BY ordinal ASC')
      .all(session.sessionKey) as Array<Record<string, unknown>>
    const turns = rows.map(raw => {
      const turn = mapTurnRow(raw)
      return access.scope === 'local' ? turn : deviceTurn(turn)
    })
    return {
      turns,
      ...(session.legacy ? { legacyBefore: true as const } : {})
    }
  }

  #drainHints(
    peer: string, access: SubscribeAccess, views: ReadonlySet<SubscribeView>,
    request: SubscribeRequest, state: boolean, fresh?: boolean
  ): SubscribeHint[] {
    if (request.historyOnly || (access.scope === 'remote' && !views.has('activeRuns') && !views.has('detail'))) return []
    const pending = this.#hub.drainHints(peer, state && access.scope === 'local', fresh)
    if (access.scope === 'local') return pending
    const hints: SubscribeHint[] = []
    const detail = views.has('detail')
    if (state && !detail) {
      for (const notice of this.#remoteHostNotices?.() ?? []) hints.push({ kind: 'hostNotice', notice })
    }
    const detailSession = detail && request.session && this.#detailSession(access, request.session)
    for (const hint of pending) {
      if (hint.kind === 'hostNotice' && !state && !detail && this.#remoteHostNotices) hints.push(hint)
      if (hint.kind === 'run') {
        const run = this.#sink.getRun(hint.runId)
        if (run && access.canReadCwd(run.cwd) && (!detail || (detailSession && run.sessionKey === detailSession.sessionKey))) {
          hints.push({ kind: 'run', runId: hint.runId, outputSeq: hint.outputSeq,
            ...(hint.scryRunId ? { traceRunId: hint.scryRunId } : {})
          })
        }
      }
    }
    return hints
  }

}
