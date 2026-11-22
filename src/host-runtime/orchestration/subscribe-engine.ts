import type {
  SubscribeActiveRunRow,
  SubscribeEventItem,
  SubscribeHistoryPage,
  SubscribeReply,
  SubscribeRequest,
  SubscribeSessionRow,
  SubscribeSessionRef,
  SubscribeSnapshot,
  SubscribeView
} from '../../shared/orchestration-subscribe'
import type { EventSink } from './event-sink'
import type { CatalogSubscriptionScans } from './catalog-subscription-scans'
import { mapEventRow } from './event-sink-statements'
import { mapRunRow, mapSessionRow, mapTurnRow } from './projection-mappers'
import type { SubscribeHub } from './subscribe-hub'
import { ORCHESTRATION_EVENT_TYPES, PROMPT_PREVIEW_MAX_CHARS, type OrchestrationEventRow, type SessionProjectionRow } from './types'

export const SUBSCRIBE_MAX_WAIT_MS = 25_000
export const SUBSCRIBE_MAX_SCAN_GAP = 4_096
export const SUBSCRIBE_MAX_EVENTS = 128
export const SUBSCRIBE_MAX_EVENT_BYTES = 256 * 1024
export const SUBSCRIBE_ACTIVE_RUN_RETENTION_MS = 24 * 60 * 60 * 1000
export const SUBSCRIBE_TERMINAL_RUN_SNAPSHOT_LIMIT = 256
const DEFAULT_SESSIONS_PAGE_SIZE = 200

