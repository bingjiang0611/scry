import type { AgentDataUpdated } from '../shared/runtime'
import type { DesktopRemoteContext } from '../shared/desktop-remote'
import type { ActiveRun } from '../shared/trace'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import { isHostAdminNotice } from '../shared/host-admin'
import {
  SUBSCRIBE_RETAINED_WINDOW_NOTICES,
  type SubscribeActiveRunRow,
  type SubscribeEventItem,
  type SubscribeHint,
  type SubscribeHistoryPage,
  type SubscribeReply,
  type SubscribeSessionRow,
  type SubscribeSnapshot
} from '../shared/orchestration-subscribe'
import { DaemonRunError, fail, record } from './daemon-run-error'
import { readDaemonTrace, type DaemonTraceCall } from './daemon-run-trace-read'
import { parseWorkspacePrepareProgress } from '../shared/workspace-prepare-progress'

const MAX_UNREAD_SESSIONS = 10_000
const MAX_SUBSCRIBE_ITEMS = 512

/** P4 eventSet 1 known types; encountering an unknown type triggers a snapshot reset (`protocol §5.2`). */
export const KNOWN_SUBSCRIBE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.intent_recorded',
  'run.admitted',
  'run.dispatched',
  'run.session_bound',
  'run.stop_requested',
  'run.question_opened',
  'run.question_answered',
  'run.question_closed',
  'run.provider_settled',
  'run.finalized',
  'run.transcript_referenced',
  'run.settled',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'run.content_gap',
  'session.created',
  'session.renamed',
  'session.pinned',
  'session.unpinned',
  'session.archived',
  'session.restored',
  'session.deleted',
  'session.forked',
  'session.discovered',
  'session.withdrawn',
  'session.imported',
  'turn.began',
  'turn.delivery',
  'effect.voided',
  'host.started'
])

export function isDataUpdated(value: unknown): value is AgentDataUpdated {
  if (!record(value)) return false
  if (value.kind === 'conversation_changed') return typeof value.conversationId === 'string'
  if (value.kind === 'catalog_recovered' || value.kind === 'resynchronize') return true
  return typeof value.runId === 'string' && (value.kind === undefined || value.kind === 'turn_recorded' || value.kind === 'session_deleted')
}

export function isAttentionSnapshot(value: unknown): value is SessionAttentionSnapshot {
  return record(value) && Number.isSafeInteger(value.revision) && Array.isArray(value.unreadSessionKeys) &&
    value.unreadSessionKeys.length <= MAX_UNREAD_SESSIONS && value.unreadSessionKeys.every((key) => typeof key === 'string')
}

function isHistoryPage(value: unknown, network: boolean): value is SubscribeHistoryPage {
  if (network) return record(value) && value.kind === 'remoteHistory' && record(value.history)
  if (record(value) && value.kind === 'conversation') {
    const page = value.page
    return record(page) && record(page.summary) && typeof page.summary.id === 'string' &&
      Array.isArray(page.turns) && Array.isArray(page.bindings)
  }
  if (!record(value) || !Array.isArray(value.turns) || !Number.isSafeInteger(value.offset) ||
      !Number.isSafeInteger(value.totalTurns) || typeof value.hasOlder !== 'boolean' ||
      (value.completeness !== 'complete' && value.completeness !== 'partial')) return false
  const offset = value.offset as number
  return offset >= 0 && offset + value.turns.length <= (value.totalTurns as number) &&
    value.turns.every((turn) => record(turn) && typeof turn.userText === 'string' && Array.isArray(turn.items))
}

function parseHints(rawHints: unknown, network: boolean): SubscribeHint[] | undefined {
  if (rawHints === undefined) return undefined
  if (!Array.isArray(rawHints) || rawHints.length > MAX_SUBSCRIBE_ITEMS) throw new DaemonRunError('invalid_daemon_response')
  const hints: SubscribeHint[] = []
  for (const raw of rawHints) {
    if (!record(raw) || typeof raw.kind !== 'string') continue
    if (raw.kind === 'run' && typeof raw.runId === 'string' && Number.isSafeInteger(raw.outputSeq)) {
      const workspaceProgress = parseWorkspacePrepareProgress(raw.workspaceProgress)
      hints.push({
        kind: 'run',
        runId: raw.runId,
        outputSeq: raw.outputSeq as number,
        ...(typeof raw.scryRunId === 'string' && !network ? { scryRunId: raw.scryRunId } : {}),
        ...(typeof raw.traceRunId === 'string' && network ? { traceRunId: raw.traceRunId } : {}),
        ...(raw.admitted === true ? { admitted: true } : {}),
        ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
        ...(typeof raw.providerId === 'string' ? { providerId: raw.providerId } : {}),
        ...(typeof raw.agentProfileId === 'string' ? { agentProfileId: raw.agentProfileId } : {}),
        ...(typeof raw.externalSessionId === 'string' ? { externalSessionId: raw.externalSessionId } : {}),
        ...(workspaceProgress ? { workspaceProgress } : {})
      })
    } else if (raw.kind === 'terminal') {
      hints.push({ kind: 'terminal' })
    } else if (raw.kind === 'oauth' && typeof raw.url === 'string' && raw.url.length <= 8192) {
      hints.push({ kind: 'oauth', url: raw.url })
    } else if (raw.kind === 'hostNotice' && isHostAdminNotice(raw.notice)) {
      hints.push({ kind: 'hostNotice', notice: raw.notice })
    } else if (raw.kind === 'attention' && isAttentionSnapshot(raw.snapshot)) {
      hints.push({ kind: 'attention', snapshot: raw.snapshot })
    } else if (raw.kind === 'window' && typeof raw.channel === 'string' && SUBSCRIBE_RETAINED_WINDOW_NOTICES.has(raw.channel) && record(raw.payload)) {
      hints.push({ kind: 'window', channel: raw.channel, payload: raw.payload })
    } else if (raw.kind === 'data' && isDataUpdated(raw.event)) {
      hints.push({ kind: 'data', event: raw.event })
    }
  }
  return hints.length > 0 ? hints : undefined
}

