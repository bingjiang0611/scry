import type { AgentStopState } from '../shared/runtime'
import type { DesktopRemoteContext, DesktopRemoteTraceRead } from '../shared/desktop-remote'
import type {
  SubscribeActiveRunRow,
  SubscribeEventItem,
  SubscribeHint
} from '../shared/orchestration-subscribe'
import { admissionPhase, lateRefusalNotice } from './daemon-run-admission'
import type { RunCursor } from './daemon-run-cursor'
import type { DaemonRunTransport } from './daemon-run-transport'
import type { RunWakes } from './daemon-run-wakes'

const TERMINAL_LIFECYCLES = new Set(['settled', 'failed', 'cancelled', 'interrupted'])

export interface SubscribeRuntimeContext {
  runs: Map<string, RunCursor>
  wakes: RunWakes
  cursorFor: (runId: string) => RunCursor | undefined
  send: (channel: string, payload: unknown) => void
  onSessionBound?: (payload: Record<string, unknown>) => void
  publishStopState?: (state: AgentStopState) => void
  settleRunTrace?: (runId: string) => void
  flushBridge: () => void
  scheduleTraceRead: (runId: string, options?: { terminal?: boolean }) => Promise<void>
  syncQuestions: (cursor: RunCursor) => Promise<void>
  /** One-shot lifecycle probe for a run a snapshot no longer lists; null = unknown run. */
  probeRunState?: (runId: string) => Promise<string | null>
}

function makeCursor(runId: string, init: {
  context?: DesktopRemoteContext
  lifecycle: string | null
  scryRunId?: string
  admitted?: boolean
  userText?: string
}): RunCursor {
  return {
    runId,
    ...(init.context ? { context: init.context } : {}),
    lifecycle: init.lifecycle,
    ...(init.scryRunId ? { scryRunId: init.scryRunId } : {}),
    ...(init.admitted ? { admitted: true } : {}),
    ...(init.userText !== undefined ? { userText: init.userText } : {}),
    watch: 0,
    output: 0,
    pushed: [],
    askedQuestions: new Set(),
    answerIds: new Map(),
    resyncRequired: false,
    pumping: false,
    stopped: false,
    sawText: false
  }
}

function ensureContext(cursor: RunCursor, fields: {
  cwd?: string | null
  providerId?: string | null
  agentProfileId?: string | null
  externalSessionId?: string | null
}): void {
  const cwd = fields.cwd ?? cursor.context?.cwd
  const providerId = fields.providerId ?? cursor.context?.providerId
  if (!cwd || !providerId) return
  const agentProfileId = fields.agentProfileId ?? cursor.context?.agentProfileId
  const externalSessionId = fields.externalSessionId ?? cursor.context?.externalSessionId
  cursor.context = {
    cwd,
    providerId,
    ...(agentProfileId ? { agentProfileId } : {}),
    ...(externalSessionId ? { externalSessionId } : {})
  }
}

function emitSessionBoundOnce(ctx: SubscribeRuntimeContext, cursor: RunCursor, sessionId: string): void {
  if (!sessionId || cursor.notifiedSessionId === sessionId) return
  cursor.notifiedSessionId = sessionId
  ensureContext(cursor, { externalSessionId: sessionId })
  const canonicalId = cursor.scryRunId ?? cursor.runId
  const payload: Record<string, unknown> = {
    runId: canonicalId,
    sessionId,
    previousSessionId: canonicalId,
    externalSessionId: sessionId,
    ...(cursor.context?.providerId ? { providerId: cursor.context.providerId } : {}),
    ...(cursor.context?.agentProfileId ? { agentProfileId: cursor.context.agentProfileId } : {})
  }
  ctx.send('agent:session', payload)
  ctx.onSessionBound?.(payload)
}

