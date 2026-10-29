import { createHash } from 'node:crypto'
import type { HistoryMessage } from './conversation-history-content'
import { historyReadBudget, turnMessageProjection } from './conversation-history-text'
import { readCapturedTurnMessages } from './conversation-history-source'
import { readTraceArchiveForMigration, type TraceArchiveTurn } from './transcript-archive'
import { requireValue } from './conversation-schema'
import { MAX_CONVERSATION_HISTORY_TURNS } from './conversation-history-limits'
import type { ConversationTurn, SideChatSource } from '../shared/conversation'
import type { SideChatServiceDeps, SideChatNativeSource, SideChatNativeTurn } from './conversation-service-deps'
import { normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from '../shared/session-title'
import type { ProviderId } from '../shared/provider'
import { HistoryReadBudgetExceeded } from './conversation-history-text'
import { SideChatBudgetRefusal } from './conversation-side-chat-refusal'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export interface CaptureEntry {
  sourceRunId: string
  role: 'user' | 'assistant'
  sourceOrdinal: number
  providerId: ProviderId
  contentHash: string
  message: HistoryMessage
}

/** The user-visible freeze boundary; creation re-verifies this exact turn. */
export interface RequestedBoundary {
  ordinal: number
  runId?: string
}

export interface CapturedPrefix {
  source: SideChatSource
  cwd: string
  title: string
  throughOrdinal: number
  throughRunId: string
  /** Proven source Provider/profile, never guessed from a display name. */
  sourceTarget: { providerId: ProviderId; agentProfileId?: string }
  entries: CaptureEntry[]
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

export function entriesFor(messages: readonly HistoryMessage[]): CaptureEntry[] {
  return messages.map((message) => ({
    sourceRunId: message.ref.runId,
    role: message.role,
    sourceOrdinal: message.ordinal,
    providerId: message.providerId as ProviderId,
    contentHash: message.ref.contentHash,
    message: { ...message, delivery: 'snapshot' }
  }))
}

/**
 * Fingerprints cover the selected messages only. File mtime, a mutable trailing
 * turn or the source's full archive length never participate, so appending to the
 * source cannot change an already-previewed prefix.
 */
export function fingerprints(source: SideChatSource, through: { ordinal: number; runId: string }, entries: CaptureEntry[]): {
  prefixFingerprint: string
  manifestFingerprint: string
} {
  return {
    prefixFingerprint: hash(JSON.stringify({
      source: sourceIdentity(source), throughOrdinal: through.ordinal, throughRunId: through.runId,
      items: entries.map(entry => [entry.sourceRunId, entry.role, entry.contentHash, entry.sourceOrdinal, entry.providerId])
    })),
    manifestFingerprint: hash(JSON.stringify(entries.map(entry =>
      [entry.sourceOrdinal, entry.providerId, entry.role, entry.contentHash])))
  }
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
  boundary: RequestedBoundary | undefined
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
  const messages = await readCapturedTurnMessages(deps.store.userData, conversation, prefix).catch((error: unknown) => {
    // The bounded source read is one authoritative budget boundary. Its refusal is what
    // a smaller frozen prefix can answer; anything else keeps its own reason.
    if (error instanceof HistoryReadBudgetExceeded) throw new SideChatBudgetRefusal(error.message)
    throw error
  })
  requireValue(messages.length > 0, '来源快照正文不完整，不能创建侧聊')
  const entries = entriesFor(messages)
  return {
    source: { kind: 'conversation', conversationId },
    cwd: conversation.cwd,
    title: captureTitle(conversation.title, `对话 ${conversation.id.slice(0, 8)}`),
    throughOrdinal: through.ordinal,
    throughRunId: through.runId,
    sourceTarget: { providerId: binding.providerId, ...(binding.agentProfileId ? { agentProfileId: binding.agentProfileId } : {}) },
    entries,
    ...fingerprints({ kind: 'conversation', conversationId }, { ordinal: through.ordinal, runId: through.runId }, entries),
    bodyBytes: bodyBytes(entries),
    smallestThroughOrdinal: conversation.turns.findIndex(boundaryTurn) + 1
  }
}

function bodyBytes(entries: readonly CaptureEntry[]): number {
  return entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.message.text, 'utf8'), 0)
}