export function parseSubscribeReply(reply: Record<string, unknown>, network = false): SubscribeReply {
  const sub = reply.subscribe
  if (!record(sub) || typeof sub.hostId !== 'string' || typeof sub.logId !== 'string' ||
      !Number.isSafeInteger(sub.seq) || (sub.seq as number) < 0) {
    throw new DaemonRunError('invalid_daemon_response')
  }
  const hints = parseHints(sub.hints, network)
  const base = { hostId: sub.hostId, logId: sub.logId, seq: sub.seq as number, ...(hints ? { hints } : {}) }
  if (sub.mode === 'idle') return { ...base, mode: 'idle' }
  if (sub.mode === 'events') {
    if (!Array.isArray(sub.events) || sub.events.length > MAX_SUBSCRIBE_ITEMS) throw new DaemonRunError('invalid_daemon_response')
    const events: SubscribeEventItem[] = []
    for (const raw of sub.events) {
      if (!record(raw) || !Number.isSafeInteger(raw.seq) || typeof raw.type !== 'string' ||
          typeof raw.stream !== 'string' || !Number.isSafeInteger(raw.at) || !record(raw.payload)) {
        throw new DaemonRunError('invalid_daemon_response')
      }
      events.push({
        seq: raw.seq as number,
        type: raw.type,
        stream: raw.stream,
        at: raw.at as number,
        ...(typeof raw.sessionKey === 'string' || raw.sessionKey === null ? { sessionKey: raw.sessionKey as string | null } : {}),
        ...(typeof raw.runId === 'string' || raw.runId === null ? { runId: raw.runId as string | null } : {}),
        ...(typeof raw.cwd === 'string' || raw.cwd === null ? { cwd: raw.cwd as string | null } : {}),
        payload: raw.payload,
        ...(network && (record(raw.sessionRow) || raw.sessionRow === null) ? { sessionRow: raw.sessionRow as SubscribeSessionRow | null } : {}),
        ...((record(raw.runRow) || raw.runRow === null) ? { runRow: raw.runRow as SubscribeActiveRunRow | null } : {}),
        ...(Array.isArray(raw.evidence) ? { evidence: raw.evidence.filter((e): e is string => typeof e === 'string') } : {})
      })
    }
    return { ...base, mode: 'events', events }
  }
  if (sub.mode === 'snapshot') {
    if (!record(sub.snapshot)) throw new DaemonRunError('invalid_daemon_response')
    const rawSnap = sub.snapshot
    const snapshot: SubscribeSnapshot = {}
    if (record(rawSnap.sessions) && Array.isArray(rawSnap.sessions.rows)) {
      snapshot.sessions = {
        rows: rawSnap.sessions.rows as SubscribeSessionRow[],
        total: rawSnap.sessions.total === 'unavailable' || Number.isSafeInteger(rawSnap.sessions.total)
          ? (rawSnap.sessions.total as number | 'unavailable')
          : 'unavailable',
        ...(typeof rawSnap.sessions.nextCursor === 'string' ? { nextCursor: rawSnap.sessions.nextCursor } : {})
      }
    }
    if (record(rawSnap.activeRuns) && Array.isArray(rawSnap.activeRuns.rows)) {
      snapshot.activeRuns = { rows: rawSnap.activeRuns.rows as SubscribeActiveRunRow[] }
    }
    if (record(rawSnap.detail) && Array.isArray(rawSnap.detail.turns)) {
      snapshot.detail = {
        turns: rawSnap.detail.turns,
        ...(rawSnap.detail.legacyBefore === true ? { legacyBefore: true } : {}),
        ...(isHistoryPage(rawSnap.detail.firstPage, network) ? { firstPage: rawSnap.detail.firstPage } : {})
      }
    }
    return { ...base, mode: 'snapshot', snapshot }
  }
  throw new DaemonRunError('invalid_daemon_response')
}

/**
 * Reads a settled run's final trace from its own archive segment
 * when the run has already left the live `RunRegistry`, replacing `settledTail`/`departedState`
 * in P4-3 `on` mode (`protocol §6` row 1).
 */
export async function readDaemonArchivedRunTrace(
  call: DaemonTraceCall,
  input: { context: DesktopRemoteContext; runId: string }
): Promise<ActiveRun | null> {
  if (!input.context.externalSessionId) return null
  const read = await readDaemonTrace(call, { ...input, archive: true })
  if (read.kind !== 'snapshot' || (read.run && read.run.runId !== input.runId)) return fail()
  return read.run
}
