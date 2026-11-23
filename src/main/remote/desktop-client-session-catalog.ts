import { setTimeout as delay } from 'node:timers/promises'
import { KNOWN_SUBSCRIBE_EVENT_TYPES, parseSubscribeReply } from '../daemon-subscribe-parse'
import type { RemoteSessionRef } from '../../shared/desktop-remote'
import type {
  SubscribeActiveRunRow, SubscribeEventItem, SubscribeHint, SubscribeKnownCursor, SubscribeReply, SubscribeRequest
} from '../../shared/orchestration-subscribe'
import { fail, MAX_ITEMS, MAX_PAGES, record, text, validRunId, validateSession } from './desktop-client-validation'

const WAIT_MS = 20_000

type ReadSubscription = (request: SubscribeRequest, signal: AbortSignal) => Promise<Record<string, unknown>>
type StatusChange = { catalog?: true; runs?: true; stale?: true }

function knownOf(reply: SubscribeReply): SubscribeKnownCursor {
  const { hostId, logId, seq } = reply
  return { hostId, logId, seq }
}

function sessionFromRow(raw: unknown): { key: string; session: RemoteSessionRef; seq: number } {
  if (!record(raw) || !text(raw.sessionKey, 4096) || !Number.isSafeInteger(raw.revSeq)) fail('invalid_subscribe_session')
  const nativeId = record(raw.catalog) ? raw.catalog.nativeSessionId : raw.conversationId ? undefined : raw.sessionKey
  const outcome = record(raw.lastRunOutcome) ? raw.lastRunOutcome.value : undefined
  const session = validateSession({
    sessionId: raw.sessionKey, providerId: raw.provider ?? 'legacy_unknown', cwd: raw.cwd,
    label: (typeof raw.title === 'string' && raw.title) ||
      (record(raw.catalog) && typeof raw.catalog.preview === 'string' && raw.catalog.preview) || raw.sessionKey,
    ts: raw.ts,
    ...(text(nativeId, 256) ? { externalSessionId: nativeId } : {}),
    ...(typeof raw.profile === 'string' ? { agentProfileId: raw.profile } : {}),
    ...(raw.pinnedAt !== null ? { pinnedAt: raw.pinnedAt } : {}),
    ...(raw.archivedAt !== null ? { archivedAt: raw.archivedAt } : {}),
    isActive: typeof raw.activeRunId === 'string', pendingQuestions: raw.pendingQuestions,
    ...(typeof raw.lastRunId === 'string' ? { lastRunId: raw.lastRunId } : {}),
    ...(typeof outcome === 'string' ? { lastRunOutcome: outcome } : {})
  })
  return { key: raw.sessionKey, session, seq: Number(raw.revSeq) }
}

function isRunRow(raw: unknown): raw is SubscribeActiveRunRow {
  return record(raw) && validRunId(raw.runId) && text(raw.cwd, 16_384) && Number.isSafeInteger(raw.revSeq) &&
    (raw.traceRunId === undefined || validRunId(raw.traceRunId)) &&
    ['recorded', 'admitted', 'dispatched', 'settled', 'failed', 'cancelled', 'interrupted'].includes(String(raw.lifecycle))
}

function ordered(events: SubscribeEventItem[], previousSeq: number, nextSeq: number): boolean {
  return events.every((event, index) => KNOWN_SUBSCRIBE_EVENT_TYPES.has(event.type) &&
    event.seq > (index === 0 ? previousSeq : events[index - 1]!.seq) && event.seq <= nextSeq)
}

/** One retained status lane per connected host. It owns projection and retry state in main. */
export class DesktopStatusSubscription {
  readonly #stop = new AbortController()
  readonly #hostId: string
  readonly #read: ReadSubscription
  readonly #onChange: (change: StatusChange, hints: readonly SubscribeHint[]) => void
  #cursor?: SubscribeKnownCursor
  #sessions = new Map<string, ReturnType<typeof sessionFromRow>>()
  #runs = new Map<string, SubscribeActiveRunRow>()
  #opening?: Promise<void>
  #error?: unknown

  constructor(options: { hostId: string; read: ReadSubscription; onChange(change: StatusChange, hints: readonly SubscribeHint[]): void }) {
    this.#hostId = options.hostId
    this.#read = options.read
    this.#onChange = options.onChange
  }

