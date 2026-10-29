// Hook, Agent-task and attachment normalization: Provider evidence that is not
// model text, kept separate from SDK message normalization.

import type { TraceEvent } from '../shared/trace.js'
import { base, stringValue, type NormalizeCtx } from './normalize-core.js'

function agentTaskToolUseId(
  message: Record<string, unknown>,
  ctx: NormalizeCtx
): { toolUseId: string; taskId?: string } | undefined {
  const direct = stringValue(message.tool_use_id ?? message.toolUseId)
  const taskId = stringValue(message.task_id ?? message.taskId)
  let toolUseId: string | undefined
  if (direct) {
    if (!ctx.agentToolUseIds?.has(direct)) return undefined
    toolUseId = direct
  } else if (taskId) {
    toolUseId = ctx.agentTaskToolUseById?.get(taskId)
  }
  if (!toolUseId) return undefined
  if (taskId) (ctx.agentTaskToolUseById ??= new Map()).set(taskId, toolUseId)
  return { toolUseId, ...(taskId ? { taskId } : {}) }
}

export function normalizeAgentTaskStatus(value: unknown): 'completed' | 'failed' | 'stopped' | undefined {
  const status = stringValue(value)
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status && ['stopped', 'cancelled', 'canceled', 'interrupted', 'killed'].includes(status)) return 'stopped'
  return undefined
}

function normalizeAgentTaskMessage(
  message: Record<string, unknown>,
  ctx: NormalizeCtx,
  subtype: 'task_started' | 'task_progress' | 'task_notification'
): TraceEvent[] {
  const identity = agentTaskToolUseId(message, ctx)
  if (!identity) return []
  const source = `provider_${subtype}`
  if (subtype === 'task_notification') {
    const providerStatus = stringValue(message.status)
    const status = normalizeAgentTaskStatus(providerStatus)
    if (!status) return []
    const summary = stringValue(message.summary)
    return [base(ctx, {
      kind: 'tool',
      stage: 'tool_result',
      tool: 'Agent',
      toolUseId: identity.toolUseId,
      text: summary,
      output: summary,
      isError: status === 'failed',
      runtimeMetadata: {
        source,
        agentStatus: status,
        ...(providerStatus !== status ? { providerAgentStatus: providerStatus } : {}),
        ...(identity.taskId ? { taskId: identity.taskId } : {})
      }
    })]
  }

  const description = stringValue(message.description)
  const summary = stringValue(message.summary)
  const lastToolName = stringValue(message.last_tool_name ?? message.lastToolName)
  const subagentType = stringValue(message.subagent_type ?? message.subagentType)
  return [base(ctx, {
    kind: 'harness',
    stage: 'agent_activity',
    tool: 'Agent',
    toolUseId: identity.toolUseId,
    input: {
      activity: subtype,
      ...(identity.taskId ? { taskId: identity.taskId } : {}),
      ...(description ? { description } : {}),
      ...(summary ? { summary } : {}),
      ...(lastToolName ? { lastToolName } : {}),
      ...(subagentType ? { subagentType } : {})
    },
    runtimeMetadata: {
      source,
      agentStatus: 'running',
      ...(identity.taskId ? { taskId: identity.taskId } : {})
    }
  })]
}

