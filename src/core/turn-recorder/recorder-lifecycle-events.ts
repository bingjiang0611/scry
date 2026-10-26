import type { ProviderId } from '../../shared/provider.js'
import { HOOK_DELIVERY_STAGE, classifyTool, fileOpOf, parseMcp, type TraceEvent } from '../../shared/trace.js'
import { classifyDanger } from '../../main/danger.js'
import { stableHash } from './store.js'
import { captureToolContent, isFullToolContentPolicy, type ToolContentPolicy } from './tool-content.js'
import { nestedRecord, sessionIdOf, stringAt, subagentScopedPayload, timestampOf, toolInputOf, toolNameOf, toolUseIdOf, inferredSkillEvents, summarize } from './recorder-contracts.js'
import { codexToolName, isCodexSpawnTool } from './recorder-codex-calls.js'

function usageTrace(payload: Record<string, unknown>, runId: string, at: string): TraceEvent | null {
  const authoritative = nestedRecord(payload, 'usage') ?? nestedRecord(nestedRecord(payload, 'result') ?? {}, 'usage')
  const partialUsage = nestedRecord(payload, 'usage_partial')
  const usage = authoritative ?? partialUsage
  if (!usage) return null
  const number = (key: string): number | undefined => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] as number : undefined
  if (![
    'input_tokens', 'inputTokens', 'output_tokens', 'outputTokens',
    'cache_read_input_tokens', 'cacheReadTokens', 'cache_creation_input_tokens', 'cacheCreationTokens',
    'reasoning_tokens', 'reasoningTokens', 'cost_usd', 'costUsd'
  ].some((key) => number(key) !== undefined)) return null
  return {
    id: `usage-${stableHash(usage).slice(0, 16)}`,
    ts: at,
    runId,
    kind: 'harness',
    stage: 'result',
    tokensIn: number('input_tokens') ?? number('inputTokens'),
    tokensOut: number('output_tokens') ?? number('outputTokens'),
    cacheReadTokens: number('cache_read_input_tokens') ?? number('cacheReadTokens'),
    cacheCreationTokens: number('cache_creation_input_tokens') ?? number('cacheCreationTokens'),
    reasoningTokens: number('reasoning_tokens') ?? number('reasoningTokens'),
    costUsd: number('cost_usd') ?? number('costUsd'),
    ...contextUsageInput(payload),
    ...(payload.usage_complete === false || (!authoritative && partialUsage) ? { runtimeMetadata: { usageComplete: false } } : {}),
    isError: payload.error != null
  }
}

/**
 * `context_usage: { context_tokens, context_window, model, provider? }` is the integration's
 * reading of the host's own context meter at turn end. Context occupancy only means something
 * against a named model's window, so all three required fields must be present and valid;
 * anything less is dropped rather than paired with a guessed window.
 */
function contextUsageInput(payload: Record<string, unknown>): Partial<TraceEvent> {
  if (subagentScopedPayload(payload)) return {}
  const context = nestedRecord(payload, 'context_usage')
  if (!context) return {}
  const tokens = context.context_tokens
  const window = context.context_window
  const model = context.model
  const provider = context.provider
  const identifier = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$/.test(value)
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return {}
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return {}
  if (!identifier(model) || (provider !== undefined && !identifier(provider))) return {}
  return {
    contextTokens: tokens,
    contextModel: model,
    ...(provider ? { contextProvider: provider } : {}),
    contextUsageSource: 'lifecycle_context_usage',
    contextUsageQuality: 'exact',
    modelUsage: [{ model, contextWindow: window, ...(provider ? { upstreamProvider: provider } : {}) }]
  }
}