async function finalizeTerminalCursor(
  ctx: SubscribeRuntimeContext,
  cursor: RunCursor,
  lifecycle: string,
  reason?: string
): Promise<void> {
  if (lifecycle === 'failed' || lifecycle === 'cancelled' || lifecycle === 'interrupted') {
    cursor.failure ??= reason && reason.length > 0 ? reason : `run_${lifecycle}`
  }
  const admitted = admissionPhase(cursor) === 'admitted'
  if (!admitted) {
    cursor.lifecycle = lifecycle
    cursor.stopped = true
    ctx.wakes.wake(cursor.runId)
  }

  if (cursor.settledNotified) {
    cursor.lifecycle = lifecycle
    cursor.stopped = true
    return
  }
  cursor.settledNotified = true

  // Read any remaining trace items (from live registry or archive fallback, zero settledTail)
  // BEFORE marking `done` / emitting `agent:turnDone`, matching legacy in-process ordering.
  if (cursor.context && admitted) {
    await ctx.scheduleTraceRead(cursor.runId, { terminal: true })
  }
  ctx.flushBridge()

  const canonicalId = cursor.scryRunId ?? cursor.runId
  ctx.settleRunTrace?.(canonicalId)

  const refused = lateRefusalNotice(cursor)
  if (refused) {
    cursor.lifecycle = lifecycle
    cursor.stopped = true
    ctx.wakes.wake(cursor.runId)
    ctx.send('agent:error', refused)
    return
  }
  if (admitted) {
    const sessionId = cursor.context?.externalSessionId ?? cursor.latest?.externalSessionId
    ctx.send('agent:turnDone', {
      runId: canonicalId,
      ...(sessionId ? { sessionId, externalSessionId: sessionId } : {}),
      ...(cursor.context?.providerId ? { providerId: cursor.context.providerId } : {}),
      ...(cursor.context?.agentProfileId ? { agentProfileId: cursor.context.agentProfileId } : {}),
      stopped: lifecycle === 'cancelled' || lifecycle === 'interrupted'
    })
  }
  cursor.lifecycle = lifecycle
  cursor.stopped = true
  ctx.wakes.wake(cursor.runId)
}

/** Reconciles `activeRuns` snapshot rows without dropping run state or duplicating terminal notices. */
export async function applySubscribeSnapshotToRuntime(
  ctx: SubscribeRuntimeContext,
  rows: SubscribeActiveRunRow[]
): Promise<void> {
  for (const row of rows) {
    const isTerminal = TERMINAL_LIFECYCLES.has(row.lifecycle)
    let cursor = ctx.cursorFor(row.runId) ?? (row.scryRunId ? ctx.cursorFor(row.scryRunId) : undefined)
    if (!cursor) {
      if (isTerminal) continue
      const context =
        row.cwd && row.provider
          ? {
              cwd: row.cwd,
              providerId: row.provider,
              ...(row.profile ? { agentProfileId: row.profile } : {}),
              ...(row.externalSessionId ? { externalSessionId: row.externalSessionId } : {})
            }
          : undefined
      cursor = makeCursor(row.runId, {
        ...(context ? { context } : {}),
        lifecycle: row.lifecycle,
        ...(row.scryRunId ? { scryRunId: row.scryRunId } : {}),
        ...(row.admitted ? { admitted: true } : {}),
        ...(row.promptPreview ? { userText: row.promptPreview } : {})
      })
      ctx.runs.set(row.runId, cursor)
    } else {
      if (row.scryRunId && !cursor.scryRunId) {
        cursor.scryRunId = row.scryRunId
        cursor.stamp?.mark('bound')
      }
      if (row.admitted) cursor.admitted = true
      ensureContext(cursor, {
        cwd: row.cwd,
        providerId: row.provider,
        agentProfileId: row.profile,
        externalSessionId: row.externalSessionId
      })
      if (!isTerminal) {
        cursor.lifecycle = row.stopState === 'requested' ? 'stopping' : row.lifecycle
        cursor.stopped = false
      }
    }

    if (row.externalSessionId) emitSessionBoundOnce(ctx, cursor, row.externalSessionId)
    ctx.wakes.wake(cursor.runId)

    if (isTerminal) {
      await finalizeTerminalCursor(ctx, cursor, row.lifecycle)
    } else if (cursor.context && ((row.outputSeq ?? 0) > cursor.output || cursor.latest === undefined)) {
      if (typeof row.outputSeq === 'number') cursor.output = Math.max(cursor.output, row.outputSeq)
      void ctx.scheduleTraceRead(cursor.runId)
    }
  }
  await reconcileVanishedCursors(ctx, rows)
}

/**
 * A snapshot lists every non-terminal run, so a cursor the App still treats as live
 * but the snapshot omits either ended long ago or belongs to a replaced log (logId
 * change). Probe it once instead of guessing: a terminal or unknown answer finalizes
 * the cursor; a still-live answer means the snapshot was taken just before that run
 * was recorded, so the cursor is left alone.
 */
async function reconcileVanishedCursors(ctx: SubscribeRuntimeContext, rows: SubscribeActiveRunRow[]): Promise<void> {
  if (!ctx.probeRunState) return
  const listed = new Set<string>()
  for (const row of rows) {
    listed.add(row.runId)
    if (row.scryRunId) listed.add(row.scryRunId)
  }
  const vanished = [...ctx.runs.values()].filter((cursor) =>
    !cursor.stopped && !listed.has(cursor.runId) && !(cursor.scryRunId && listed.has(cursor.scryRunId)))
  for (const cursor of vanished) {
    let state: string | null
    try {
      state = await ctx.probeRunState(cursor.runId)
    } catch {
      continue
    }
    if (cursor.stopped) continue
    if (state === null) await finalizeTerminalCursor(ctx, cursor, 'interrupted')
    else if (TERMINAL_LIFECYCLES.has(state)) await finalizeTerminalCursor(ctx, cursor, state)
  }
}

