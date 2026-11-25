import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { appendRotatingLog, readJson, writeJsonAtomic } from './io.js'
import { type TranscriptRead, nestedRecord, stringAt, terminalStatus, epochSecondsAt, TERMINAL_CLOCK_SKEW_MS } from './recorder-contracts.js'
import { emptyTranscript } from './recorder-transcript-background.js'
import { openTranscriptRead, statTranscript } from './recorder-transcript-fs.js'
import { type TranscriptSnapshotIdentity, transcriptIdentity, sameTranscriptIdentity, recordTranscriptBytes } from './recorder-transcript-io.js'
import { recorderTurnRoot, type RecorderOpenTurnState } from './runtime-state.js'

const DELTA_BYTES = 4 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const WITNESS_BYTES = 64
const REASON = 'Codex turn start was not available in the truncated transcript window; only independently matched terminal and lifecycle evidence were retained'

type Terminal = { terminalStatus: NonNullable<TranscriptRead['terminalStatus']>; completedAt: string }
interface Cursor {
  schemaVersion: 1
  path: string
  turnId: string
  identity: TranscriptSnapshotIdentity
  offset: number
  witness: string
  discarding: boolean
  caughtUp: boolean
  reasons: string[]
  terminal?: Terminal
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// Only an exact native turn ID can recover an orphan terminal. Never adopt the newest turn,
// infer completion from missing rows, or reuse its usage/assistant text.
function terminalFrom(line: string, turnId: string, startedAt: string): Terminal | undefined {
  if (!line.includes(turnId) || !/task_complete|turn_aborted/.test(line)) return undefined
  let row: unknown
  try { row = JSON.parse(line) } catch { return undefined }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined
  const event = row as Record<string, unknown>
  const payload = nestedRecord(event, 'payload')
  if (event.type !== 'event_msg' || !payload || stringAt(payload, 'turn_id', 'turnId') !== turnId) return undefined
  if (payload.type !== 'task_complete' && payload.type !== 'turn_aborted') return undefined
  let completedAt = stringAt(event, 'timestamp')
  if (payload.type === 'turn_aborted') {
    const end = epochSecondsAt(payload, 'completed_at', 'completedAt')
    const start = epochSecondsAt(payload, 'started_at', 'startedAt')
    const duration = payload.duration_ms
    if (end || start || duration != null) {
      const wall = Date.parse(end ?? '') - Date.parse(start ?? '')
      if (!end || !start || typeof duration !== 'number' || !Number.isFinite(duration) ||
        duration < 0 || wall < 0 || duration > wall + 999) return undefined
      completedAt = end
    }
  }
  const time = Date.parse(completedAt ?? '')
  const started = Date.parse(startedAt)
  if (!completedAt || !Number.isFinite(time) || !Number.isFinite(started) || time < started - TERMINAL_CLOCK_SKEW_MS ||
    time > Date.now() + TERMINAL_CLOCK_SKEW_MS) return undefined
  return { completedAt, terminalStatus: terminalStatus(payload,
    payload.type === 'turn_aborted' ? 'interrupted' : payload.error != null ? 'failed' : 'completed') }
}

function cursorPath(root: string, open: RecorderOpenTurnState): string {
  return join(recorderTurnRoot(root, open.generation), 'codex-transcript-cursor.json')
}

function result(cursor: Cursor): TranscriptRead {
  return {
    ...emptyTranscript(false),
    identityMatched: false,
    incompleteReasons: cursor.reasons,
    ...(cursor.terminal ?? {})
  }
}

/** Only called on a stable, capped identity miss. Reuse the bytes just parsed, not a second read. */
export async function rememberCodexTranscriptMiss(
  dataRoot: string, root: string, open: RecorderOpenTurnState, read: TranscriptRead
): Promise<TranscriptRead | undefined> {
  const source = read.source
  if (open.provider !== 'codex' || !open.providerTurnId || !read.stable || read.identityMatched !== false ||
    !source || source.sourcePath !== open.transcriptPath || source.sourceCompleteness !== 'partial' ||
    !read.incompleteReasons?.length || source.endOffset !== source.identity.size ||
    Buffer.byteLength(source.content) !== source.endOffset - source.startOffset) return undefined
  const content = source.content
  let terminal: Terminal | undefined
  let from = 0
  for (let end = content.indexOf('\n'); end >= 0; end = content.indexOf('\n', from)) {
    if (end - from <= MAX_LINE_BYTES) {
      terminal ??= terminalFrom(content.slice(from, end), open.providerTurnId, open.startedAt)
    }
    from = end + 1
  }
  const fragment = Buffer.byteLength(content.slice(from))
  const discarding = fragment >= MAX_LINE_BYTES || (!content.length && source.startOffset === source.endOffset)
  const offset = source.endOffset - (discarding ? 0 : fragment)
  const witness = Buffer.from(content.slice(Math.max(0, discarding ? content.length - WITNESS_BYTES : from - WITNESS_BYTES),
    discarding ? content.length : from)).subarray(-WITNESS_BYTES)
  // If no complete row survived or the retained bytes cannot supply a witness, still record the
  // cursor. Its first append will verify identity and keep skipping the already truncated row.
  const cursor: Cursor = {
    schemaVersion: 1, path: source.sourcePath, turnId: open.providerTurnId,
    identity: source.identity, offset, witness: `${witness.length}:${hash(witness)}`, discarding, caughtUp: true,
    reasons: [...read.incompleteReasons, REASON], ...(terminal ? { terminal } : {})
  }
  await writeJsonAtomic(cursorPath(root, open), cursor, { sync: false })
  await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} INFO Codex truncated recovery cursor: generation=${open.generation} size=${cursor.identity.size} terminal=${!!terminal}`
  ).catch(() => undefined)
  return result(cursor)
}

/** Unchanged files read zero transcript bytes; append reads a bounded suffix plus a 64 B witness. */
export async function resumeCodexTranscriptMiss(root: string, open: RecorderOpenTurnState): Promise<{
  read: TranscriptRead; unchanged: boolean
} | undefined> {
  if (open.provider !== 'codex' || !open.providerTurnId || !open.transcriptPath) return undefined
  const path = open.transcriptPath
  const checkpoint = cursorPath(root, open)
  const cursor = await readJson<Cursor>(checkpoint)
  if (cursor?.schemaVersion !== 1 || cursor.path !== path || cursor.turnId !== open.providerTurnId) return undefined
  if (!cursor.identity || !Number.isSafeInteger(cursor.identity.size) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 ||
    cursor.offset > cursor.identity.size || !Array.isArray(cursor.reasons) ||
    !/^\d{1,2}:[a-f0-9]{64}$/.test(cursor.witness)) return undefined
  const info = await statTranscript(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  })
  if (!info) return undefined
  const identity = transcriptIdentity(info)
  if (identity.dev !== cursor.identity.dev || identity.ino !== cursor.identity.ino || identity.size < cursor.identity.size) return undefined
  if (sameTranscriptIdentity(identity, cursor.identity) && (cursor.caughtUp || cursor.terminal)) {
    return { read: result(cursor), unchanged: true }
  }
  if (identity.size === cursor.identity.size && !sameTranscriptIdentity(identity, cursor.identity)) return undefined
  const witnessLength = Number(cursor.witness.split(':', 1)[0])
  if (witnessLength > WITNESS_BYTES || witnessLength > cursor.offset) return undefined
  const start = cursor.offset - witnessLength
  const wanted = Math.min(DELTA_BYTES, identity.size - cursor.offset) + witnessLength
  const buffer = Buffer.allocUnsafe(wanted)
  const handle = await openTranscriptRead(path)
  let count = 0
  try {
    if (!sameTranscriptIdentity(identity, transcriptIdentity(await handle.stat()))) return undefined
    while (count < wanted) {
      const { bytesRead } = await handle.read(buffer, count, wanted - count, start + count)
      recordTranscriptBytes(bytesRead)
      if (!bytesRead) return undefined
      count += bytesRead
    }
    if (!sameTranscriptIdentity(identity, transcriptIdentity(await handle.stat()))) return undefined
  } finally { await handle.close() }
  if (!sameTranscriptIdentity(identity, transcriptIdentity(await statTranscript(path)))) return undefined
  if (`${witnessLength}:${hash(buffer.subarray(0, witnessLength))}` !== cursor.witness) return undefined

  let from = witnessLength
  let discarding = cursor.discarding
  let terminal = cursor.terminal
  for (let end = buffer.indexOf(10, from); end >= 0; end = buffer.indexOf(10, from)) {
    if (!discarding && end - from <= MAX_LINE_BYTES) {
      const line = buffer.toString('utf8', from, end)
      // A target start can appear later, e.g. the hook arrived ahead of its transcript.
      // Re-enter the normal parser rather than closing from terminal-only evidence.
      if (line.includes('task_started') && line.includes(open.providerTurnId)) {
        await rm(checkpoint, { force: true })
        return undefined
      }
      terminal ??= terminalFrom(line, open.providerTurnId, open.startedAt)
    }
    discarding = false
    from = end + 1
  }
  if (discarding || buffer.length - from >= MAX_LINE_BYTES) {
    discarding = true
    from = buffer.length
  }
  // Keep a partial short line on disk (not in state); do not reread it until the file grows.
  const witness = buffer.subarray(Math.max(0, from - WITNESS_BYTES), from)
  const next = {
    ...cursor, identity, offset: start + from, witness: `${witness.length}:${hash(witness)}`,
    discarding, caughtUp: start + count === identity.size, terminal
  }
  await writeJsonAtomic(checkpoint, next, { sync: false })
  return { read: result(next), unchanged: false }
}

export const CODEX_TRUNCATED_RECOVERY_REASON = REASON