/** Recorder-owned marker set only after reading the host's own rollout metadata; never trusted from input. */
function hookDeliveryEvent(args: {
  event: string
  payload: Record<string, unknown>
  runId: string
}): TraceEvent | null {
  const hookEvent = stringAt(args.payload, 'hook_event_name', 'hookEventName')
  if (!hookEvent) return null
  const at = timestampOf(args.payload)
  const agentId = stringAt(args.payload, 'agent_id', 'agentId')
  const scope = toolUseIdOf(args.payload) ?? at
  return {
    id: `hook-delivery-${stableHash([args.event, hookEvent, agentId, scope]).slice(0, 16)}`,
    ts: at,
    runId: args.runId,
    kind: 'hook',
    stage: HOOK_DELIVERY_STAGE,
    name: hookEvent,
    hookId: `delivery:${hookEvent}:${agentId ?? ''}:${scope}`,
    hookEvent,
    ...(agentId ? { agentId } : {}),
    runtimeMetadata: { source: `recorder_hook:${args.event}` }
  }
}

interface CaptureLimitation {
  field: 'assistant_response' | 'tool_input' | 'tool_response' | 'model_segments' | 'error'
  status: 'partial' | 'unavailable'
  reason: 'byte_limit' | 'item_limit' | 'serialization_error'
}

function captureLimitations(payload: Record<string, unknown>): CaptureLimitation[] {
  const capture = payload.scry_capture
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return []
  const raw = capture as Record<string, unknown>
  if (raw.schemaVersion !== 1 || !raw.fields || typeof raw.fields !== 'object' || Array.isArray(raw.fields)) return []
  return Object.entries(raw.fields as Record<string, unknown>).flatMap(([field, value]) => {
    if (!['assistant_response', 'tool_input', 'tool_response', 'model_segments', 'error'].includes(field) || !value || typeof value !== 'object' || Array.isArray(value)) return []
    const limitation = value as Record<string, unknown>
    if (!['partial', 'unavailable'].includes(String(limitation.status)) || !['byte_limit', 'item_limit', 'serialization_error'].includes(String(limitation.reason))) return []
    return [{ field, status: limitation.status, reason: limitation.reason } as CaptureLimitation]
  })
}

function limitationMetadata(limitations: CaptureLimitation[]): { scryCaptureLimitations: CaptureLimitation[] } | undefined {
  return limitations.length > 0 ? { scryCaptureLimitations: limitations } : undefined
}

