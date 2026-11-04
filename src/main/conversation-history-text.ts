import { modelEventBodies } from '../core/turn-recorder/tool-content'
import { isToolContent } from '../shared/tool-content'
import type { Conversation } from '../shared/conversation'
import type { TraceEvent } from '../shared/trace'
import { appendCoalescedTrace } from './live-trace'
import { APP_TRACE_CONTENT_SOURCE, readAppTraceContentPage } from './trace-tool-content'
import { MAX_CONVERSATION_HISTORY_TEXT_BYTES } from './conversation-history-limits'

/**
 * Complete visible text of one source turn, read inside one shared byte budget.
 * This is the same extractor the recorder and handoff use, so a side-chat
 * snapshot cannot invent a different body than the one Scry already recorded.
 */

/** One shared byte budget for a bounded source read; never a per-turn allowance. */
export interface HistoryReadBudget { textBytes: number; unbounded?: boolean }
export const historyReadBudget = (): HistoryReadBudget => ({ textBytes: 0 })

/**
 * Budget for reading a source into a frozen snapshot.
 *
 * Capture streams the prefix one message at a time into the sealed manifest, so the
 * prefix length is not a resident budget: a hundred MiB of history costs the manifest,
 * not memory. What remains resident is the single message being projected, which is why
 * a per-prefix cap would refuse a long session for no memory reason.
 */
export const captureReadBudget = (): HistoryReadBudget => ({ textBytes: 0, unbounded: true })

/**
 * This read ran out of its one shared byte budget.
 *
 * It is a real, tagged limit rather than prose: a side-chat preview may offer a smaller
 * frozen boundary for it, while every other failure keeps its own meaning.
 */
export class HistoryReadBudgetExceeded extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoryReadBudgetExceeded'
  }
}

export function chargeText(budget: HistoryReadBudget, bytes: number): void {
  budget.textBytes += bytes
  if (!budget.unbounded && budget.textBytes > MAX_CONVERSATION_HISTORY_TEXT_BYTES) {
    throw new HistoryReadBudgetExceeded('交接源正文超过 4 MiB 读取预算')
  }
}

const visibleText = (event: TraceEvent): boolean => event.kind === 'model' &&
  (event.stage === 'text' || event.stage === 'text_delta') && event.agentId == null && event.parentToolUseId == null

export async function fullText(userData: string, cwd: string, event: TraceEvent, budget: HistoryReadBudget): Promise<string> {
  const body = event.modelContent
  if (!body) {
    if (typeof event.text !== 'string') throw new Error('交接源缺少可读取的助手文字')
    chargeText(budget, Buffer.byteLength(event.text, 'utf8'))
    return event.text
  }
  if (!isToolContent(body) || body.encoding !== 'utf8' || body.sourceCompleteness !== 'complete' || body.redaction === 'failed') {
    throw new Error('交接源正文不完整，不能用预览代替全文')
  }
  if (body.contentRef) {
    if (body.source !== APP_TRACE_CONTENT_SOURCE || body.contentRef.encoding !== 'utf8') {
      throw new Error('交接源正文引用不属于已支持的 App 归档存储')
    }
    chargeText(budget, body.contentRef.bytes)
    const chunks: Buffer[] = []
    let offset = 0
    do {
      const page = await readAppTraceContentPage(userData, cwd, { source: 'app-trace', ref: body.contentRef, offset })
      chunks.push(Buffer.from(page.dataBase64, 'base64'))
      offset = page.nextOffset
      if (!page.hasMore) break
    } while (offset < body.contentRef.bytes)
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  }
  if (body.storage !== 'complete' || body.content === undefined) throw new Error('交接源只有预览，缺少完整正文引用')
  chargeText(budget, Buffer.byteLength(body.content, 'utf8'))
  return body.content
}

/** Complete bodies of one contiguous event slice, using the recorder's delta/final rules. */
function assistantTextOf(events: readonly TraceEvent[]): string {
  const bodies: string[] = []
  for (const group of modelEventBodies(events)) {
    if (group.body?.kind === 'text' && visibleText(group.events[0])) bodies.push(group.body.text)
  }
  return bodies.join('\n\n')
}

async function hydrateVisible(userData: string, conversation: Pick<Conversation, 'cwd'>, turn: {
  runId: string
  items: TraceEvent[]
}, budget: HistoryReadBudget): Promise<TraceEvent[]> {
  const projected: TraceEvent[] = []
  for (const event of turn.items) {
    if (visibleText(event)) {
      if (event.runId !== turn.runId) throw new Error('交接源助手事件属于其他 run')
      const text = await fullText(userData, conversation.cwd, event, budget)
      const hydrated = { ...event, text, modelContent: undefined }
      if (event.stage === 'text' && event.messageId && event.runtimeMetadata?.replacesStreamedText === true) {
        appendCoalescedTrace(projected, hydrated)
      } else projected.push(hydrated)
    } else projected.push(event)
  }
  return projected
}

/** One visible message of a frozen source turn, in proven conversational order. */
export interface ProjectedTurnMessage {
  role: 'user' | 'assistant'
  text: string
  /** Present only for a human steering prompt accepted by the Provider. */
  steerMessageId?: string
}

/**
 * Project one source turn into ordered visible messages.
 *
 * Only evidence-confirmed transitions become messages: the initial prompt, then
 * contiguous visible assistant text, then each `steer.status === 'accepted'`
 * prompt. Pending/rejected/unavailable steers contribute no message and no
 * boundary, and reasoning/tool protocol events are never projected as text.
 * An accepted steer whose answer is not inside this turn leaves the projection
 * ending mid-turn; that order cannot be proven, so the capture fails closed.
 */
export async function turnMessageProjection(
  userData: string,
  conversation: Pick<Conversation, 'cwd'>,
  turn: { runId: string; userText: string; items: TraceEvent[] },
  budget: HistoryReadBudget
): Promise<ProjectedTurnMessage[]> {
  const projected = await hydrateVisible(userData, conversation, turn, budget)
  const messages: ProjectedTurnMessage[] = [{ role: 'user', text: turn.userText }]
  let slice: TraceEvent[] = []
  let steers = 0
  for (const event of projected) {
    const steer = event.stage === 'steer' ? event.steer : undefined
    if (!steer) {
      slice.push(event)
      continue
    }
    // An unaccepted steer is not a message and must not merge the event runs around it.
    if (steer.status !== 'accepted') {
      slice.push(event)
      continue
    }
    const settled = assistantTextOf(slice)
    slice = []
    if (settled) messages.push({ role: 'assistant', text: settled })
    steers += 1
    messages.push({ role: 'user', text: steer.prompt, steerMessageId: steer.messageId })
  }
  const tail = assistantTextOf(slice)
  if (tail) messages.push({ role: 'assistant', text: tail })
  if (steers > 0 && messages.at(-1)?.role === 'user') {
    throw new Error('该轮最后一条已接受的追加输入没有可见助手回复，不能证明消息顺序与轮次收敛，不能创建侧聊')
  }
  return messages
}

/** Assistant body of one completed turn, unchanged for steered and unsteered turns. */
export async function turnAssistantText(
  userData: string,
  conversation: Pick<Conversation, 'cwd'>,
  turn: { runId: string; items: TraceEvent[] },
  budget: HistoryReadBudget
): Promise<string> {
  return assistantTextOf(await hydrateVisible(userData, conversation, turn, budget))
}
