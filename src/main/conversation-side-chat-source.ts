import { createHash } from 'node:crypto'
import { capturedConversationMessages } from './conversation-side-chat-capture-stream'
import { iterateTraceArchiveCapture, traceArchiveCaptureInfo, TraceArchiveCaptureError } from './transcript-archive-capture'
import { requireValue } from './conversation-schema'
import type { ConversationTurn, SideChatSource } from '../shared/conversation'
import type { SideChatServiceDeps, SideChatNativeSource } from './conversation-service-deps'
import { normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from '../shared/session-title'
import type { ProviderId } from '../shared/provider'
import { streamTurns, type StreamedMessage } from './conversation-side-chat-stream'
import { completedProjections, projectedMessages, stopReasonProvesCompletion } from './conversation-side-chat-raw'
import { captureStreamedNativePrefix } from './conversation-side-chat-native-stream'
import { measureSink, type CaptureItem } from './conversation-side-chat-capture'
import type { CaptureSink } from './conversation-side-chat-capture'
import { TitleTap, consume, type RequestedBoundary } from './conversation-side-chat-sink'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export type { CaptureItem, CaptureSink } from './conversation-side-chat-capture'
export type { RequestedBoundary } from './conversation-side-chat-sink'

/**
 * One captured prefix, described by exact per-message facts instead of message bodies.
 *
 * A frozen history may hold thousands of messages and hundreds of MiB of text; carrying
 * the bodies here is exactly the ceiling this path removes. Preview keeps these facts and
 * creation streams the same messages into the sealed manifest.
 */
export interface CapturedPrefix {
  source: SideChatSource
  cwd: string
  title: string
  throughOrdinal: number
  throughRunId: string
  /** Proven source Provider/profile, never guessed from a display name. */
  sourceTarget: { providerId: ProviderId; agentProfileId?: string }
  items: CaptureItem[]
  prefixFingerprint: string
  manifestFingerprint: string
  bodyBytes: number
  /** Lowest ordinal this source can freeze; the UI may offer it to fit the budget. */
  smallestThroughOrdinal: number
}

function sourceIdentity(source: SideChatSource): string {
  if (source.kind === 'conversation') return `conversation:${source.conversationId}`
  return `native:${JSON.stringify([source.providerId, source.agentProfileId ?? null, source.cwd, source.nativeSessionId])}`
}

export function captureTitle(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return normalizeSessionTitle(cleaned.slice(0, SESSION_TITLE_MAX_LENGTH) || fallback)
}

/**
 * Fingerprints cover the selected messages only. File mtime, a mutable trailing
 * turn or the source's full archive length never participate, so appending to the
 * source cannot change an already-previewed prefix.
 */
export function fingerprints(source: SideChatSource, through: { ordinal: number; runId: string }, items: readonly CaptureItem[]): {
  prefixFingerprint: string
  manifestFingerprint: string
} {
  return {
    prefixFingerprint: hash(JSON.stringify({
      source: sourceIdentity(source), throughOrdinal: through.ordinal, throughRunId: through.runId,
      items: items.map(item => [item.sourceRunId, item.role, item.contentHash, item.sourceOrdinal, item.providerId])
    })),
    manifestFingerprint: hash(JSON.stringify(items.map(item =>
      [item.sourceOrdinal, item.providerId, item.role, item.contentHash])))
  }
}

/** One message of a source whose text is already in memory, typed as a stream. */
function memoryMessage(text: string, contentHash: string, role: 'user' | 'assistant'): StreamedMessage {
  return { role, contentHash, bytes: Buffer.byteLength(text, 'utf8'), text: (async function* () { yield text })() }
}

function capturableTurn(turn: ConversationTurn): boolean {
  if (!turn.archive) return false
  return turn.origin === 'imported' || (turn.origin === 'dispatch' && turn.delivery.status === 'accepted')
}

function boundaryTurn(turn: ConversationTurn): boolean {
  if (!capturableTurn(turn) || turn.items.length === 0) return false
  // A failed/interrupted turn is not the default freeze boundary, but it stays in
  // an earlier prefix with its captured status.
  return turn.origin === 'imported' || (turn.origin === 'dispatch' && turn.delivery.status === 'accepted' && turn.delivery.outcome === 'completed')
}

function prefixEnd(prefix: readonly ConversationTurn[], boundary: RequestedBoundary | undefined): number {
  const end = boundary === undefined ? prefix.findLastIndex(boundaryTurn) : boundary.ordinal - 1
  if (end < 0) throw new Error('来源没有可验证的已完成轮次与正文；不会创建空快照')
  const through = prefix[end]
  if (!through) throw new Error('来源快照边界已不存在，请重新预览；本次未创建侧聊')
  if (boundary?.runId !== undefined && through.runId !== boundary.runId) {
    throw new Error('来源快照边界已变化，请重新预览；本次未创建侧聊')
  }
  if (!boundaryTurn(through)) throw new Error('来源边界不是可冻结的已完成轮次，请重新预览')
  return end
}

/**
 * Read-only capture of a source conversation's stable completed prefix. A trailing
 * turn that is still running is skipped instead of waited for or adopted, and an
 * explicitly selected earlier boundary stays valid when the source keeps appending.
 */
async function captureConversationPrefix(
  deps: SideChatServiceDeps,
  conversationId: string,
  boundary: RequestedBoundary | undefined,
  sink: CaptureSink
): Promise<CapturedPrefix> {
  const conversation = await deps.store.read(conversationId)
  if (!conversation) throw new Error('侧聊来源对话不存在或已删除；不会自动创建空快照')
  if (conversation.deletion) throw new Error('侧聊来源正在删除或已删除，不能创建侧聊')
  if (conversation.sideChat) throw new Error('暂不支持以侧聊为来源创建新的侧聊')
  const end = prefixEnd(conversation.turns, boundary)
  const through = conversation.turns[end]
  const prefix = conversation.turns.slice(0, end + 1)
  for (const turn of prefix) {
    if (turn.items.length === 0) continue
    requireValue(capturableTurn(turn), '来源前缀包含无法验证的轮次，不能创建侧聊')
  }
  const binding = conversation.bindings.find(candidate => candidate.id === through.bindingId)
  requireValue(binding !== undefined, '来源轮次缺少原生绑定归属')
  const items: CaptureItem[] = []
  // A conversation source names the child after the source conversation, not its text.
  const untitled = new TitleTap()
  // Streamed one turn at a time: a long prefix costs the sealed manifest, not memory.
  for await (const entry of capturedConversationMessages(deps.store.userData, conversation, prefix)) {
    items.push(await consume(sink, entry.message, entry.meta, untitled))
  }
  requireValue(items.length > 0, '来源快照正文不完整，不能创建侧聊')
  return {
    source: { kind: 'conversation', conversationId },
    cwd: conversation.cwd,
    title: captureTitle(conversation.title, `对话 ${conversation.id.slice(0, 8)}`),
    throughOrdinal: through.ordinal,
    throughRunId: through.runId,
    sourceTarget: { providerId: binding.providerId, ...(binding.agentProfileId ? { agentProfileId: binding.agentProfileId } : {}) },
    items,
    ...fingerprints({ kind: 'conversation', conversationId }, { ordinal: through.ordinal, runId: through.runId }, items),
    bodyBytes: items.reduce((bytes, item) => bytes + item.bytes, 0),
    smallestThroughOrdinal: conversation.turns.findIndex(boundaryTurn) + 1
  }
}

/**
 * 侧聊自己也是 Conversation，它的原生 session 同样不能被再次拿来当侧聊来源：
 * 那会绕过「不嵌套侧聊」。只读已有 owner/binding，不接管、不改写来源。
 */
async function assertSourceNotOwnedBySideChat(
  deps: SideChatServiceDeps,
  source: Extract<SideChatSource, { kind: 'native-session' }>
): Promise<void> {
  const owning = (await deps.store.list(source.cwd)).find(conversation => Boolean(conversation.sideChat) &&
    conversation.bindings.some(binding => binding.providerId === source.providerId &&
      binding.nativeSessionId === source.nativeSessionId))
  if (owning) throw new Error(`该原生会话属于侧聊 ${owning.id}；不支持嵌套侧聊`)
}

/** Feeds the settled archive prefix straight from the bounded projection. */
async function captureArchivePrefix(
  deps: SideChatServiceDeps,
  source: Extract<SideChatSource, { kind: 'native-session' }>,
  captureArgs: { userDataDir: string; cwd: string; providerId: ProviderId; sessionId: string },
  info: Awaited<ReturnType<typeof traceArchiveCaptureInfo>>,
  boundary: RequestedBoundary | undefined,
  sink: CaptureSink
): Promise<{ items: CaptureItem[]; title?: string; through?: { ordinal: number; runId: string } }> {
  const items: CaptureItem[] = []
  const title = new TitleTap()
  let through: { ordinal: number; runId: string } | undefined
  let closed = false
  // Segments are read one file at a time, so the archive-wide ordinal is counted here.
  let ordinal = 0
  for await (const turn of streamTurns(deps.store.userData, source.cwd, iterateTraceArchiveCapture(captureArgs, info))) {
    ordinal += 1
    if (boundary !== undefined && ordinal > boundary.ordinal) break
    if (closed) {
      if (turn.settled) throw new Error('原生会话前缀包含没有终止证据的轮次，不能创建侧聊')
      continue
    }
    if (!turn.settled) {
      // A trailing unsettled turn is a tail Scry drops. One inside a requested
      // boundary, or before a later settled turn, is an unproven prefix.
      if (boundary !== undefined) throw new Error('原生会话前缀包含没有终止证据的轮次，不能创建侧聊')
      closed = true
      continue
    }
    if (boundary?.runId !== undefined && ordinal === boundary.ordinal && turn.runId !== boundary.runId) {
      throw new Error('原生会话快照边界已变化，请重新预览；本次未创建侧聊')
    }
    for (const message of turn.messages) {
      items.push(await consume(sink, message, {
        role: message.role, sourceRunId: turn.runId, sourceOrdinal: ordinal,
        providerId: source.providerId, status: turn.status, delivery: 'snapshot',
        nativeSessionId: source.nativeSessionId,
        ...(turn.providerTurnId === undefined ? {} : { providerTurnId: turn.providerTurnId })
      }, title))
    }
    through = { ordinal, runId: turn.runId }
  }
  return { items, ...(title.value === undefined ? {} : { title: title.value }), ...(through === undefined ? {} : { through }) }
}

/**
 * Native-session sources reuse the shipped native readers (Scry archive first, then
 * the Provider's own bounded transcript reader). Ownership, resume identity and
 * control of that session stay with whoever already runs it; this is provenance only.
 */
async function captureNativePrefix(
  deps: SideChatServiceDeps,
  source: Extract<SideChatSource, { kind: 'native-session' }>,
  boundary: RequestedBoundary | undefined,
  sink: CaptureSink
): Promise<CapturedPrefix> {
  const native: SideChatNativeSource = { providerId: source.providerId, ...(source.agentProfileId ? { agentProfileId: source.agentProfileId } : {}),
    cwd: source.cwd, nativeSessionId: source.nativeSessionId }
  // Fail closed: provenance without a verified catalog identity is not evidence.
  const seam = deps.sideChatSource
  if (!seam) throw new Error('原生来源身份校验未接入，不能创建侧聊')
  await seam.assertNativeSource(native)
  await assertSourceNotOwnedBySideChat(deps, source)
  const captureArgs = {
    userDataDir: deps.store.userData, cwd: source.cwd, providerId: source.providerId, sessionId: source.nativeSessionId
  }
  // A source with no Scry archive at all is not an error here: the Provider's own
  // bounded transcript reader below is the documented fallback.
  const archiveInfo = await traceArchiveCaptureInfo(captureArgs).catch((error: unknown) => {
    if (error instanceof TraceArchiveCaptureError) return undefined
    throw error
  })
  // A streaming seam only constructs a reader here; nothing is read until it is iterated.
  const stream = await deps.sideChatSource?.streamNativeTurns?.(native)
  let items: CaptureItem[]
  let title: string | undefined
  let through: { ordinal: number; runId: string } | undefined
  if (archiveInfo && archiveInfo.totalTurns !== 0) {
    const archived = await captureArchivePrefix(deps, source, captureArgs, archiveInfo, boundary, sink)
    items = archived.items
    title = archived.title
    through = archived.through
  } else if (stream) {
    const captured = await captureStreamedNativePrefix({ source, stream, boundary, sink })
    items = captured.items
    title = captured.title
    through = captured.through
  } else {
    const read = deps.sideChatSource?.readNativeTurns
    const turns = read ? await read(native) : null
    if (!turns?.length) {
      throw new Error(`该原生会话没有 Scry 归档，也没有可验证的原生历史读取器或历史文件；不会创建空快照`)
    }
    // A raw transcript carries no recorder terminal: only the Provider's own
    // marker settles a turn. A trailing turn that still shows text therefore
    // stays out of the prefix, whether or not Scry is running it right now.
    const status = 'unavailable'
    const selected = completedProjections(await projectedMessages(deps.store.userData, source.cwd, turns,
      turn => ({ status, settled: stopReasonProvesCompletion(source.providerId, turn) })))
    if (selected.length === 0) throw new Error('该原生会话没有已完成轮次；不会创建空快照')
    const last = boundary === undefined ? selected.length - 1 : boundary.ordinal - 1
    const end = selected[last]
    if (!end) throw new Error('该原生会话没有已完成轮次；不会创建空快照')
    if (boundary?.runId !== undefined && end.runId !== boundary.runId) {
      throw new Error('原生会话快照边界已变化，请重新预览；本次未创建侧聊')
    }
    const tap = new TitleTap()
    const collected: CaptureItem[] = []
    for (const turn of selected.slice(0, last + 1)) {
      for (const message of turn.messages) {
        const contentHash = hash(message.text)
        collected.push(await consume(sink, memoryMessage(message.text, contentHash, message.role), {
          role: message.role, sourceRunId: turn.runId,
          sourceOrdinal: turn.ordinal,
          providerId: source.providerId, status, delivery: 'snapshot',
          nativeSessionId: source.nativeSessionId,
          ...(turn.providerTurnId === undefined ? {} : { providerTurnId: turn.providerTurnId })
        }, tap))
      }
    }
    items = collected
    title = tap.value
    through = { ordinal: end.ordinal, runId: end.runId }
  }
  if (items.length === 0 || through === undefined) throw new Error('该原生会话没有已完成轮次；不会创建空快照')
  return {
    source,
    cwd: source.cwd,
    title: captureTitle(title, `原生会话 ${source.nativeSessionId.slice(0, 8)}`),
    throughOrdinal: through.ordinal,
    throughRunId: through.runId,
    sourceTarget: { providerId: source.providerId, ...(source.agentProfileId ? { agentProfileId: source.agentProfileId } : {}) },
    items,
    ...fingerprints(source, through, items),
    bodyBytes: items.reduce((bytes, item) => bytes + item.bytes, 0),
    smallestThroughOrdinal: 1
  }
}

/**
 * Lowest ordinal this source can freeze, read without projecting any message body.
 *
 * The preview uses it only after a budget refusal: a smaller frozen prefix is a real
 * choice the user may take, and offering it must not require the expensive read that
 * just failed.
 */
/**
 * The workspace a child of this source will live in, resolved before any capture so the
 * sealed body can be written under the child's own content root.
 */
export async function sourceWorkspaceCwd(deps: SideChatServiceDeps, source: SideChatSource): Promise<string> {
  if (source.kind === 'native-session') return source.cwd
  const conversation = await deps.store.read(source.conversationId)
  if (!conversation) throw new Error('侧聊来源对话不存在或已删除；不会自动创建空快照')
  return conversation.cwd
}

/**
 * Captures the stable prefix of one source.
 *
 * The sink is the only place a message body goes: preview passes a measuring sink and
 * keeps nothing, creation passes the sealed snapshot writer. Neither reads the whole
 * history into memory, so a large source is a matter of time, not of a refusal.
 */
export async function captureSideChatPrefix(
  deps: SideChatServiceDeps,
  source: SideChatSource,
  boundary?: RequestedBoundary,
  sink: CaptureSink = measureSink()
): Promise<CapturedPrefix> {
  if (source.kind === 'conversation') return captureConversationPrefix(deps, source.conversationId, boundary, sink)
  return captureNativePrefix(deps, source, boundary, sink)
}
