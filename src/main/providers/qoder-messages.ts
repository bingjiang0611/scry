import { normalizeSdkMessage, type NormalizeCtx } from '../normalize'
import type { TraceEvent } from '../../shared/trace'
import type { BackgroundTask } from '../../shared/background-work'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

interface TaskNotification {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  tool_use_id: string
  status: string
  summary: string
}

function textNotification(raw: Record<string, unknown>): TaskNotification | undefined {
  // Qoder 1.1.41 delivers queued task completions as synthetic user text, not
  // system/task_notification. Never interpret tool output or a human echo as
  // lifecycle evidence, and never read the notification's output-file path.
  if (raw.type !== 'user' || raw.isSynthetic !== true) return undefined
  const content = record(raw.message).content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) && content.length === 1 && record(content[0]).type === 'text'
      ? record(content[0]).text
      : undefined
  if (typeof text !== 'string') return undefined
  // Match the header, not tags inside the free-form result. Missing, duplicate
  // or malformed identity/status fields must not close an unrelated Agent.
  const notificationText = text.trim().replace(/^\[SYSTEM NOTIFICATION - NOT USER INPUT\]\nThis is an automated background-task event, NOT a message from the user\.\nDo NOT interpret this as user acknowledgement, confirmation, or response to any pending question\.\s*/, '')
  const match = notificationText.match(/^<task-notification>\s*<task-id>([^<>\r\n]+)<\/task-id>\s*<tool-use-id>([^<>\r\n]+)<\/tool-use-id>\s*(?:<output-file>[^<]*<\/output-file>\s*)?<status>([^<>\r\n]+)<\/status>\s*<summary>([^<]*)<\/summary>\s*(?:<result>[\s\S]*<\/result>\s*)?<\/task-notification>$/)
  if (!match) return undefined
  return {
    type: 'system', subtype: 'task_notification',
    task_id: match[1].trim(), tool_use_id: match[2].trim(),
    status: match[3].trim(), summary: match[4].trim()
  }
}

// Closing SDK prompt input also closes CLI control-response stdin. A background
// Bash launch receipt is not completion: its notification can start another LLM
// turn (and get_model_policy / permission requests) after the first root result.
export class QoderBackgroundTasks {
  private calls = new Map<string, { tool: 'Bash' | 'Agent'; description: string }>()
  private active = new Map<string, BackgroundTask>()
  private terminalCalls = new Set<string>()

  get pending(): boolean { return this.active.size > 0 }
  get tasks(): BackgroundTask[] { return [...this.active.values()].map((task) => ({ ...task })) }
  has(taskId: string): boolean { return this.active.has(taskId) }
  markStop(taskId: string, stopState: BackgroundTask['stopState']): void {
    const task = this.active.get(taskId)
    if (task) task.stopState = stopState
  }

  private launch(taskId: string, toolUseId: string): void {
    const call = this.calls.get(toolUseId)
    if (!call || this.terminalCalls.has(toolUseId) || this.active.has(taskId)) return
    this.active.set(taskId, { taskId, toolUseId, ...call, observedAt: Date.now() })
  }

  observe(message: unknown): void {
    const raw = record(message)
    if (raw.parent_tool_use_id || raw.isReplay === true) return
    const content = record(raw.message).content
    if (raw.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        const item = record(block)
        if (item.type === 'tool_use' && ['Bash', 'Agent', 'local_agent'].includes(String(item.name)) && typeof item.id === 'string') {
          const input = record(item.input)
          this.calls.set(item.id, {
            tool: item.name === 'Bash' ? 'Bash' : 'Agent',
            description: String(input.description ?? input.command ?? item.name).slice(0, 400)
          })
        }
      }
    }
    if (raw.type === 'user' && Array.isArray(content)) {
      const result = record(raw.tool_use_result)
      const blocks = content.map(record).filter((item) => item.type === 'tool_result')
      // Only a structured launch receipt establishes a background task. Tool
      // output mentioning task IDs (or run_in_background intent) is not proof.
      if ((result.kind === 'backgrounded' || result.status === 'async_launched') && typeof result.taskId === 'string' && result.taskId && blocks.length === 1) {
        const id = blocks[0].tool_use_id
        if (typeof id === 'string') this.launch(result.taskId, id)
      }
    }
    if (raw.type === 'system' && raw.subtype === 'task_started' &&
        typeof raw.task_id === 'string' && typeof raw.tool_use_id === 'string') {
      this.launch(raw.task_id, raw.tool_use_id)
    }
    const notification = textNotification(raw)
    const update = raw.type === 'system' && raw.subtype === 'task_updated' && typeof raw.task_id === 'string' &&
      this.active.get(raw.task_id)?.tool === 'Agent'
      ? { task_id: raw.task_id, status: record(raw.patch).status, tool_use_id: undefined } : undefined
    const terminal = notification ?? update ?? (raw.type === 'system' && raw.subtype === 'task_notification' ? raw : undefined)
    // Agent task_updated is already a terminal in Qoder's Agent projection.
    // Bash must wait for the notification that triggers its follow-up model turn.
    if (!terminal || typeof terminal.task_id !== 'string') return
    const task = this.active.get(terminal.task_id)
    if (!task || (terminal.tool_use_id !== undefined && terminal.tool_use_id !== task.toolUseId)) return
    if (!['completed', 'failed', 'stopped'].includes(String(terminal.status))) return
    this.active.delete(terminal.task_id)
    this.terminalCalls.add(task.toolUseId)
  }
}

export function normalizeQoderMessage(message: unknown, ctx: NormalizeCtx): TraceEvent[] {
  const raw = record(message)
  let normalized: unknown = message
  let source: string | undefined
  if (!raw.parent_tool_use_id && raw.isReplay !== true) {
    const notification = textNotification(raw)
    if (notification) {
      const knownTool = ctx.agentTaskToolUseById?.get(notification.task_id)
      if (knownTool && knownTool !== notification.tool_use_id) return []
      normalized = notification
      source = 'qoder_task_notification_text'
    } else if (raw.type === 'system' && raw.subtype === 'task_updated') {
      // Updates use task_id only. The shared normalizer requires an alias from
      // an observed Agent launch/start, so Bash tasks and unknown IDs stay out.
      normalized = {
        type: 'system', subtype: 'task_notification', task_id: raw.task_id,
        status: record(raw.patch).status, summary: record(raw.patch).error
      }
      source = 'qoder_task_updated'
    }
  }
  if (raw.type === 'assistant') {
    const assistant = record(raw.message)
    if (Array.isArray(assistant.content)) {
      normalized = {
        ...raw,
        message: {
          ...assistant,
          content: assistant.content.map((block: unknown) => {
            const item = record(block)
            return item.type === 'tool_use' && item.name === 'local_agent' ? { ...item, name: 'Agent' } : block
          })
        }
      }
    }
  }
  const events = normalizeSdkMessage(normalized, ctx)
  return source ? events.map((event) => ({ ...event, runtimeMetadata: { ...event.runtimeMetadata, source } })) : events
}
