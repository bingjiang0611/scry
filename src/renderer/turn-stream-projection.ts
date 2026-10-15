import type { TraceEvent } from '@shared/trace'

/**
 * 流式文本片段：Claude/Qoder/Pi 用 text_delta；旧版 Codex 曾把每个增量误标成 text。
 * 与 ChatTurn 主流程共用同一判定，避免两处对「什么算流式」给出不同答案。
 */
export function isStreamTextFragment(event: TraceEvent): boolean {
  if (event.kind !== 'model') return false
  if (event.stage === 'text_delta') return true
  return event.stage === 'text' && (event.providerId === 'codex' || event.runtimeProvider === 'codex_cli')
}

// applyTraceBatch knows exactly which immutable prefix it preserved. WeakRef avoids
// retaining every earlier array through a chain of update provenance.
const traceItemsChanges = new WeakMap<readonly TraceEvent[], {
  previous: WeakRef<readonly TraceEvent[]>
  firstChanged: number
}>()

export function recordTraceItemsChange(items: readonly TraceEvent[], previous: readonly TraceEvent[], firstChanged: number): void {
  traceItemsChanges.set(items, { previous: new WeakRef(previous), firstChanged })
}

type LiveTailKind = 'text' | 'thinking'

interface LiveTailDescriptor {
  kind: LiveTailKind
  scope: string | null
  messageId?: string
  agentId?: string
}

function liveTailDescriptor(event: TraceEvent): LiveTailDescriptor | undefined {
  const kind = isStreamTextFragment(event)
    ? 'text'
    : event.kind === 'model' && event.stage === 'thinking'
      ? 'thinking'
      : undefined
  if (!kind) return undefined
  return {
    kind,
    scope: event.parentToolUseId ?? null,
    messageId: event.messageId,
    agentId: event.agentId
  }
}

function sameLiveTail(event: TraceEvent, tail: LiveTailDescriptor): boolean {
  const candidate = liveTailDescriptor(event)
  return candidate?.kind === tail.kind &&
    candidate.scope === tail.scope &&
    candidate.messageId === tail.messageId &&
    candidate.agentId === tail.agentId
}

export interface TurnStreamProjection {
  /** 去掉尾部 live 文本/思考后的事件序列；只在真正发生结构变化时换引用。 */
  structuralItems: readonly TraceEvent[]
  /** 尾部流式回复的拼接结果，随每批增量更新。 */
  liveText: string
  /** 尾部流式思考的拼接结果，随每批增量更新。 */
  liveThinking: string
  /** 尾部第一个流式片段的事件 id，用作稳定 React key。 */
  liveKey: string
  /** null 表示顶层 live tail；string 表示归属对应父工具的子 agent tail。 */
  liveParentToolUseId?: string | null
  /** 本次调用是否重算了 structuralItems——测试用它断言更新次数有界。 */
  structuralRecomputed: boolean
}

function liveTailStart(
  items: readonly TraceEvent[],
  unchanged?: { end: number; tailStart: number; tail?: LiveTailDescriptor }
): { index: number; tail?: LiveTailDescriptor } {
  const tail = items.length > 0 ? liveTailDescriptor(items[items.length - 1]) : undefined
  if (!tail) return { index: items.length }
  const continuesTail = unchanged?.tail && sameTailDescriptor(unchanged.tail, tail)
  if (tail.scope !== null && !continuesTail && !items.some((event) =>
    event.toolUseId === tail.scope && event.stage !== 'tool_result' && ['tool', 'skill', 'agent'].includes(event.kind)
  )) {
    return { index: items.length }
  }
  let index = items.length
  const floor = unchanged?.end ?? 0
  while (index > floor && sameLiveTail(items[index - 1], tail)) index -= 1
  if (index === floor && continuesTail) index = unchanged!.tailStart
  return { index, tail }
}

function sameTailDescriptor(left: LiveTailDescriptor, right: LiveTailDescriptor): boolean {
  return left.kind === right.kind && left.scope === right.scope &&
    left.messageId === right.messageId && left.agentId === right.agentId
}

function samePrefix(previous: readonly TraceEvent[], next: readonly TraceEvent[], length: number): boolean {
  if (previous.length !== length) return false
  for (let index = 0; index < length; index++) {
    if (previous[index] !== next[index]) return false
  }
  return true
}

/**
 * 长轮次流式渲染的增量投影：把顶层或单一父工具下「尾部还在增长的模型文本」与结构化事件分开。
 *
 * 纯文本增量时 structuralItems 保持同一个引用，下游按引用记忆的聚合（文件/Hook/逻辑调用/
 * 工具分组）就不会每批全量重算；任何插入、更正、result_superseded、replacesStreamedText
 * 或新工具调用都会让引用改变并触发一次完整重算，因此顺序、更正与分组语义不受影响。
 */
export class TurnStreamProjectionCache {
  private structuralItems: readonly TraceEvent[] = []
  private initialized = false
  private previousItems?: readonly TraceEvent[]
  private previousProjection?: TurnStreamProjection
  private tail?: LiveTailDescriptor
  private tailIndex = 0
  private tailOffsets = [0]

  project(items: readonly TraceEvent[]): TurnStreamProjection {
    if (items === this.previousItems && this.previousProjection) {
      return { ...this.previousProjection, structuralRecomputed: false }
    }
    const change = traceItemsChanges.get(items)
    const unchangedEnd = change && change.previous.deref() === this.previousItems &&
      change.firstChanged >= this.tailIndex ? change.firstChanged : undefined
    const { index: tailIndex, tail } = liveTailStart(items, unchangedEnd === undefined ? undefined : {
      end: unchangedEnd, tailStart: this.tailIndex, tail: this.tail
    })
    const retainedCount = unchangedEnd !== undefined && tail && this.tail &&
      sameTailDescriptor(tail, this.tail) && tailIndex === this.tailIndex
      ? Math.min(unchangedEnd - tailIndex, this.tailOffsets.length - 1) : 0
    const retainedLength = this.tailOffsets[retainedCount]
    let liveText = retainedCount ? this.previousProjection!.liveText.slice(0, retainedLength) : ''
    let liveThinking = retainedCount ? this.previousProjection!.liveThinking.slice(0, retainedLength) : ''
    const liveKey = tailIndex < items.length ? items[tailIndex].id : ''
    this.tailOffsets.length = retainedCount + 1
    for (let index = tailIndex + retainedCount; index < items.length; index++) {
      if (tail?.kind === 'thinking') liveThinking += items[index].thinking ?? ''
      else liveText += items[index].text ?? ''
      this.tailOffsets.push(liveText.length + liveThinking.length)
    }
    const reusable = this.initialized && tailIndex === this.structuralItems.length &&
      (unchangedEnd !== undefined || samePrefix(this.structuralItems, items, tailIndex))
    if (!reusable) {
      this.structuralItems = items.slice(0, tailIndex)
      this.initialized = true
    }
    const projection: TurnStreamProjection = {
      structuralItems: this.structuralItems,
      liveText,
      liveThinking,
      liveKey,
      ...(tail ? { liveParentToolUseId: tail.scope } : {}),
      structuralRecomputed: !reusable
    }
    this.previousItems = items
    this.previousProjection = projection
    this.tail = tail
    this.tailIndex = tailIndex
    return projection
  }
}
