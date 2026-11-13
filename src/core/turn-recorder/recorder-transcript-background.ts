import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { ProviderId } from '../../shared/provider.js'
import { parseTranscriptToTurns } from '../../main/normalize.js'
import { isTaskNotificationMessage } from '../../shared/task-notification.js'
import { type TranscriptRead, nestedRecord, stringAt, TERMINAL_CLOCK_SKEW_MS } from './recorder-contracts.js'
import { partial, unavailable, type TurnEvidence } from '../../shared/turn-record.js'
import { readTranscriptWindow, type TranscriptSnapshotIdentity } from './recorder-transcript-io.js'

const BACKGROUND_LAUNCH_KINDS = new Set(['backgrounded', 'async_launched'])
const BACKGROUND_SETTLED_STATUSES = new Set(['completed', 'failed', 'stopped', 'error', 'cancelled'])

function rowText(row: Record<string, unknown>): string | undefined {
  const message = nestedRecord(row, 'message')
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap((block) => {
    const item = block && typeof block === 'object' && !Array.isArray(block) ? block as Record<string, unknown> : undefined
    return typeof item?.text === 'string' ? [item.text] : []
  }).join('')
  return text || undefined
}

/**
 * The Provider's own completion row. Qoder writes it twice: as a consumed `user` row with
 * `origin.kind`, and as a queued `attachment` when the task finished while the Agent was busy.
 * Both name the task and its final status.
 */
function notificationText(row: Record<string, unknown>): string | undefined {
  const attachment = nestedRecord(row, 'attachment')
  const queued = attachment?.commandMode === 'task-notification' ? stringAt(attachment, 'prompt') : undefined
  const text = queued ?? rowText(row)
  if (!text) return undefined
  const consumable = nestedRecord(row, 'origin')?.kind === 'task-notification' ||
    isTaskNotificationMessage(text)
  return consumable ? text.trimStart() : undefined
}

/**
 * Background work that this transcript window launched and has not seen finish. The launch needs a
 * structured receipt, not intent: `run_in_background` alone only asks for it, and an Agent or a
 * human can describe a task id in text. The completion is the Provider's own `<task-notification>`
 * row, which the native transcript folds into the same turn.
 */
export function pendingBackgroundTasks(content: string): string[] {
  const launched = new Set<string>()
  const settled = new Set<string>()
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const receipt = nestedRecord(row, 'toolUseResult') ?? nestedRecord(row, 'tool_use_result')
    if (receipt && BACKGROUND_LAUNCH_KINDS.has(
      (typeof receipt.kind === 'string' ? receipt.kind : '') || (typeof receipt.status === 'string' ? receipt.status : '')
    )) {
      const taskId = stringAt(receipt, 'taskId', 'task_id')
      if (taskId) launched.add(taskId)
    }
    const text = notificationText(row)
    if (!text) continue
    const taskId = /<task-id>([^<>\r\n]+)<\/task-id>/.exec(text)?.[1]?.trim()
    const status = /<status>([^<>\r\n]+)<\/status>/.exec(text)?.[1]?.trim().toLowerCase()
    // A progress notification for a running task is not its completion.
    if (taskId && status && BACKGROUND_SETTLED_STATUSES.has(status)) settled.add(taskId)
  }
  return [...launched].filter((taskId) => !settled.has(taskId))
}


/**
 * A turn's start row is evidence only when the transcript wrote its own clock. A row without a
 * timestamp is dated by the parser, so it cannot prove the turn started inside this window.
 */
function ownTurnStartMs(content: string, userText: string, startedMs: number, ceilingMs: number): number | undefined {
  const wanted = userText.trim()
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (row.type !== 'user' || row.isMeta === true || row.isSynthetic === true) continue
    if (nestedRecord(row, 'origin')?.kind === 'task-notification') continue
    if (rowText(row)?.trim() !== wanted) continue
    const ms = Date.parse(typeof row.timestamp === 'string' ? row.timestamp : '')
    if (!Number.isFinite(ms) || ms < startedMs - TERMINAL_CLOCK_SKEW_MS) continue
    if (Number.isFinite(ceilingMs) && ms > ceilingMs) continue
    return ms
  }
  return undefined
}

