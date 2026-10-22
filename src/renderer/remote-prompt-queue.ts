import type { DesktopRemoteIntent, DesktopRemoteSubmit } from '@shared/desktop-remote'
import type { AgentInputAttachment } from '@shared/runtime'

export interface RemoteQueuedPrompt {
  messageId: string
  text: string
  attachments: AgentInputAttachment[]
  request: Record<string, never>
  submission: DesktopRemoteSubmit
}
interface Queue {
  connectionId: string | null
  prompts: RemoteQueuedPrompt[]
  waitingFor?: string
  sending: boolean
  /** 正在提交的那条。跳行发送时它不一定是队首，所以必须按 id 记。 */
  claimed?: string
  paused: boolean
  writeUnknown?: boolean
}
const EMPTY: Queue = { connectionId: null, prompts: [], sending: false, paused: false }

// App-owned, so navigation cannot discard queued input or retry a claimed write.
// Unknown writes remain paused until the user removes them; never auto-resend.
export class RemotePromptQueueStore {
  private queues = new Map<string, Queue>()
  private listeners = new Set<() => void>()
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  get = (key: string): Queue => this.queues.get(key) ?? EMPTY
  private set(key: string, queue: Queue): void {
    if (!queue.prompts.length && !queue.sending) this.queues.delete(key)
    else this.queues.set(key, queue)
    for (const listener of this.listeners) listener()
  }
  enqueue(key: string, connectionId: string, submission: DesktopRemoteSubmit, waitingFor?: string): void {
    const queue = this.get(key)
    if (queue.prompts.length >= 32) throw new Error('队列最多保留 32 条消息，请先处理已有消息。')
    this.set(key, { ...queue, connectionId, waitingFor: queue.waitingFor ?? waitingFor,
      prompts: [...queue.prompts, { messageId: crypto.randomUUID(), text: submission.prompt, attachments: submission.attachments?.map(attachment => ({ ...attachment })) ?? [], request: {}, submission }] })
  }
  remove(key: string, messageId: string): void {
    const queue = this.get(key)
    // 正在提交的那条不能移除；它不一定是队首，所以按 claimed 判。
    if (queue.claimed === messageId && (queue.sending || queue.writeUnknown)) return
    this.set(key, { ...queue, prompts: queue.prompts.filter(prompt => prompt.messageId !== messageId),
      ...(queue.claimed === messageId ? { writeUnknown: false, claimed: undefined } : {}) })
  }
  settle(key: string, intentId: string): void {
    const queue = this.get(key)
    if (queue.waitingFor === intentId) this.set(key, { ...queue, waitingFor: undefined })
  }
  // 编辑中的行跳过不发：其余消息照常按 FIFO 继续，完成后再轮回到它。
  claim(key: string, skipMessageId?: string): RemoteQueuedPrompt | undefined {
    const queue = this.get(key)
    if (queue.sending || queue.paused || queue.waitingFor) return
    const target = queue.prompts.find(prompt => prompt.messageId !== skipMessageId)
    if (!target) return
    this.set(key, { ...queue, sending: true, claimed: target.messageId })
    return target
  }
  submitted(key: string, intent: DesktopRemoteIntent): void {
    const queue = this.get(key)
    this.set(key, { ...queue, prompts: queue.prompts.filter(prompt => prompt.messageId !== queue.claimed),
      sending: false, claimed: undefined, waitingFor: intent.intentId,
      paused: intent.status === 'unknown' })
  }
  // 编辑后重新排队：原位置移除，作为新意图排到队尾。换新 id，避免把旧回执审到一条新消息上。
  enqueueEdited(key: string, connectionId: string, messageId: string, submission: DesktopRemoteSubmit, waitingFor?: string): RemoteQueuedPrompt | null {
    const queue = this.get(key)
    if (!queue.prompts.some(prompt => prompt.messageId === messageId)) return null
    const next: RemoteQueuedPrompt = {
      messageId: crypto.randomUUID(),
      text: submission.prompt,
      attachments: submission.attachments?.map(attachment => ({ ...attachment })) ?? [],
      request: {},
      submission
    }
    this.set(key, { ...queue, connectionId, waitingFor: queue.waitingFor ?? waitingFor,
      prompts: [...queue.prompts.filter(prompt => prompt.messageId !== messageId), next] })
    return next
  }
  pause(key: string): void {
    const queue = this.get(key)
    if (queue.prompts.length && !queue.paused) this.set(key, { ...queue, paused: true })
  }
  pauseDisconnected(connectedIds: ReadonlySet<string>): void {
    for (const [key, queue] of this.queues) {
      if (queue.connectionId && !connectedIds.has(queue.connectionId)) this.pause(key)
    }
  }
  fail(key: string): void {
    const queue = this.get(key)
    // 保留 claimed：它就是那条结果未知的消息，移除守卫和未知提示都靠它。
    this.set(key, { ...queue, sending: false, paused: true, writeUnknown: true })
  }
  resume(key: string): void {
    const queue = this.get(key)
    if (queue.writeUnknown) return
    this.set(key, { ...queue, paused: false })
  }
  clearSession(draftKey: string): void {
    for (const key of this.queues.keys()) {
      if ((JSON.parse(key) as [string, string])[0] === draftKey) this.set(key, EMPTY)
    }
  }
  migrate(from: string, to: string, externalSessionId: string): void {
    const queue = this.queues.get(from)
    if (!queue || from === to) return
    this.queues.delete(from)
    this.set(to, { ...queue, prompts: queue.prompts.map(prompt => ({ ...prompt,
      submission: { ...prompt.submission, context: { ...prompt.submission.context, externalSessionId } }
    })) })
  }
}

export function remoteQueueKey(draftKey: string, provider: string): string {
  return JSON.stringify([draftKey, provider])
}