/** Exported for contract tests: payload -> trace events must stay a pure mapping. */
export function lifecycleTraceEvents(args: {
  provider: ProviderId
  event: string
  payload: Record<string, unknown>
  runId: string
  captureOutput: boolean
  toolContentPolicy?: ToolContentPolicy
}): TraceEvent[] {
  const at = timestampOf(args.payload)
  const rawToolName = toolNameOf(args.payload)
  const toolUseId = toolUseIdOf(args.payload)
  const rawInput = toolInputOf(args.payload)
  const agentCall = args.provider === 'codex' && isCodexSpawnTool(rawToolName ?? '')
    ? codexToolName(rawToolName!, rawInput)
    : null
  const toolName = agentCall?.tool ?? rawToolName
  const input = agentCall?.input ?? rawInput
  const limitations = captureLimitations(args.payload)
  const agentId = stringAt(args.payload, 'agent_id', 'agentId')
  const out: TraceEvent[] = []
  const delivery = hookDeliveryEvent(args)
  if (delivery) out.push(delivery)
  if (args.event === 'session.compacted' || args.event === 'session.next.compaction.ended') {
    const providerEventId = stringAt(args.payload, 'messageID', 'messageId', 'id')
    const trigger: 'auto' | 'manual' | undefined =
      args.payload.reason === 'auto' ? 'auto' : args.payload.reason === 'manual' ? 'manual' : undefined
    const compaction = {
      ...(trigger ? { trigger } : {}),
      ...(providerEventId ? { providerEventId } : {})
    }
    out.push({
      id: `compaction-${providerEventId ?? stableHash([args.event, args.payload]).slice(0, 16)}`,
      ts: at,
      runId: args.runId,
      kind: 'harness',
      stage: 'context_compaction',
      compaction,
      input: compaction,
      runtimeMetadata: { source: `recorder_hook:${args.event}` }
    })
  } else if (/^PreToolUse(?::|$)/.test(args.event) || args.event === 'tool.execute.before') {
    if (toolName) {
      const cls = classifyTool(toolName, input)
      const mcp = parseMcp(toolName, input)
      const file = fileOpOf(toolName, input)
      const danger = classifyDanger(toolName, input)
      out.push(...inferredSkillEvents(toolName, input, args.runId, at, toolUseId))
      out.push({
        id: toolUseId ?? `tool-${stableHash([args.event, args.payload]).slice(0, 16)}`,
        ts: at,
        runId: args.runId,
        kind: cls.kind,
        stage: `${cls.kind}:${cls.name}`,
        tool: toolName,
        name: cls.name,
        toolUseId,
        ...(agentId ? { agentId } : {}),
        input,
        ...(isFullToolContentPolicy(args.toolContentPolicy) ? {
          inputContent: captureToolContent(args.payload[['tool_input', 'toolInput', 'input'].find((key) => key in args.payload) ?? 'tool_input'], {
            source: 'lifecycle_hook', maxBytes: null,
            ...(limitations.some((item) => item.field === 'tool_input') ? { sourceCompleteness: 'partial', reasons: ['source_truncated'] } : {})
          })
        } : {}),
        ...mcp,
        ...file,
        ...(danger ? { danger } : {}),
        ...(limitationMetadata(limitations.filter((item) => item.field === 'tool_input'))
          ? { runtimeMetadata: limitationMetadata(limitations.filter((item) => item.field === 'tool_input')) }
          : {})
      })
    }
  } else if (/^PostToolUse(?:Failure)?(?::|$)/.test(args.event) || args.event === 'tool.execute.after') {
    const failed = /Failure/.test(args.event) || args.payload.error != null || args.payload.is_error === true
    const result = isFullToolContentPolicy(args.toolContentPolicy)
      ? args.payload[['tool_response', 'toolResponse', 'output', 'result', 'error'].find((key) => key in args.payload) ?? 'tool_response']
      : args.payload.tool_response ?? args.payload.toolResponse ?? args.payload.output ?? args.payload.result ?? args.payload.error
    out.push({
      id: `result-${toolUseId ?? stableHash([args.event, args.payload]).slice(0, 16)}`,
      ts: at,
      runId: args.runId,
      kind: 'tool',
      stage: 'tool_result',
      tool: toolName,
      toolUseId,
      ...(agentId ? { agentId } : {}),
      ...(isFullToolContentPolicy(args.toolContentPolicy)
        ? { outputContent: captureToolContent(result, {
            source: 'lifecycle_hook', maxBytes: null,
            ...(limitations.some((item) => item.field === 'tool_response') ? { sourceCompleteness: 'partial', reasons: ['source_truncated'] } : {})
          }) }
        : args.captureOutput ? { text: summarize(result), output: summarize(result) } : {}),
      isError: failed,
      ...(limitationMetadata(limitations.filter((item) => item.field === 'tool_response'))
        ? { runtimeMetadata: limitationMetadata(limitations.filter((item) => item.field === 'tool_response')) }
        : {})
    })
  }
  const usage = usageTrace(args.payload, args.runId, at)
  if (usage) out.push(usage)
  if (!subagentScopedPayload(args.payload) && 'model_ids' in args.payload) {
    const ids = args.payload.model_ids
    const valid = Array.isArray(ids) && ids.length <= 64 && ids.every((id) =>
      typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$/.test(id))
    out.push({
      id: `provider-model-${stableHash([ids, args.payload.model_ids_complete]).slice(0, 16)}`,
      ts: at, runId: args.runId, kind: 'harness', stage: 'provider_model',
      runtimeMetadata: { modelIds: valid ? [...new Set(ids)] : [], complete: valid && args.payload.model_ids_complete === true }
    })
  }
  if (!subagentScopedPayload(args.payload) && 'turn_role' in args.payload) {
    // Same contract shape as `task_context`: an explicit, bounded, host-supplied
    // structure or nothing. There is deliberately no text heuristic here — a
    // fixed approval-history prefix is a diagnostic, not an identity.
    const role = nestedRecord(args.payload, 'turn_role')
    const bounded = (value: unknown, max: number) =>
      typeof value === 'string' && new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,${max}}$`).test(value)
    const valid = !!role && role.session_id === sessionIdOf(args.payload) &&
      bounded(role.role, 127) && bounded(role.source, 127) &&
      (role.parent_id === undefined || bounded(role.parent_id, 127)) &&
      (role.reviewed_session_id === undefined || bounded(role.reviewed_session_id, 127))
    out.push({
      id: `turn-role-${stableHash(valid ? role : 'invalid').slice(0, 16)}`,
      ts: at, runId: args.runId, kind: 'harness', stage: 'turn_role',
      runtimeMetadata: valid && role ? {
        role: role.role, roleSource: role.source,
        ...(role.parent_id !== undefined ? { roleParentId: role.parent_id } : {}),
        ...(role.reviewed_session_id !== undefined ? { reviewedSessionId: role.reviewed_session_id } : {})
      } : { invalid: true }
    })
  }
  if (!subagentScopedPayload(args.payload) && 'task_context' in args.payload) {
    const context = nestedRecord(args.payload, 'task_context')
    const valid = context && context.session_id === sessionIdOf(args.payload) &&
      typeof context.task_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(context.task_id) &&
      typeof context.task_generation === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(context.task_generation) &&
      typeof context.turn_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(context.turn_id)
    out.push({
      id: `task-context-${stableHash(valid ? context : 'invalid').slice(0, 16)}`,
      ts: at, runId: args.runId, kind: 'harness', stage: 'task_context',
      runtimeMetadata: valid ? {
        taskId: context.task_id, taskGeneration: context.task_generation, taskTurnId: context.turn_id
      } : { invalid: true }
    })
  }
  const providerError = args.provider === 'pi' && args.event === 'Stop' ? stringAt(args.payload, 'error') : undefined
  if (providerError) out.push({
    id: `pi-error-${stableHash([args.runId, providerError]).slice(0, 16)}`,
    ts: at,
    runId: args.runId,
    kind: 'harness',
    stage: 'task_error',
    text: providerError,
    isError: true,
    runtimeMetadata: limitationMetadata(limitations.filter((item) => item.field === 'error'))
  })
  const assistant = stringAt(args.payload, 'assistant_response', 'assistantResponse', 'result_text')
  if (assistant) out.push({
    id: `assistant-${stableHash(assistant).slice(0, 16)}`,
    ts: at,
    runId: args.runId,
    kind: 'model',
    stage: 'text',
    text: assistant,
    ...(limitationMetadata(limitations.filter((item) => item.field === 'assistant_response'))
      ? { runtimeMetadata: limitationMetadata(limitations.filter((item) => item.field === 'assistant_response')) }
      : {})
  })
  const rawSegments = args.payload.model_segments ?? args.payload.modelSegments
  if (Array.isArray(rawSegments)) {
    const segmentLimitations = limitations.filter((item) => item.field === 'model_segments')
    if (segmentLimitations.length > 0) {
      out.push({
        id: `capture-limit-${stableHash([args.event, segmentLimitations]).slice(0, 16)}`,
        ts: at,
        runId: args.runId,
        kind: 'harness',
        stage: 'capture_limitation',
        runtimeMetadata: limitationMetadata(segmentLimitations)
      })
    }
    for (const raw of rawSegments) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const segment = raw as Record<string, unknown>
      const completedAt = stringAt(segment, 'completed_at', 'completedAt', 'timestamp')
      const duration = segment.duration_ms ?? segment.durationMs
      if (!completedAt || !Number.isFinite(Date.parse(completedAt)) || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) continue
      const responseId = stringAt(segment, 'response_id', 'responseId', 'id')
      out.push({
        id: `model-response-${responseId ?? stableHash(segment).slice(0, 16)}`,
        ts: new Date(completedAt).toISOString(),
        runId: args.runId,
        kind: 'model',
        stage: 'response_completed',
        ...(responseId ? { messageId: responseId } : {}),
        durationMs: Math.round(duration)
      })
    }
  }
  return out
}