/** Applies one durable orchestration event from `subscribe` directly to `DaemonRunRuntime`. */
export async function applySubscribeEventToRuntime(
  ctx: SubscribeRuntimeContext,
  event: SubscribeEventItem
): Promise<void> {
  const runId = event.runId ?? (typeof event.payload.runId === 'string' ? event.payload.runId : undefined)
  if (!runId) return

  let cursor = ctx.cursorFor(runId)
  if (event.type === 'run.intent_recorded') {
    if (!cursor) {
      const p = event.payload
      const cwd = event.cwd ?? (typeof p.cwd === 'string' ? p.cwd : undefined)
      const providerId = typeof p.provider === 'string' ? p.provider : undefined
      const agentProfileId = typeof p.profile === 'string' ? p.profile : undefined
      cursor = makeCursor(runId, {
        ...(cwd && providerId ? { context: { cwd, providerId, ...(agentProfileId ? { agentProfileId } : {}) } } : {}),
        lifecycle: 'recorded',
        ...(typeof p.promptPreview === 'string' ? { userText: p.promptPreview } : {})
      })
      ctx.runs.set(runId, cursor)
    }
    ctx.wakes.wake(cursor.runId)
    return
  }

  if (!cursor) {
    cursor = makeCursor(runId, { lifecycle: 'dispatched' })
    ctx.runs.set(runId, cursor)
  }

  if (event.type === 'run.admitted' || event.type === 'run.dispatched') {
    if (!TERMINAL_LIFECYCLES.has(cursor.lifecycle ?? '')) {
      cursor.lifecycle = event.type === 'run.admitted' ? 'admitted' : 'dispatched'
    }
    ctx.wakes.wake(cursor.runId)
    return
  }

  if (event.type === 'run.session_bound') {
    const nativeSessionId = typeof event.payload.nativeSessionId === 'string' ? event.payload.nativeSessionId : undefined
    if (nativeSessionId) emitSessionBoundOnce(ctx, cursor, nativeSessionId)
    return
  }

  if (event.type === 'run.stop_requested') {
    cursor.lifecycle = 'stopping'
    if (!cursor.stopNotified) {
      cursor.stopNotified = true
      const nowIso = new Date(event.at).toISOString()
      const state: AgentStopState = {
        runId: cursor.scryRunId ?? cursor.runId,
        providerId: (cursor.context?.providerId ?? 'codex') as AgentStopState['providerId'],
        runtimeProvider: (cursor.context?.providerId ?? 'codex') as AgentStopState['runtimeProvider'],
        ...(cursor.context?.agentProfileId ? { agentProfileId: cursor.context.agentProfileId } : {}),
        phase: 'interrupt_requested',
        requestedAt: nowIso,
        updatedAt: nowIso,
        providerSettled: false,
        window: { gracefulMs: 10_000, forceKillMs: 3_000 }
      }
      ctx.publishStopState?.(state)
      ctx.send('agent:stopState', state)
    }
    return
  }

  if (event.type === 'run.question_opened' || event.type === 'run.question_answered' || event.type === 'run.question_closed') {
    void ctx.syncQuestions(cursor)
    return
  }

  if (event.type === 'run.settled' || event.type === 'run.failed' || event.type === 'run.cancelled' || event.type === 'run.interrupted') {
    const lifecycle = event.type.slice(4)
    const reason =
      typeof event.payload.detail === 'string' && event.payload.detail.length > 0
        ? event.payload.detail
        : typeof event.payload.reason === 'string'
          ? event.payload.reason
          : undefined
    await finalizeTerminalCursor(ctx, cursor, lifecycle, reason)
  }
}