interface ProjectedTurn {
  ordinal: number
  runId: string
  providerTurnId?: string
  status: string
  /**
   * Proven finished turn: the recorder terminal for a Scry archive, the Provider's
   * own terminal marker for a raw transcript. Visible text never settles a turn.
   */
  settled: boolean
  messages: Array<{ role: 'user' | 'assistant'; text: string; steerMessageId?: string }>
}

/** Native turns never gain an App archive, a parent binding or a recorder run here. */
function projectedMessages(
  userData: string,
  cwd: string,
  turns: readonly SideChatNativeTurn[],
  evidenceOf: (turn: SideChatNativeTurn) => { status: string; settled: boolean }
): Promise<ProjectedTurn[]> {
  const budget = historyReadBudget()
  return turns.reduce(async (previous, turn, index) => {
    const projected = await previous
    const messages = await turnMessageProjection(userData, { cwd }, turn, budget)
    return [...projected, { ordinal: index + 1, runId: turn.runId, ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
      ...evidenceOf(turn), messages }]
  }, Promise.resolve<ProjectedTurn[]>([]))
}

function archivedTurns(turns: readonly TraceArchiveTurn[]): SideChatNativeTurn[] {
  return turns.map(turn => ({ runId: turn.runId, ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
    userText: turn.userText, items: turn.items }))
}

/**
 * The stable prefix ends at the last settled turn; nothing after it is frozen.
 * An unsettled turn inside the prefix is not a tail Scry can drop, so the source
 * is refused instead of freezing output whose completion is unknown.
 */
function completedProjections(turns: readonly ProjectedTurn[]): ProjectedTurn[] {
  const last = turns.findLastIndex(turn => turn.settled)
  if (last < 0) return []
  const prefix = turns.slice(0, last + 1)
  if (prefix.some(turn => !turn.settled)) {
    throw new Error('原生会话前缀包含没有终止证据的轮次，不能创建侧聊')
  }
  return prefix
}

/**
 * The only markers that prove a Provider finished a turn: Claude writes
 * `message.stop_reason`, Pi writes `message.stopReason`. `tool_use` / `toolUse`
 * means the turn is still producing, and a missing marker proves nothing.
 */
const completedStopReasons: Partial<Record<ProviderId, string>> = { claude: 'end_turn', pi: 'stop' }

function stopReasonProvesCompletion(providerId: ProviderId, turn: SideChatNativeTurn): boolean {
  const expected = completedStopReasons[providerId]
  return expected !== undefined && turn.stopReason === expected
}

function nativeEntries(source: Extract<SideChatSource, { kind: 'native-session' }>, turns: readonly ProjectedTurn[], status: string): CaptureEntry[] {
  const messages: HistoryMessage[] = []
  for (const turn of turns) {
    let assistant = 0
    for (const message of turn.messages) {
      const ref = message.role === 'user'
        ? { runId: turn.runId, itemId: message.steerMessageId === undefined ? 'user' : `steer:${message.steerMessageId}`, contentHash: hash(message.text) }
        : { runId: turn.runId, itemId: `assistant:${assistant++}`, contentHash: hash(message.text) }
      messages.push({ ref, providerId: source.providerId, nativeSessionId: source.nativeSessionId,
        ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}), ordinal: turn.ordinal,
        role: message.role, status, delivery: 'imported', text: message.text })
    }
  }
  return entriesFor(messages)
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

/**
 * Native-session sources reuse the shipped native readers (Scry archive first, then
 * the Provider's own bounded transcript reader). Ownership, resume identity and
 * control of that session stay with whoever already runs it; this is provenance only.
 */
