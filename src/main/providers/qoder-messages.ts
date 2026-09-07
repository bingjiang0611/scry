import { normalizeSdkMessage, type NormalizeCtx } from '../normalize'
import type { TraceEvent } from '../../shared/trace'

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
  const match = text.trim().match(/^<task-notification>\s*<task-id>([^<>\r\n]+)<\/task-id>\s*<tool-use-id>([^<>\r\n]+)<\/tool-use-id>\s*(?:<output-file>[^<]*<\/output-file>\s*)?<status>([^<>\r\n]+)<\/status>\s*<summary>([^<]*)<\/summary>\s*(?:<result>[\s\S]*<\/result>\s*)?<\/task-notification>$/)
  if (!match) return undefined
  return {
    type: 'system', subtype: 'task_notification',
    task_id: match[1].trim(), tool_use_id: match[2].trim(),
    status: match[3].trim(), summary: match[4].trim()
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