const SESSION_VIEW_EVENTS = new Set([
  'session.created',
  'session.renamed',
  'session.pinned',
  'session.unpinned',
  'session.archived',
  'session.restored',
  'session.deleted',
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
  isRemoteCwdAuthorized?: (canonicalCwd: string) => boolean
  readFirstPage?: (session: SessionProjectionRow, signal?: AbortSignal) => Promise<SubscribeHistoryPage | null>
  scans?: CatalogSubscriptionScans
  sessionsPageSize?: number
  clock?: () => number
}

interface SessionsKeysetCursor {
  archivedAt: number | null
  ts: number
  sessionKey: string
}

function encodeSessionsCursor(cursor: SessionsKeysetCursor): string {
  return Buffer.from(JSON.stringify([cursor.archivedAt, cursor.ts, cursor.sessionKey]), 'utf8').toString('base64url')
}

function decodeSessionsCursor(raw: string): SessionsKeysetCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined
    const [archivedAt, ts, sessionKey] = parsed
    if ((archivedAt !== null && !Number.isSafeInteger(archivedAt)) || !Number.isSafeInteger(ts) || typeof sessionKey !== 'string') {
      return undefined
    }
    return { archivedAt: archivedAt as number | null, ts: ts as number, sessionKey }
  } catch {
    return undefined
  }
}

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
  readonly #isRemoteCwdAuthorized: (cwd: string) => boolean
  readonly #readFirstPage: SubscribeEngineOptions['readFirstPage']
  readonly #scans: CatalogSubscriptionScans | undefined
  readonly #sessionsPageSize: number
  readonly #clock: () => number

  constructor(options: SubscribeEngineOptions) {
    this.#sink = options.sink
    this.#hub = options.hub
    this.#hostId = typeof options.hostId === 'function' ? options.hostId : () => options.hostId as string
    this.#authorizePeer = options.authorizePeer
    this.#grantScope = options.grantScope
    this.#isRemoteCwdAuthorized = options.isRemoteCwdAuthorized ?? (() => false)
    this.#readFirstPage = options.readFirstPage
    this.#scans = options.scans
    this.#sessionsPageSize = Math.max(1, Math.min(500, options.sessionsPageSize ?? DEFAULT_SESSIONS_PAGE_SIZE))
    this.#clock = options.clock ?? (() => Date.now())
  }

  async subscribe(peer: string, request: SubscribeRequest, signal?: AbortSignal): Promise<SubscribeReply> {
    this.#hub.beginRead()
    let detachCatalog: (() => void) | undefined
    let detachDetail: (() => void) | undefined
    try {
      const waitMs = Math.min(Math.max(0, request.waitMs), SUBSCRIBE_MAX_WAIT_MS)
      const deadline = this.#clock() + waitMs
      const views = new Set<SubscribeView>(request.views)
      if (this.#scans && (views.has('sessions') || views.has('detail'))) {
        this.#authorizePeer(peer)
        const opening = !request.known || request.known.hostId !== this.#hostId() ||
          request.known.logId !== this.#sink.getMeta('log_id')
        if (views.has('sessions')) detachCatalog = this.#scans.sessions(opening && !request.sessionsCursor)
        const scope = this.#grantScope(peer)
        if (views.has('detail') && request.session && this.#detailSession(scope, request.session)) {
          detachDetail = this.#scans.detail(request.session.sessionKey, opening || (scope === 'local' && request.detailWatch === 'open'))
        }
      }

      for (;;) {
        this.#authorizePeer(peer)
        const scope = this.#grantScope(peer)
        const reply = this.#evaluateOnce(peer, scope, views, request)
        if (reply.mode === 'snapshot' && request.session && reply.snapshot.detail && this.#readFirstPage) {
          const session = this.#detailSession(scope, request.session)
          if (!session) return reply
          const firstPage = await this.#readFirstPage(session, signal)
          signal?.throwIfAborted()
          this.#authorizePeer(peer)
          const currentScope = this.#grantScope(peer)
          const current = this.#detailSession(currentScope, request.session)
          if (currentScope !== scope || !current || current.cwd !== session.cwd ||
              current.provider !== session.provider || current.profile !== session.profile ||
              current.catalog?.nativeSessionId !== session.catalog?.nativeSessionId) {
            return this.#evaluateOnce(peer, currentScope, views, { ...request, known: undefined })
          }
          if (firstPage) reply.snapshot.detail.firstPage = firstPage
          return reply
        }
        if (reply.mode !== 'idle' || (reply.hints && reply.hints.length > 0)) return reply

        const remaining = deadline - this.#clock()
        if (remaining <= 0 || this.#hub.closed || signal?.aborted) return reply

        const observedCommit = this.#hub.commitSeq
        if (!this.#hub.hasPendingHints(peer) && observedCommit <= reply.seq) {
          await this.#hub.waitForWake(remaining, signal)
        }
        if (this.#hub.closed || signal?.aborted) {
          this.#authorizePeer(peer)
          return this.#evaluateOnce(peer, this.#grantScope(peer), views, request)
        }
      }
    } finally {
      detachCatalog?.()
      detachDetail?.()
      this.#hub.endRead()
    }
  }

  #evaluateOnce(
    peer: string,
    scope: 'local' | 'remote',
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
      return this.#buildSnapshotReply(peer, scope, views, request, hostId, logId, currentSeq)
    }

    const eventSet = request.eventSet ?? 1
    if (currentSeq > known.seq) {
      const scan = this.#scanIncrementalEvents(scope, views, request, known.seq, currentSeq, eventSet)
      if (scan.overflow) {
        return this.#buildSnapshotReply(peer, scope, views, request, hostId, logId, currentSeq)
      }
      const hints = this.#hub.drainHints(peer, false)
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

    const hints = this.#hub.drainHints(peer, false)
    return {
      hostId,
      logId,
      seq: currentSeq,
      mode: 'idle',
      ...(hints.length > 0 ? { hints } : {})
    }
  }

  #scanIncrementalEvents(
    scope: 'local' | 'remote',
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
    const detailSessionKey = request.session?.sessionKey

    for (const raw of rows) {
      const event = mapEventRow(raw)
      if (eventSet <= 1 && !ORCHESTRATION_EVENT_TYPES.has(event.type)) continue
      if (!this.#isEventVisible(scope, event)) continue
      if (!matchesViews(event, views, detailSessionKey)) continue

      const item: SubscribeEventItem = {
        seq: event.seq,
        type: event.type,
        stream: event.stream,
        at: event.at,
        ...(event.sessionKey !== null ? { sessionKey: event.sessionKey } : {}),
        ...(event.runId !== null ? { runId: event.runId } : {}),
        ...(event.cwd !== null ? { cwd: event.cwd } : {}),
        payload: this.#projectEventPayload(scope, event),
        ...(event.evidence !== null ? { evidence: event.evidence } : {})
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
    scope: 'local' | 'remote',
    views: ReadonlySet<SubscribeView>,
    request: SubscribeRequest,
    hostId: string,
    logId: string,
    currentSeq: number
  ): SubscribeReply {
    const snapshot: SubscribeSnapshot = {}
    if (views.has('sessions')) {
      snapshot.sessions = this.#readSessionsSnapshot(scope, request.sessionsCursor)
    }
    if (views.has('activeRuns')) {
      snapshot.activeRuns = { rows: this.#readActiveRunsSnapshot(scope) }
    }
    if (views.has('detail') && request.session && !(scope === 'local' && request.detailWatch)) {
      snapshot.detail = this.#readDetailSnapshot(this.#detailSession(scope, request.session))
    }
    const hints = this.#hub.drainHints(peer, true, !request.known)
    return {
      hostId,
      logId,
      seq: currentSeq,
      mode: 'snapshot',
      snapshot,
      ...(hints.length > 0 ? { hints } : {})
    }
  }

  #readSessionsSnapshot(
    scope: 'local' | 'remote',
    cursorToken?: string
  ): NonNullable<SubscribeSnapshot['sessions']> {
    const db = this.#sink.handle.db
    const cursor = cursorToken ? decodeSessionsCursor(cursorToken) : undefined
    const allRows = (
      cursor
        ? cursor.archivedAt === null
          ? db
              .prepare(
                `SELECT * FROM orch_p_session
                 WHERE (archived_at IS NULL AND (ts < ? OR (ts = ? AND session_key > ?)))
                    OR archived_at IS NOT NULL
                 ORDER BY archived_at ASC, ts DESC, session_key ASC`
              )
              .all(cursor.ts, cursor.ts, cursor.sessionKey)
          : db
              .prepare(
                `SELECT * FROM orch_p_session
                 WHERE archived_at > ?
                    OR (archived_at = ? AND (ts < ? OR (ts = ? AND session_key > ?)))
                 ORDER BY archived_at ASC, ts DESC, session_key ASC`
              )
              .all(cursor.archivedAt, cursor.archivedAt, cursor.ts, cursor.ts, cursor.sessionKey)
        : scope === 'local'
          ? db
              .prepare('SELECT * FROM orch_p_session ORDER BY archived_at ASC, ts DESC, session_key ASC LIMIT ?')
              .all(this.#sessionsPageSize + 1)
          : db
              .prepare('SELECT * FROM orch_p_session ORDER BY archived_at ASC, ts DESC, session_key ASC')
              .all()
    ) as Array<Record<string, unknown>>

    const visible: SubscribeSessionRow[] = []
    let hasMore = false
    for (const raw of allRows) {
      const mapped = mapSessionRow(raw)
      if (!this.#isCwdVisible(scope, mapped.cwd)) continue
      if (visible.length >= this.#sessionsPageSize) {
        hasMore = true
        break
      }
      visible.push({
        sessionKey: mapped.sessionKey,
        conversationId: mapped.conversationId,
        provider: mapped.provider,
        profile: mapped.profile,
        cwd: mapped.cwd,
        title: mapped.title,
        ts: mapped.ts,
        pinnedAt: mapped.pinnedAt,
        archivedAt: mapped.archivedAt,
        lastRunId: mapped.lastRunId,
        lastRunOutcome: mapped.lastRunOutcome,
        activeRunId: mapped.activeRunId,
        pendingQuestions: mapped.pendingQuestions,
        legacy: mapped.legacy,
        revSeq: mapped.revSeq,
        ...(mapped.catalog ? { catalog: mapped.catalog } : {})
      })
    }

    let total: number | 'unavailable' = 'unavailable'
    if (scope === 'local') {
      total = Number((db.prepare('SELECT COUNT(*) AS c FROM orch_p_session').get() as { c: number }).c)
    } else {
      const cwds = db.prepare('SELECT cwd FROM orch_p_session').all() as Array<{ cwd: string | null }>
      total = cwds.filter((row) => this.#isCwdVisible('remote', row.cwd)).length
    }

    const last = visible[visible.length - 1]
    const nextCursor =
      hasMore && last
        ? encodeSessionsCursor({ archivedAt: last.archivedAt, ts: last.ts, sessionKey: last.sessionKey })
        : undefined
    return { rows: visible, total, ...(nextCursor ? { nextCursor } : {}) }
  }

  #readActiveRunsSnapshot(scope: 'local' | 'remote'): SubscribeActiveRunRow[] {
    const db = this.#sink.handle.db
    const cutoff = this.#clock() - SUBSCRIBE_ACTIVE_RUN_RETENTION_MS
    // Every non-terminal run is always included (a live run must never be pushed out
    // of the snapshot by recent terminal ones); only the 24 h terminal tail is capped.
    const live = db
      .prepare(
        `SELECT * FROM orch_p_run
         WHERE lifecycle IN ('recorded', 'admitted', 'dispatched')
         ORDER BY intent_seq DESC`
      )
      .all() as Array<Record<string, unknown>>
    const recentTerminal = db
      .prepare(
        `SELECT * FROM orch_p_run
         WHERE lifecycle NOT IN ('recorded', 'admitted', 'dispatched')
           AND COALESCE(settled_at, recovered_at, 0) >= ?
         ORDER BY intent_seq DESC
         LIMIT ?`
      )
      .all(cutoff, SUBSCRIBE_TERMINAL_RUN_SNAPSHOT_LIMIT) as Array<Record<string, unknown>>
    const rows = [...live, ...recentTerminal]

    const result: SubscribeActiveRunRow[] = []
    for (const raw of rows) {
      const run = mapRunRow(raw)
      if (!this.#isCwdVisible(scope, run.cwd)) continue
      const liveMeta = scope === 'local' ? this.#hub.liveRunMeta(run.runId) : undefined
      const promptPreview =
        scope === 'remote' && run.promptPreview
          ? run.promptPreview.slice(0, PROMPT_PREVIEW_MAX_CHARS)
          : run.promptPreview
      result.push({
        runId: run.runId,
        ...(liveMeta?.scryRunId ? { scryRunId: liveMeta.scryRunId } : {}),
        ...(liveMeta?.admitted ? { admitted: true } : {}),
        ...(liveMeta?.externalSessionId ? { externalSessionId: liveMeta.externalSessionId } : {}),
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
        outcome: run.outcome,
        revSeq: run.revSeq
      })
    }
    return result
  }

  #detailSession(scope: 'local' | 'remote', ref: SubscribeSessionRef): SessionProjectionRow | undefined {
    const session = this.#sink.getSession(ref.sessionKey)
    if (!session || !this.#isCwdVisible(scope, session.cwd)) return undefined
    if ((ref.cwd !== undefined && ref.cwd !== session.cwd) ||
        (ref.providerId !== undefined && ref.providerId !== session.provider) ||
        (ref.agentProfileId !== undefined && ref.agentProfileId !== session.profile) ||
        (ref.externalSessionId !== undefined && ref.externalSessionId !== (session.catalog ? session.catalog.nativeSessionId : session.sessionKey))) {
      return undefined
    }
    return session
  }

  #readDetailSnapshot(session: SessionProjectionRow | undefined): NonNullable<SubscribeSnapshot['detail']> {
    if (!session) return { turns: [] }
    const db = this.#sink.handle.db
    const rows = db
      .prepare('SELECT * FROM orch_p_turn WHERE session_key = ? ORDER BY ordinal ASC')
      .all(session.sessionKey) as Array<Record<string, unknown>>
    const turns = rows.map(mapTurnRow)
    return {
      turns,
      ...(session.legacy ? { legacyBefore: true as const } : {})
    }
  }

  #isCwdVisible(scope: 'local' | 'remote', cwd: string | null): boolean {
    if (scope === 'local') return true
    if (!cwd) return false
    return this.#isRemoteCwdAuthorized(cwd)
  }

  #isEventVisible(scope: 'local' | 'remote', event: OrchestrationEventRow): boolean {
    if (scope === 'local') return true
    if (event.type === 'session.deleted') return this.#isCwdVisible('remote', event.cwd)
    return this.#isCwdVisible('remote', event.cwd)
  }

  #projectEventPayload(scope: 'local' | 'remote', event: OrchestrationEventRow): Record<string, unknown> {
    if (scope === 'local') return event.payload
    if (typeof event.payload.promptPreview === 'string' && event.payload.promptPreview.length > PROMPT_PREVIEW_MAX_CHARS) {
      return { ...event.payload, promptPreview: event.payload.promptPreview.slice(0, PROMPT_PREVIEW_MAX_CHARS) }
    }
    return event.payload
  }
}