export async function forcedWindowTranscript(args: {
  path: string
  runId: string
  provider: ProviderId
  startedAt: string
  endedAt?: string
  providerTurnId?: string
  requestSetId?: string
  sessionId?: string
  cwd?: string
}): Promise<TranscriptRead | undefined> {
  const startedMs = Date.parse(args.startedAt)
  if (!Number.isFinite(startedMs)) return undefined
  const ceilingMs = Date.parse(args.endedAt ?? '') + TERMINAL_CLOCK_SKEW_MS
  let identity: TranscriptSnapshotIdentity
  try {
    const info = await stat(args.path)
    identity = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
  } catch {
    return undefined
  }
  const snapshot = await readTranscriptWindow(args.path, identity.size, 0, identity)
  if (!snapshot.consistent) return undefined
  const turns = parseTranscriptToTurns(snapshot.content, {
    runId: args.runId,
    newId: () => `transcript-${randomUUID()}`,
    now: () => new Date().toISOString()
  })
  const turn = turns.find((candidate) => {
    const startMs = Date.parse(candidate.items[0]?.ts ?? '')
    if (!Number.isFinite(startMs) || startMs < startedMs - TERMINAL_CLOCK_SKEW_MS) return false
    return !Number.isFinite(ceilingMs) || startMs <= ceilingMs
  })
  if (!turn) return undefined
  // Rows that carry an identity the open turn does not have belong to some other turn. A neighbour
  // must never be published under this turn, however plausible its timestamps look.
  if (args.providerTurnId && turn.providerTurnId && turn.providerTurnId !== args.providerTurnId) return undefined
  if (args.requestSetId && turn.requestSetId && turn.requestSetId !== args.requestSetId) return undefined
  if (ownTurnStartMs(snapshot.content, turn.userText, startedMs, ceilingMs) === undefined) return undefined
  return {
    stable: true,
    observed: true,
    // Content bounded by the recorder's own clock instead of the Provider's turn identity.
    complete: false,
    ...(turn.userText ? { userText: turn.userText } : {}),
    events: turn.items,
    observable: {
      tools: turn.items.length > 0,
      skills: turn.items.some((event) => event.kind === 'skill'),
      mcps: turn.items.some((event) => event.kind === 'tool' && event.isMcp === true),
      hooks: turn.items.some((event) => event.kind === 'hook'),
      usage: turn.items.some((event) => event.kind === 'harness' && (event.stage === 'result' || event.stage === 'credit_usage')),
      files: turn.items.some((event) => !!event.filePath && !!event.fileOp),
      errors: turn.items.length > 0
    }
  }
}

/**
 * The transcript read used when there is nothing to read: no transcript path, or a forced close with
 * no window it can defend. Callers label the missing evidence; this only fixes the shape.
 */
export function emptyTranscript(complete: boolean): TranscriptRead {
  return {
    stable: true,
    observed: false,
    complete,
    events: [],
    observable: { tools: false, skills: false, mcps: false, hooks: false, usage: false, files: false, errors: false }
  }
}

/**
 * Why an unmatched identity may still be closed now, or undefined when it must keep waiting. Only a
 * decision to give up (expiry) or a session end can close a turn whose identity is gone; an ordinary
 * terminal keeps waiting for the transcript to catch up.
 */
export function unmatchedIdentityReason(open: {
  endReason?: string
  terminalIdentityConfirmedBySessionEnd?: boolean
  sessionEndedAt?: string
}, forcedReason: string | undefined): string | undefined {
  if (forcedReason) return `${forcedReason}; the transcript no longer contains this turn`
  if (open.endReason === 'session_end') return 'provider session ended without a matching transcript; only lifecycle-hook evidence remains'
  return open.terminalIdentityConfirmedBySessionEnd || open.sessionEndedAt
    ? 'provider session ended after the terminal hook without a matching transcript; only lifecycle-hook evidence remains'
    : undefined
}

/** The window a forced close may keep for this turn, if the transcript still holds any of it. */
export async function retainedWindowTranscript(
  open: {
    provider: ProviderId
    sessionId: string
    startedAt: string
    transcriptPath?: string
    terminalAt?: string
    closingAt?: string
    providerTurnId?: string
    requestSetId?: string
  },
  runId: string,
  cwd: string
): Promise<TranscriptRead | undefined> {
  if (!open.transcriptPath) return undefined
  return forcedWindowTranscript({
    path: open.transcriptPath,
    runId,
    provider: open.provider,
    startedAt: open.startedAt,
    ...(open.terminalAt ?? open.closingAt ? { endedAt: open.terminalAt ?? open.closingAt } : {}),
    ...(open.providerTurnId ? { providerTurnId: open.providerTurnId } : {}),
    ...(open.requestSetId ? { requestSetId: open.requestSetId } : {}),
    sessionId: open.sessionId,
    cwd
  })
}

/**
 * Label the assistant evidence of a turn whose identity never matched. A retained window keeps the
 * rows but cannot claim completeness: its start is the recorder's clock, not the Provider's turn
 * identity.
 */
export function degradeUnmatchedIdentity(evidence: TurnEvidence, reason: string, retained: boolean): void {
  if (!retained) {
    evidence.assistant = unavailable(reason)
    evidence.modelSegments = unavailable(reason)
    return
  }
  const bounded = `${reason}; this turn's content is bounded by the recorded turn start and the next user prompt`
  const assistant = evidence.assistant.value
  evidence.assistant = assistant
    ? partial(assistant, evidence.assistant.source, bounded)
    : unavailable(bounded, evidence.assistant.source)
  const segments = evidence.modelSegments?.value
  evidence.modelSegments = segments?.length
    ? partial(segments, evidence.modelSegments?.source ?? [], bounded)
    : unavailable(bounded, evidence.modelSegments?.source)
}