  close(): void { this.#stop.abort() }

  open(): Promise<void> {
    return this.#opening ??= this.#snapshot().then(() => { void this.#follow() })
  }

  sessions(): RemoteSessionRef[] {
    if (this.#error) throw this.#error
    return [...this.#sessions.values()].map((item) => item.session)
      .sort((left, right) => (left.archivedAt ?? -1) - (right.archivedAt ?? -1) || right.ts - left.ts ||
        (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0))
  }

  runs(): ReadonlyMap<string, SubscribeActiveRunRow> {
    if (this.#error) throw this.#error
    return this.#runs
  }

  async #ask(request: SubscribeRequest): Promise<SubscribeReply> {
    this.#stop.signal.throwIfAborted()
    const reply = parseSubscribeReply(await this.#read(request, this.#stop.signal), true)
    this.#stop.signal.throwIfAborted()
    if (reply.hostId !== this.#hostId || !text(reply.logId, 128)) fail('invalid_subscribe_source')
    return reply
  }

  async #snapshot(initial?: Extract<SubscribeReply, { mode: 'snapshot' }>): Promise<void> {
    const first = initial ?? await this.#ask({ views: ['sessions', 'activeRuns'], waitMs: 0 })
    if (first.mode !== 'snapshot' || !first.snapshot.sessions || !first.snapshot.activeRuns) fail('invalid_subscribe_snapshot')
    const sessions = new Map<string, ReturnType<typeof sessionFromRow>>()
    const runs = new Map<string, SubscribeActiveRunRow>()
    for (const row of first.snapshot.activeRuns.rows) {
      if (!isRunRow(row) || runs.size >= MAX_ITEMS) fail('invalid_subscribe_run')
      runs.set(row.runId, row)
    }
    let current = first.snapshot.sessions
    const nextCursors = new Set<string>()
    for (let page = 0; page < MAX_PAGES; page++) {
      for (const raw of current.rows) {
        const row = sessionFromRow(raw)
        if (sessions.size >= MAX_ITEMS && !sessions.has(row.key)) fail('catalog_too_large')
        if ((sessions.get(row.key)?.seq ?? -1) < row.seq) sessions.set(row.key, row)
      }
      const next = current.nextCursor
      if (!next) {
        this.#sessions = sessions
        this.#runs = runs
        this.#cursor = knownOf(first)
        this.#error = undefined
        this.#onChange({ catalog: true, runs: true }, first.hints ?? [])
        return
      }
      if (nextCursors.has(next) || !text(next, 512)) fail('invalid_catalog_cursor')
      nextCursors.add(next)
      const reply = await this.#ask({ views: ['sessions'], sessionsCursor: next, known: knownOf(first), waitMs: 0 })
      if (reply.mode !== 'snapshot' || !reply.snapshot.sessions || reply.logId !== first.logId || reply.seq < first.seq) {
        fail('catalog_snapshot_changed')
      }
      current = reply.snapshot.sessions
    }
    fail('catalog_too_large')
  }

  #apply(reply: Exclude<SubscribeReply, { mode: 'snapshot' }>): void {
    const known = this.#cursor
    if (!known || reply.logId !== known.logId || reply.seq < known.seq ||
        (reply.mode === 'events' && !ordered(reply.events, known.seq, reply.seq))) {
      this.#cursor = undefined
      this.#sessions.clear()
      this.#runs.clear()
      this.#error = new Error('remote_subscribe_reset')
      this.#onChange({ stale: true }, [])
      return
    }
    const change: StatusChange = {}
    for (const event of reply.mode === 'events' ? reply.events : []) {
      if (event.sessionKey && event.sessionRow !== undefined && (this.#sessions.get(event.sessionKey)?.seq ?? -1) <= event.seq) {
        if (event.sessionRow === null) {
          if (this.#sessions.delete(event.sessionKey)) change.catalog = true
        } else {
          const row = sessionFromRow(event.sessionRow)
          if (row.key !== event.sessionKey) fail('invalid_subscribe_session')
          if (this.#sessions.size >= MAX_ITEMS && !this.#sessions.has(row.key)) fail('catalog_too_large')
          if ((this.#sessions.get(row.key)?.seq ?? -1) < row.seq) {
            this.#sessions.set(row.key, row)
            change.catalog = true
          }
        }
      }
      if (event.runId && event.runRow !== undefined) {
        const previous = this.#runs.get(event.runId)
        if (event.runRow === null) this.#runs.delete(event.runId)
        else {
          if (!isRunRow(event.runRow) || event.runRow.runId !== event.runId) fail('invalid_subscribe_run')
          if (this.#runs.size >= MAX_ITEMS && !previous) fail('catalog_too_large')
          if (!previous || previous.revSeq <= event.runRow.revSeq) {
            this.#runs.set(event.runId, { ...event.runRow, outputSeq: Math.max(previous?.outputSeq ?? 0, event.runRow.outputSeq ?? 0) })
          }
        }
        change.runs = true
      }
    }
    for (const hint of reply.hints ?? []) {
      if (hint.kind !== 'run') continue
      const cached = this.#runs.get(hint.runId)
      const traceRunId = validRunId(hint.traceRunId) ? hint.traceRunId : cached?.traceRunId
      // Worktree preparation progress is volatile: the newest hint replaces the cached step.
      const workspaceProgress = hint.workspaceProgress ?? cached?.workspaceProgress
      if (cached && (hint.outputSeq > (cached.outputSeq ?? 0) || traceRunId !== cached.traceRunId || workspaceProgress !== cached.workspaceProgress)) {
        this.#runs.set(hint.runId, { ...cached, traceRunId, outputSeq: Math.max(hint.outputSeq, cached.outputSeq ?? 0),
          ...(workspaceProgress ? { workspaceProgress } : {}) })
        change.runs = true
      }
    }
    this.#cursor = knownOf(reply)
    const recovered = this.#error !== undefined
    this.#error = undefined
    if (recovered) { change.catalog = true; change.runs = true }
    if (change.catalog || change.runs || reply.hints?.length) this.#onChange(change, reply.hints ?? [])
  }

  async #follow(): Promise<void> {
    let retryMs = 250
    while (!this.#stop.signal.aborted) {
      try {
        if (!this.#cursor) await this.#snapshot()
        else {
          const reply = await this.#ask({ views: ['sessions', 'activeRuns'], known: this.#cursor, waitMs: WAIT_MS })
          if (reply.mode === 'snapshot') await this.#snapshot(reply)
          else this.#apply(reply)
        }
        retryMs = 250
      } catch (error) {
        if (this.#stop.signal.aborted) return
        this.#error = error
        this.#onChange({ stale: true }, [])
        if (error instanceof Error && (error.message === 'desktop_not_connected' ||
            error.message === 'desktop_remote_device_not_authorized')) return
        try { await delay(retryMs, undefined, { signal: this.#stop.signal, ref: false }) } catch { return }
        retryMs = Math.min(retryMs * 2, 5_000)
      }
    }
  }
}