/** Applies a volatile `run` hint (binding, admission, or streaming outputSeq wake) with zero `watch` calls. */
export function applyRunHintToRuntime(
  ctx: SubscribeRuntimeContext,
  hint: Extract<SubscribeHint, { kind: 'run' }>
): void {
  let cursor = ctx.cursorFor(hint.runId) ?? (hint.scryRunId ? ctx.cursorFor(hint.scryRunId) : undefined)
  if (!cursor) {
    cursor = makeCursor(hint.runId, {
      lifecycle: 'dispatched',
      ...(hint.scryRunId ? { scryRunId: hint.scryRunId } : {}),
      ...(hint.admitted ? { admitted: true } : {})
    })
    ctx.runs.set(hint.runId, cursor)
  }
  if (hint.scryRunId && !cursor.scryRunId) {
    cursor.scryRunId = hint.scryRunId
    cursor.stamp?.mark('bound')
  }
  if (hint.admitted) cursor.admitted = true
  ensureContext(cursor, {
    cwd: hint.cwd,
    providerId: hint.providerId,
    agentProfileId: hint.agentProfileId,
    externalSessionId: hint.externalSessionId
  })
  if (hint.externalSessionId) emitSessionBoundOnce(ctx, cursor, hint.externalSessionId)
  ctx.wakes.wake(cursor.runId)

  const shouldReadTrace =
    cursor.context !== undefined &&
    cursor.admitted === true &&
    !cursor.stopped &&
    (hint.outputSeq > cursor.output || cursor.latest === undefined)
  if (shouldReadTrace) {
    cursor.output = Math.max(cursor.output, hint.outputSeq)
    void ctx.scheduleTraceRead(cursor.runId)
  }
}

/** Event-driven admission wait for `subscribeMode`: zero `watch` polls, wakes on hint or terminal event. */
export async function awaitSubscribeAdmission(input: {
  runId: string
  cursor: () => RunCursor | undefined
  wakes: RunWakes
  bindBudgetMs: number
  admitBudgetMs: number
}): Promise<string | undefined> {
  const startedAt = Date.now()
  for (;;) {
    const cursor = input.cursor()
    if (!cursor) return undefined
    const phase = admissionPhase(cursor)
    if (phase === 'refused') return undefined
    if (cursor.scryRunId !== undefined && phase === 'admitted') return cursor.scryRunId
    const deadline = startedAt + (cursor.scryRunId !== undefined ? input.admitBudgetMs : input.bindBudgetMs)
    const terminal = TERMINAL_LIFECYCLES.has(cursor.lifecycle ?? '')
    if (terminal) {
      if (phase === 'pending') cursor.failure ??= cursor.lifecycle === 'cancelled' ? 'run_cancelled' : 'run_failed'
      return undefined
    }
    const remaining = deadline - Date.now()
    if (cursor.stopped || remaining <= 0) return cursor.scryRunId
    input.wakes.consume(input.runId)
    await input.wakes.wait(input.runId, Math.min(250, remaining))
  }
}

/** Reads a run's live trace without `settledTail`, falling back to the trace archive once terminal. */
export async function readSubscribeTraceOnce(input: {
  cursor: RunCursor | undefined
  runId: string
  disposed: boolean
  terminal?: boolean
  transport: Pick<DaemonRunTransport, 'trace' | 'archivedRunTrace'>
  apply: (read: DesktopRemoteTraceRead, cursor: RunCursor) => boolean
  syncQuestions: (cursor: RunCursor) => Promise<void>
  flush: () => void
  onWarn?: (message: string, detail?: unknown) => void
}): Promise<void> {
  const { cursor, runId } = input
  if (!cursor || !cursor.context || input.disposed) return
  const targetId = cursor.scryRunId ?? runId
  try {
    let read = await input.transport.trace({
      context: cursor.context, runId: targetId, settledTail: false,
      ...(cursor.after ? { after: cursor.after } : {})
    })
    if (read.kind === 'snapshot' && read.run === null) {
      // A Provider result precedes the daemon's finalization. Diff and other
      // evidence may have reached the archive after the last live read.
      if (input.terminal && cursor.context.externalSessionId) {
        const archived = await input.transport.archivedRunTrace({ context: cursor.context, runId: targetId })
        if (archived) {
          // Deduplicate by event id so archive-formatted turns never re-emit already-pushed events.
          const pushedIds = new Set(cursor.pushed.map((e) => e.id))
          const missing = archived.items.filter((item) => !pushedIds.has(item.id))
          if (missing.length > 0) {
            read = { kind: 'snapshot', run: { ...archived, items: [...cursor.pushed, ...missing] } }
          }
        }
      }
      // Never pass `{ kind: 'snapshot', run: null }` to `apply`, which would wipe `cursor.pushed`.
      if (read.kind === 'snapshot' && read.run === null) return
    }
    if (cursor.stamp && cursor.latest === undefined && read.kind === 'snapshot' && read.run) cursor.stamp.mark('firstTrace')
    const changed = input.apply(read, cursor)
    if (!input.terminal) await input.syncQuestions(cursor)
    if (changed) input.flush()
  } catch (error) {
    input.onWarn?.('daemon subscribe trace read failed', error)
  }
}