export function normalizeHookMessage(m: Record<string, unknown>, ctx: NormalizeCtx): TraceEvent[] {
  const subtype = typeof m.subtype === 'string' ? m.subtype : ''
  if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_notification') {
    return normalizeAgentTaskMessage(m, ctx, subtype)
  }
  if (subtype === 'compact_boundary') {
    const rawMetadata = m.compact_metadata ?? m.compactMetadata
    const metadata = rawMetadata && typeof rawMetadata === 'object'
      ? rawMetadata as Record<string, unknown>
      : {}
    const number = (snake: string, camel: string): number | undefined => {
      const value = metadata[snake] ?? metadata[camel]
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
    }
    const trigger: 'auto' | 'manual' | undefined =
      metadata.trigger === 'auto' ? 'auto' : metadata.trigger === 'manual' ? 'manual' : undefined
    const preTokens = number('pre_tokens', 'preTokens')
    const postTokens = number('post_tokens', 'postTokens')
    const durationMs = number('duration_ms', 'durationMs')
    const compaction = {
      ...(trigger ? { trigger } : {}),
      ...(preTokens != null ? { preTokens } : {}),
      ...(postTokens != null ? { postTokens } : {}),
      ...(typeof m.uuid === 'string' ? { providerEventId: m.uuid } : {})
    }
    return [base(ctx, {
      kind: 'harness',
      stage: 'context_compaction',
      durationMs,
      compaction,
      input: compaction,
      runtimeMetadata: { source: 'provider_compact_boundary' }
    })]
  }
  if ((subtype === 'local_command_output' || subtype === 'informational') && typeof m.content === 'string') {
    return [base(ctx, {
      kind: 'model',
      stage: 'text',
      text: m.content,
      runtimeMetadata: { source: 'provider_local_command', subtype }
    })]
  }
  if (subtype !== 'hook_started' && subtype !== 'hook_progress' && subtype !== 'hook_response') return []
  const hookName = typeof m.hook_name === 'string' ? m.hook_name : 'hook'
  const hookEvent = typeof m.hook_event === 'string' ? m.hook_event : 'Hook'
  const output = typeof m.output === 'string' ? m.output : undefined
  const stdout = typeof m.stdout === 'string' ? m.stdout : undefined
  const stderr = typeof m.stderr === 'string' ? m.stderr : undefined
  const command = typeof m.command === 'string' ? m.command : undefined
  const outcome = typeof m.outcome === 'string' ? m.outcome : subtype === 'hook_started' ? 'started' : 'progress'
  const exitCode = typeof m.exit_code === 'number' ? m.exit_code : undefined
  const durationMs = typeof m.duration_ms === 'number' && Number.isFinite(m.duration_ms) && m.duration_ms >= 0
    ? m.duration_ms
    : undefined
  return [
    base(ctx, {
      kind: 'hook',
      stage: subtype,
      tool: hookName,
      name: hookEvent,
      hookId: typeof m.hook_id === 'string' ? m.hook_id : undefined,
      hookName,
      hookEvent,
      hookCommand: command,
      hookOutcome: outcome,
      hookExitCode: exitCode,
      durationMs,
      text: output || stdout || stderr,
      output,
      input: {
        hookId: m.hook_id,
        hookName,
        hookEvent,
        command,
        outcome,
        exitCode,
        sessionId: m.session_id,
        stdout,
        stderr
      },
      isError: outcome !== 'cancelled' && (outcome === 'error' || (exitCode != null && exitCode !== 0))
    })
  ]
}

function textFromAttachmentContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((x) => String(x)).join('\n\n')
  return undefined
}

export function normalizeHookAttachment(m: Record<string, unknown>, ctx: NormalizeCtx): TraceEvent[] {
  const a = m.attachment as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') return []
  const type = typeof a.type === 'string' ? a.type : ''
  if (
    type !== 'hook_success' &&
    type !== 'hook_additional_context' &&
    type !== 'hook_cancelled' &&
    type !== 'async_hook_response'
  ) return []
  const hookName = typeof a.hookName === 'string' ? a.hookName : 'hook'
  const hookEvent = typeof a.hookEvent === 'string' ? a.hookEvent : hookName.split(':')[0] || 'Hook'
  const exitCode = typeof a.exitCode === 'number' ? a.exitCode : undefined
  const stdout = typeof a.stdout === 'string' ? a.stdout : undefined
  const stderr = typeof a.stderr === 'string' ? a.stderr : undefined
  const command = typeof a.command === 'string' ? a.command : undefined
  const timedOut = typeof a.timedOut === 'boolean' ? a.timedOut : undefined
  const timeoutMs = typeof a.timeoutMs === 'number' ? a.timeoutMs : undefined
  const content = textFromAttachmentContent(a.content)
  const response = a.response && typeof a.response === 'object' ? a.response : undefined
  const outcome =
    type === 'hook_additional_context'
      ? 'progress'
      : type === 'hook_cancelled'
        ? 'cancelled'
        : exitCode != null && exitCode !== 0
          ? 'error'
          : 'success'
  const output = content || stdout || stderr || (type === 'hook_cancelled' ? 'hook cancelled' : undefined)
  return [
    base(ctx, {
      kind: 'hook',
      stage: type === 'hook_additional_context' ? 'hook_progress' : 'hook_response',
      tool: hookName,
      name: hookEvent,
      hookId: typeof a.toolUseID === 'string' ? a.toolUseID : undefined,
      hookName,
      hookEvent,
      hookCommand: command,
      hookOutcome: outcome,
      hookExitCode: exitCode,
      text: output,
      output,
      durationMs: typeof a.durationMs === 'number' ? a.durationMs : undefined,
      input: {
        hookId: a.toolUseID,
        hookName,
        hookEvent,
        outcome,
        exitCode,
        command,
        durationMs: a.durationMs,
        timedOut,
        timeoutMs,
        stdout,
        stderr,
        content,
        response
      },
      isError: outcome !== 'cancelled' && (outcome === 'error' || (exitCode != null && exitCode !== 0))
    })
  ]
}
