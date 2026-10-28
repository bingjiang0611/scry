import type { WorkflowLiveObservation } from '../shared/workflow'
import type { NormalizeCtx } from './normalize'

export function nativeClaudeWorkflowObservation(message: Record<string, unknown>): WorkflowLiveObservation | undefined {
  if (message.type !== 'stream_event' || message.parent_tool_use_id !== null) return undefined
  const event = message.event
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined
  const eventRecord = event as Record<string, unknown>
  if (eventRecord.type !== 'content_block_delta') return undefined
  const delta = eventRecord.delta
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return undefined
  const deltaRecord = delta as Record<string, unknown>
  if (deltaRecord.type === 'text_delta' && typeof deltaRecord.text === 'string' && deltaRecord.text.length > 0) {
    return { source: 'claude_native', kind: 'model_progress', channel: 'text' }
  }
  if (deltaRecord.type === 'thinking_delta' && typeof deltaRecord.thinking === 'string' && deltaRecord.thinking.length > 0) {
    return { source: 'claude_native', kind: 'model_progress', channel: 'thinking' }
  }
  return undefined
}

export function nativeClaudeToolActivity(
  message: Record<string, unknown>,
  sessionId: string | undefined,
  ctx: NormalizeCtx
): WorkflowLiveObservation | undefined {
  if (message.type !== 'tool_progress' || message.parent_tool_use_id !== null || message.isReplay === true || typeof sessionId !== 'string') return undefined
  if (typeof message.session_id !== 'string' || message.session_id !== sessionId) return undefined
  const toolUseId = message.tool_use_id
  if (typeof toolUseId !== 'string' || !toolUseId) return undefined
  const started = ctx.toolUseById?.get(toolUseId)
  if (!started || started.parentToolUseId !== null) return undefined
  return { source: 'claude_native', kind: 'tool_activity', toolCallId: toolUseId }
}

export function nativeClaudeToolReturnMessage(message: Record<string, unknown>, sessionId: string | undefined): boolean {
  if (message.type !== 'user' || message.parent_tool_use_id !== null || message.isReplay === true) return false
  // SDK user messages may omit session_id. This fresh query and an already
  // observed call ID scope the return; a present foreign session never does.
  return message.session_id === undefined || (typeof message.session_id === 'string' && message.session_id === sessionId)
}