async function captureNativePrefix(
  deps: SideChatServiceDeps,
  source: Extract<SideChatSource, { kind: 'native-session' }>,
  boundary: RequestedBoundary | undefined
): Promise<CapturedPrefix> {
  const native: SideChatNativeSource = { providerId: source.providerId, ...(source.agentProfileId ? { agentProfileId: source.agentProfileId } : {}),
    cwd: source.cwd, nativeSessionId: source.nativeSessionId }
  // Fail closed: provenance without a verified catalog identity is not evidence.
  const seam = deps.sideChatSource
  if (!seam) throw new Error('原生来源身份校验未接入，不能创建侧聊')
  await seam.assertNativeSource(native)
  await assertSourceNotOwnedBySideChat(deps, source)
  const archive = await readTraceArchiveForMigration({
    userDataDir: deps.store.userData, cwd: source.cwd, providerId: source.providerId, sessionId: source.nativeSessionId
  })
  let sources: ProjectedTurn[]
  let status = 'completed'
  if (archive?.turns.length) {
    if (archive.turns.length > MAX_CONVERSATION_HISTORY_TURNS) throw new SideChatBudgetRefusal('侧聊快照超过 2000 轮读取预算')
    const settled = new Map(archive.turns.map(turn => [turn.runId, turn.done && (turn.status ?? 'completed') === 'completed']))
    const statuses = new Map(archive.turns.map(turn => [turn.runId, turn.status ?? 'completed']))
    sources = completedProjections(await projectedMessages(deps.store.userData, source.cwd, archivedTurns(archive.turns),
      turn => ({ status: statuses.get(turn.runId) ?? 'completed', settled: settled.get(turn.runId) === true })))
  } else {
    const read = deps.sideChatSource?.readNativeTurns
    const turns = read ? await read(native) : null
    if (!turns?.length) {
      throw new Error(`该原生会话没有 Scry 归档，也没有可验证的原生历史读取器或历史文件；不会创建空快照`)
    }
    if (turns.length > MAX_CONVERSATION_HISTORY_TURNS) throw new SideChatBudgetRefusal('侧聊快照超过 2000 轮读取预算')
    // A raw transcript carries no recorder terminal: only the Provider's own
    // marker settles a turn. A trailing turn that still shows text therefore
    // stays out of the prefix, whether or not Scry is running it right now.
    status = 'unavailable'
    sources = completedProjections(await projectedMessages(deps.store.userData, source.cwd, turns,
      turn => ({ status, settled: stopReasonProvesCompletion(source.providerId, turn) })))
  }
  if (!sources.length) throw new Error('该原生会话没有已完成轮次；不会创建空快照')
  const completed = boundary === undefined ? sources.length - 1 : boundary.ordinal - 1
  if (completed < 0) throw new Error('该原生会话没有已完成轮次；不会创建空快照')
  const through = sources[completed]
  if (!through) throw new Error('原生会话快照边界已不存在，请重新预览')
  if (boundary?.runId !== undefined && through.runId !== boundary.runId) {
    throw new Error('原生会话快照边界已变化，请重新预览；本次未创建侧聊')
  }
  const entries = nativeEntries(source, sources.slice(0, completed + 1), status)
  requireValue(entries.length > 0, '来源快照正文不完整，不能创建侧聊')
  return {
    source,
    cwd: source.cwd,
    title: captureTitle(entries.find(entry => entry.role === 'user')?.message.text, `原生会话 ${source.nativeSessionId.slice(0, 8)}`),
    throughOrdinal: through.ordinal,
    throughRunId: through.runId,
    sourceTarget: { providerId: source.providerId, ...(source.agentProfileId ? { agentProfileId: source.agentProfileId } : {}) },
    entries,
    ...fingerprints(source, { ordinal: through.ordinal, runId: through.runId }, entries),
    bodyBytes: bodyBytes(entries),
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
export async function smallestFreezableOrdinal(deps: SideChatServiceDeps, source: SideChatSource): Promise<number> {
  if (source.kind === 'native-session') return 1
  const conversation = await deps.store.read(source.conversationId)
  if (!conversation) return 0
  return conversation.turns.findIndex(boundaryTurn) + 1
}

export function captureSideChatPrefix(
  deps: SideChatServiceDeps,
  source: SideChatSource,
  boundary?: RequestedBoundary
): Promise<CapturedPrefix> {
  return source.kind === 'conversation'
    ? captureConversationPrefix(deps, source.conversationId, boundary)
    : captureNativePrefix(deps, source, boundary)
}
