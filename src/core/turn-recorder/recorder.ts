import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { open as openFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { HOOK_DELIVERY_STAGE, classifyTool, fileOpOf, parseMcp, type TraceEvent } from '../../shared/trace.js'
import {
  available,
  disabled,
  partial,
  unavailable,
  type AgentTurnRecord,
  type Evidence,
  type TurnEndReason,
  type TurnEvidence,
  type TurnModelSource,
  type TurnModelStatus,
  type TurnTermination
} from '../../shared/turn-record.js'
import { classifyDanger } from '../../main/danger.js'
import { parseTranscriptToTurns } from '../../main/normalize.js'
import { aggregateTurnEvidence } from './aggregate.js'
import { creditUsageEvidence } from '../../shared/credit-usage.js'
import { qoderCreditRequests } from '../../shared/qoder-credit-requests.js'
import { CodexUsageDeltaFilter } from '../../shared/usage-dedupe.js'
import { captureToolContent, isFullToolContentPolicy, persistModelEventContent, persistToolEventContent, type ToolContentPolicy } from './tool-content.js'
import { writeRecorderContent } from './content-store.js'
import { turnChangeHints } from './change-journal.js'
import { commitHookEnv, resolveCommitHookActivation } from './commit-hook-grant.js'
import { recordProviderActivity } from './provider-activity.js'
import { recordInvalidHookConfig } from './hook-diagnostics.js'
import { discoverRepositories, resolveRecorderEnablement, type RecorderEnablement } from './config.js'
import { beginGitTurnDiff, cancelGitTurnDiff, finishGitTurnDiff, limitTurnDiffPatchBytes } from './git.js'
import { appendRotatingLog, listFiles, readJson, writeJsonAtomic } from './io.js'
import { recoverManagedRecorderTurns } from './managed.js'
import { INBOX_MAX_ATTEMPTS, quarantineInboxEntry, readInboxFailure, readInboxJson, recorderInboxEntries } from './inbox.js'
import {
  HOOK_LOCK_WAIT_MS,
  SESSION_LOCK_WAIT_MS,
  recorderOpenPath as openPath,
  recorderPendingHealth,
  withRecorderSessionLock,
  withRecorderSessionKeyLock,
  recorderSessionRoot as sessionRoot,
  recorderStatePath as statePath,
  recorderTurnRoot as turnRoot,
  type RecorderOpenTurnState as OpenTurnState,
  type RecorderSessionState as SessionState
} from './runtime-state.js'
import {
  HOOK_DRAIN_BUDGET_MS,
  HOOK_DRAIN_MAX_RECORDS,
  RECORDER_VERSION,
  clearRuntimeTurn,
  commitRecord,
  drainCommitNotifications,
  listRecords,
  recordError,
  findRecordById,
  stableHash,
  safeKey,
  updateHealth
} from './store.js'

export interface RecorderHookInput {
  provider: ProviderId
  event: string
  workspace: string
  payload: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  managed?: boolean
  /**
   * Skip commit-hook delivery so a long-lived caller can run it after answering the Provider.
   * Recording is what the hook must wait for; waking an external uploader is not, and its budget
   * is paid on every event. Only a caller that outlives the response may set this — a one-shot CLI
   * process would drop the delivery entirely.
   */
  deferDelivery?: boolean
}

export interface RecorderHookResult {
  status: 'disabled' | 'ignored' | 'started' | 'recorded' | 'committed' | 'duplicate' | 'pending' | 'orphan'
  reason?: string
  record?: AgentTurnRecord
}

export type RecorderRecoveryProbe = (open: Readonly<OpenTurnState>) => Promise<void> | void

interface StoredLifecycleEvent {
  schemaVersion: 1
  id: string
  event: string
  observedAt: string
  traceEvents: TraceEvent[]
  transcriptPath?: string
}

interface TranscriptRead {
  stable: boolean
  source?: {
    content: string
    sourcePath: string
    startOffset: number
    endOffset: number
    identity: TranscriptSnapshotIdentity
    sourceCompleteness: 'complete' | 'partial'
  }
  observed: boolean
  identityMatched?: boolean
  complete?: boolean
  terminalStatus?: AgentTurnRecord['status']
  completedAt?: string
  startedAt?: string
  durationMs?: number
  toolStreamComplete?: boolean
  userText?: string
  events: TraceEvent[]
  observable: {
    tools: boolean
    skills: boolean
    mcps: boolean
    hooks: boolean
    usage: boolean
    files: boolean
    errors: boolean
  }
}

const START_EVENTS = new Set(['UserPromptSubmit', 'chat.message', 'turn.started'])
const END_EVENTS = new Set(['Stop', 'session.idle', 'session.stop', 'turn/completed', 'turn.completed'])
// These Provider Stop contracts expose the same-turn continuation flag; do not infer parity.
const STOP_HOOK_ACTIVE_PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'qoder'])
/**
 * The session or process ended, so an open turn stops here: it cannot converge, and waiting only
 * lets a later prompt look like this turn's end. It is not a normal terminal — nothing proves the
 * Agent finished its work — so the turn keeps its interrupted verdict.
 */
const SESSION_END_EVENTS = new Set(['SessionEnd', 'session.end', 'session_end', 'session.exited', 'process.exit'])
/** A Provider clock ahead of ours is normal; minutes of "future" end time are not. */
const TERMINAL_CLOCK_SKEW_MS = 60_000
const STALE_TERMINAL_PROVIDERS = new Set<ProviderId>(['qoder', 'opencode'])
const STALE_TERMINAL_WINDOW_MS = 30_000
const DEFERRED_TERMINAL_GRACE_MS = 180_000
/**
 * Staleness diagnostic for open turns, and finalization grace for already-terminal closing turns.
 * Silence alone never proves an open Agent turn has ended; doctor warns without fabricating a stop.
 */
export const OPEN_TURN_EXPIRY_MS = 24 * 60 * 60 * 1_000

function stringAt(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function nestedRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = payload[key]
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

interface ModelIdentity {
  model?: string
  status: TurnModelStatus
  source?: TurnModelSource
  omissionReason?: string
}

/**
 * Decide what the record may claim about the model.
 *
 * The rules are deliberately narrow: a single complete provider observation is
 * fact, a billed usage model is fact with weaker provenance, and everything
 * else is an explicit gap. Reporting several ids in one turn is a conflict to
 * surface, not something to resolve by picking one.
 */
export function resolveModelIdentity(
  modelEvents: TraceEvent[],
  models: Set<string>,
  usageModel: string | undefined
): ModelIdentity {
  if (modelEvents.length > 0) {
    const complete = modelEvents.every((event) => event.runtimeMetadata?.complete === true)
    if (models.size > 1) {
      return {
        status: 'conflict',
        omissionReason: `provider reported ${models.size} distinct model ids in one turn ` +
          `(${[...models].sort().slice(0, 3).map((id) => id.slice(0, 64)).join(', ')})`
      }
    }
    if (complete && models.size === 1) {
      return { model: [...models][0], status: 'observed', source: 'provider_model_event' }
    }
    return {
      status: 'incomplete',
      omissionReason: models.size === 0
        ? 'provider model observation carried no usable model id'
        : 'provider model observation was marked incomplete'
    }
  }
  if (typeof usageModel === 'string' && usageModel.length > 0) {
    // A usage counter names the model that was billed. That is an observation,
    // but not the same provenance as a provider model event, so it is labelled.
    return { model: usageModel, status: 'observed', source: 'usage_event' }
  }
  return {
    status: 'unobserved',
    omissionReason: 'provider exposed no model id to lifecycle hooks or usage events'
  }
}

function sessionIdOf(payload: Record<string, unknown>): string | undefined {
  const direct = stringAt(payload, 'session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId')
  if (direct) return direct
  const session = nestedRecord(payload, 'session')
  if (session) return stringAt(session, 'id', 'session_id', 'sessionId')
  const transcript = transcriptPathOf(payload)
  return transcript ? basename(transcript).replace(/\.(jsonl|json)$/i, '') : undefined
}

function transcriptPathOf(payload: Record<string, unknown>): string | undefined {
  return stringAt(payload, 'transcript_path', 'transcriptPath', 'rollout_path', 'rolloutPath')
}

function promptOf(payload: Record<string, unknown>): string | undefined {
  const direct = stringAt(payload, 'prompt', 'user_prompt', 'userPrompt', 'text')
  if (direct) return direct
  const rawQoder = nestedRecord(payload, 'raw_qoder_payload')
  if (rawQoder) {
    const rawPrompt = stringAt(rawQoder, 'prompt', 'user_prompt', 'userPrompt', 'text')
    if (rawPrompt) return rawPrompt
  }
  const message = payload.message
  if (typeof message === 'string' && message.trim()) return message
  const messageRecord = nestedRecord(payload, 'message')
  return messageRecord ? stringAt(messageRecord, 'text', 'content', 'prompt') : undefined
}

function explicitTimestampOf(payload: Record<string, unknown>): string | undefined {
  const value = stringAt(payload, 'timestamp', 'ts', 'created_at', 'createdAt') ??
    stringAt(nestedRecord(payload, 'raw_qoder_payload') ?? {}, 'timestamp', 'ts', 'created_at', 'createdAt')
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
}

/** Arrival time of the hook being applied; a queued hook replays with the time it actually arrived. */
const hookArrival = new AsyncLocalStorage<string>()

function observedNow(): string {
  return hookArrival.getStore() ?? new Date().toISOString()
}

function timestampOf(payload: Record<string, unknown>): string {
  return explicitTimestampOf(payload) ?? observedNow()
}

function startFingerprintOf(provider: ProviderId, event: string, payload: Record<string, unknown>): string {
  const canonicalPayload = provider === 'qoder'
    ? nestedRecord(payload, 'raw_qoder_payload') ?? payload
    : payload
  return stableHash({ event, payload: canonicalPayload })
}

function epochSecondsAt(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
    const millis = Math.round(value * 1_000)
    const date = new Date(millis)
    if (Number.isFinite(date.getTime())) return date.toISOString()
  }
  return undefined
}

function summarize(value: unknown, max = 500): string | undefined {
  if (value == null) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function toolNameOf(payload: Record<string, unknown>): string | undefined {
  return stringAt(payload, 'tool_name', 'toolName', 'name') ?? stringAt(nestedRecord(payload, 'tool') ?? {}, 'name')
}

function toolInputOf(payload: Record<string, unknown>): Record<string, unknown> {
  return (nestedRecord(payload, 'tool_input') ?? nestedRecord(payload, 'toolInput') ?? nestedRecord(payload, 'input') ?? {})
}

function toolUseIdOf(payload: Record<string, unknown>): string | undefined {
  return stringAt(payload, 'tool_use_id', 'toolUseId', 'call_id', 'callId', 'id')
}

function providerTurnIdOf(payload: Record<string, unknown>, provider?: ProviderId): string | undefined {
  const qoderPromptId = stringAt(payload, 'prompt_id', 'promptId')
    ?? stringAt(nestedRecord(payload, 'raw_qoder_payload') ?? {}, 'prompt_id', 'promptId')
  if (provider === 'claude') {
    return qoderPromptId
      ?? stringAt(payload, 'prompt_event_id', 'promptEventId')
      ?? stringAt(payload, 'turn_id', 'turnId')
      ?? stringAt(nestedRecord(payload, 'task') ?? {}, 'turn_id', 'turnId', 'id')
  }
  if (qoderPromptId || provider === 'qoder') return qoderPromptId
  return stringAt(payload, 'turn_id', 'turnId')
    ?? stringAt(nestedRecord(payload, 'task') ?? {}, 'turn_id', 'turnId', 'id')
}

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

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, out))
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((item) => stringsIn(item, out))
  return out
}

function inferredSkillEvents(
  _toolName: string,
  input: Record<string, unknown>,
  runId: string,
  at: string,
  toolUseId?: string
): TraceEvent[] {
  const candidates = stringsIn(input)
  const names = new Set<string>()
  for (const candidate of candidates) {
    // 只有真正读取 skill 入口文件才算调用证据；仅 rg 某个 skill 目录或引用其 references
    // 不能证明 agent 使用了该 skill，否则会把代码搜索误报成 Skill 调用。
    const pattern = /(?:^|[/\s"'`])(?:\.(?:claude|codex|agents)\/)?skills\/([^/\s"'`]+)\/SKILL\.md/g
    for (const match of candidate.matchAll(pattern)) if (match[1]) names.add(match[1])
  }
  return [...names].map((name) => ({
    id: `skill-${stableHash(`${name}\0${toolUseId ?? at}`).slice(0, 16)}`,
    ts: at,
    runId,
    kind: 'skill' as const,
    stage: `skill:${name}`,
    tool: 'Skill',
    name,
    toolUseId,
    input: { source: 'skill_path_in_command' }
  }))
}

/** Recorder-owned marker set only after reading the host's own rollout metadata; never trusted from input. */
const CODEX_SUBAGENT_MARKER = 'scry_codex_subagent_transcript'

export function subagentScopedPayload(payload: Record<string, unknown>): boolean {
  return !!(
    payload[CODEX_SUBAGENT_MARKER] === true ||
    stringAt(payload, 'agent_id', 'agentId') ||
    stringAt(payload, 'agent_type', 'agentType') ||
    stringAt(payload, 'agent_transcript_path', 'agentTranscriptPath')
  )
}

/**
 * 被投递的 hook 事件本身就是「provider 执行过该 hook 事件链」的一等证据：recorder 正是被它调起来的。
 * 但 Codex / Claude 的 hook 载荷不带被执行脚本的 command、exit code 和 outcome，所以这里只落 hook 事件名
 * 与投递时刻，交由 `aggregateHooks` 归并成「事件 + 投递次数」，禁止伪造脚本身份或成功状态。
 */
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

interface ParsedTranscriptTurn {
  providerTurnId?: string
  userText: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  terminalStatus?: AgentTurnRecord['status']
  events: TraceEvent[]
  observable: TranscriptRead['observable']
  childThreads: Array<{ sessionId: string; parentToolUseId?: string; name?: string }>
  pendingToolCalls: Set<string>
}

function callInput(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.arguments ?? payload.input
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Custom Codex tools may persist their JavaScript source verbatim.
  }
  return { raw }
}

interface NormalizedCodexCall {
  tool: string
  input: Record<string, unknown>
  suffix?: string
}

function balancedCallArgument(source: string, openIndex: number): string | undefined {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(' || char === '{' || char === '[') depth++
    else if (char === ')' || char === '}' || char === ']') {
      depth--
      if (depth === 0) return source.slice(openIndex + 1, index).trim()
    }
  }
  return undefined
}

function literalArgument(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    if (typeof parsed === 'string') return { raw: parsed }
  } catch {
    // JavaScript variables/expressions are still useful as bounded evidence, but are not evaluated.
  }
  return { raw: value }
}

function isCodexSpawnTool(name: string): boolean {
  // Only the native namespace is an alias; MCP and unknown namespaces retain their identity.
  return name === 'spawn_agent' || name === 'multi_agent_v1__spawn_agent'
}

function codexToolName(name: string, input: Record<string, unknown>): NormalizedCodexCall | null {
  if (name === 'wait' || name === 'write_stdin') return null
  if (['list_agents', 'send_message', 'followup_task', 'interrupt_agent'].includes(name)) return null
  if (name === 'wait_agent') {
    const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined
    if (timeoutMs != null && timeoutMs < 5_000) return null
    return { tool: 'collaboration:wait', input }
  }
  if (name === 'exec_command') {
    const command = typeof input.cmd === 'string' ? input.cmd : typeof input.command === 'string' ? input.command : undefined
    return {
      tool: 'Bash',
      input: {
        ...(command ? { command } : {}),
        ...(typeof input.workdir === 'string' ? { cwd: input.workdir } : {}),
        ...(typeof input.yield_time_ms === 'number' ? { yieldTimeMs: input.yield_time_ms } : {})
      }
    }
  }
  if (name === 'apply_patch') {
    return { tool: 'Edit', input: { patch: input.raw ?? input.patch ?? input } }
  }
  if (isCodexSpawnTool(name)) {
    return {
      tool: 'Agent',
      input: {
        ...input,
        subagent_type: input.task_name ?? input.taskName,
        description: input.task_name ?? input.taskName
      }
    }
  }
  const collaboration = /^collaboration[._:-](.+)$/.exec(name)?.[1] ?? (
    name === 'wait_agent' ? name : undefined
  )
  if (collaboration) {
    const camel = collaboration.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase())
    return { tool: `collaboration:${camel}`, input }
  }
  if (name === 'update_plan') return { tool: 'update_plan', input }
  return { tool: name, input }
}

function staticCommandMaps(source: string): Map<number, NormalizedCodexCall[]> {
  const arrays = new Map<string, string[]>()
  const arrayPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g
  for (const match of source.matchAll(arrayPattern)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1
    const content = balancedCallArgument(source, openIndex)
    if (content == null) continue
    try {
      const values = JSON.parse(`[${content}]`) as unknown
      if (Array.isArray(values) && values.every((value) => typeof value === 'string')) arrays.set(match[1], values)
      else if (
        Array.isArray(values) &&
        values.every((value) => Array.isArray(value) && typeof value[0] === 'string')
      ) {
        arrays.set(match[1], values.map((value) => value[0] as string))
      }
    } catch {
      // Only literal string arrays are safe to expand without evaluating JavaScript.
    }
  }

  const expansions = new Map<number, NormalizedCodexCall[]>()
  const mapPattern = /\b([A-Za-z_$][\w$]*)\.map\(\s*(?:\(\s*\[\s*([A-Za-z_$][\w$]*)[^\]]*\]\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*tools\.exec_command\s*\(/g
  for (const match of source.matchAll(mapPattern)) {
    const commands = arrays.get(match[1])
    if (!commands) continue
    const commandVariable = match[2] ?? match[3]
    const openIndex = (match.index ?? 0) + match[0].length - 1
    const argument = balancedCallArgument(source, openIndex)
    if (!argument || !commandVariable || !new RegExp(`(?:^|[{,]\\s*)${commandVariable}(?:\\s*[,}])`).test(argument)) continue
    const common: Record<string, unknown> = {}
    for (const key of ['workdir'] as const) {
      const value = new RegExp(`\\b${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(argument)?.[1]
      if (value) {
        try {
          common[key] = JSON.parse(value) as string
        } catch {
          // Ignore malformed optional metadata; the command remains authoritative.
        }
      }
    }
    for (const key of ['yield_time_ms', 'max_output_tokens'] as const) {
      const value = new RegExp(`\\b${key}\\s*:\\s*(\\d+)`).exec(argument)?.[1]
      if (value) common[key] = Number(value)
    }
    expansions.set(openIndex, commands.map((cmd) => codexToolName('exec_command', { cmd, ...common })!))
  }
  return expansions
}

function nestedCodexCalls(source: string): NormalizedCodexCall[] {
  const calls: NormalizedCodexCall[] = []
  const mapped = staticCommandMaps(source)
  const pattern = /\btools\.([A-Za-z0-9_:.]+)\s*\(/g
  for (const match of source.matchAll(pattern)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1
    const expanded = mapped.get(openIndex)
    if (expanded) {
      for (const call of expanded) calls.push({ ...call, suffix: String(calls.length + 1) })
      continue
    }
    const argument = balancedCallArgument(source, openIndex)
    if (argument == null) continue
    const normalized = codexToolName(match[1], literalArgument(argument))
    if (normalized) calls.push({ ...normalized, suffix: String(calls.length + 1) })
  }
  return calls
}

function normalizedCodexCalls(payload: Record<string, unknown>): NormalizedCodexCall[] {
  const name = stringAt(payload, 'name') ?? ''
  const input = callInput(payload)
  if (name === 'exec' && typeof input.raw === 'string') return nestedCodexCalls(input.raw)
  const namespace = stringAt(payload, 'namespace')
  const qualifiedName = namespace && name ? `${namespace}__${name}` : name
  const normalized = codexToolName(qualifiedName || stringAt(payload, 'type') || 'unknown', input)
  return normalized ? [normalized] : []
}

function textContent(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (!Array.isArray(value)) return undefined
  const text = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const candidate = row.text ?? row.content
    return typeof candidate === 'string' ? [candidate] : []
  }).join('')
  return text || undefined
}

function outputText(value: unknown): string | undefined {
  const text = stringsIn(value).join('\n')
  return text || summarize(value)
}

interface IndexedToolOutput {
  output?: string
  failed: boolean
}

function parsedToolOutput(value: unknown): IndexedToolOutput | undefined {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return undefined
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const exitCode = typeof record.exit_code === 'number'
    ? record.exit_code
    : typeof record.exitCode === 'number'
      ? record.exitCode
      : undefined
  const output = outputText(record.output ?? record.error ?? record.result)
  if (exitCode == null && output == null && record.error == null && record.success == null && record.ok == null) return undefined
  return {
    output,
    failed: (exitCode != null && exitCode !== 0) || record.success === false || record.ok === false || record.error != null
  }
}

function indexedToolOutputs(value: unknown, count: number): Array<IndexedToolOutput | undefined> {
  const outputs = Array<IndexedToolOutput | undefined>(count)
  for (const candidate of stringsIn(value)) {
    const match = /^(?:RESULT\s+|R)(\d+)\s*\n([\s\S]*)$/i.exec(candidate.trim())
    if (!match) continue
    const index = Number(match[1]) - 1
    if (index >= 0 && index < count) {
      outputs[index] = parsedToolOutput(match[2]) ?? {
        output: match[2],
        failed: outputFailed({}, match[2]) || /^\s*jq:\s+error\b/im.test(match[2])
      }
    }
  }
  if (count === 1 && !outputs[0]) {
    for (const candidate of stringsIn(value).reverse()) {
      const parsed = parsedToolOutput(candidate)
      if (parsed) {
        outputs[0] = parsed
        break
      }
    }
  }
  return outputs
}

function outputFailed(payload: Record<string, unknown>, output: string | undefined): boolean {
  return payload.error != null ||
    payload.status === 'failed' ||
    (
      /\b(?:Script failed|Script error|tool failed|exit(?: code)?\s*[=:]\s*[1-9]\d*)\b/i.test(output ?? '') ||
      /["']exit_code["']\s*:\s*[1-9]\d*/i.test(output ?? '')
    )
}

function rejectedBeforeExecution(output: string | undefined): boolean {
  const header = (output ?? '').trimStart().slice(0, 1_024)
  if (/^Script completed\b/i.test(header)) return false
  return /^(?:Script (?:failed|rejected)[\s\S]{0,512}|(?:Error:\s*)?CreateProcess[\s\S]{0,512}Rejected|rejected:[\s\S]{0,512}(?:not permitted|permission|denied))/i.test(header)
}

function runningCellId(output: string | undefined): string | undefined {
  return /\bScript running with (?:cell|session) ID\s+([A-Za-z0-9_-]+)/i.exec(output ?? '')?.[1]
}

function skillInjection(text: string | undefined): string | undefined {
  if (!text) return undefined
  return /<skill>\s*<name>([A-Za-z0-9_-]+)<\/name>/i.exec(text)?.[1]
}

function explicitSkillEvent(name: string, runId: string, at: string): TraceEvent {
  return {
    id: `skill-injection-${stableHash([name, at]).slice(0, 16)}`,
    ts: at,
    runId,
    kind: 'skill',
    stage: `skill:${name}`,
    tool: 'Skill',
    name,
    input: { source: 'skill_injection' }
  }
}

function codexHookEvent(payload: Record<string, unknown>, runId: string, at: string): TraceEvent | null {
  const type = stringAt(payload, 'type')
  // Codex 的 hook 生命周期事件名是 hook_started / hook_completed；hook_response 等是 Claude / Qoder 侧的叫法。
  if (!type || !/^hook_(?:started|progress|response|completed|success|cancelled|additional_context)$/.test(type)) return null
  const completedStatus = stringAt(payload, 'status')
  const outcome = stringAt(payload, 'outcome')
    ?? (type === 'hook_started'
      ? 'started'
      : type === 'hook_progress' || type === 'hook_additional_context'
        ? 'progress'
        : type === 'hook_cancelled'
          ? 'cancelled'
          : type === 'hook_completed' && completedStatus
            ? completedStatus === 'completed' ? 'success' : completedStatus === 'stopped' ? 'cancelled' : 'error'
            : 'success')
  const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : typeof payload.exitCode === 'number' ? payload.exitCode : undefined
  const hookId = stringAt(payload, 'hook_id', 'hookId', 'tool_use_id', 'toolUseId')
  const hookName = stringAt(payload, 'hook_name', 'hookName', 'name') ?? 'hook'
  const hookEvent = stringAt(payload, 'hook_event', 'hookEvent', 'event') ?? 'Hook'
  return {
    id: `codex-hook-${stableHash([hookId, type, outcome, at]).slice(0, 16)}`,
    ts: at,
    runId,
    kind: 'hook',
    stage: type === 'hook_started' ? 'hook_started' : type === 'hook_progress' || type === 'hook_additional_context' ? 'hook_progress' : 'hook_response',
    tool: hookName,
    name: hookEvent,
    hookId,
    hookName,
    hookEvent,
    hookCommand: stringAt(payload, 'command', 'hook_command', 'hookCommand'),
    hookOutcome: outcome,
    hookExitCode: exitCode,
    isError: outcome === 'error' || (exitCode != null && exitCode !== 0)
  }
}

function parseCodexRollout(content: string, runId: string): { recognized: boolean; turns: ParsedTranscriptTurn[] } {
  const turns: ParsedTranscriptTurn[] = []
  let current: ParsedTranscriptTurn | undefined
  let sawCodexLine = false
  type UsageCounters = Required<Pick<TraceEvent, 'tokensIn' | 'tokensOut' | 'cacheReadTokens' | 'cacheCreationTokens' | 'reasoningTokens'>>
  const emptyUsage = (): UsageCounters => ({
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0
  })
  let cumulativeUsage = emptyUsage()
  let turnUsageBaseline = emptyUsage()
  let latestTurnCumulative: UsageCounters | undefined
  let usage: Required<Pick<TraceEvent, 'tokensIn' | 'tokensOut' | 'cacheReadTokens' | 'cacheCreationTokens' | 'reasoningTokens'>> = {
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0
  }
  let usageObserved = false
  let usageFinished = false
  let lastUsageFilter = new CodexUsageDeltaFilter()
  // Codex writes the model of every request into `turn_context` and the window plus the latest
  // request's input size into `token_count`. Both are host-authored facts, so they bind the
  // turn's usage to a model and its context occupancy without consulting any config default.
  let turnModels = new Set<string>()
  let contextWindow: number | undefined
  let lastRequestInputTokens: number | undefined
  let lastAssistant: string | undefined
  let injectedSkill: string | undefined
  let logicalIdsByOuterCall = new Map<string, string[]>()
  let toolById = new Map<string, string>()
  let asyncOuterCallByCell = new Map<string, string>()
  let transportCellByOuterCall = new Map<string, string>()
  let lastAt: string | undefined

  const addAssistant = (text: string, at: string, messageId?: string, dedupeLastModel = false): void => {
    if (!current) return
    lastAssistant = text
    const previous = [...current.events].reverse().find((event) => event.kind === 'model' && event.stage === 'text')
    if (previous?.text === text && (dedupeLastModel || current.events.at(-1) === previous)) return
    current.events.push({
      id: `codex-assistant-${stableHash([current.providerTurnId, at, text]).slice(0, 16)}`,
      ts: at,
      runId,
      kind: 'model',
      stage: 'text',
      text,
      ...(messageId ? { messageId } : {})
    })
  }

  const finishUsage = (at: string): void => {
    if (!current || usageFinished) return
    usageFinished = true
    if (!usageObserved) return
    const finalUsage = latestTurnCumulative
      ? {
          tokensIn: Math.max(0, latestTurnCumulative.tokensIn - turnUsageBaseline.tokensIn),
          tokensOut: Math.max(0, latestTurnCumulative.tokensOut - turnUsageBaseline.tokensOut),
          cacheReadTokens: Math.max(0, latestTurnCumulative.cacheReadTokens - turnUsageBaseline.cacheReadTokens),
          cacheCreationTokens: Math.max(0, latestTurnCumulative.cacheCreationTokens - turnUsageBaseline.cacheCreationTokens),
          reasoningTokens: Math.max(0, latestTurnCumulative.reasoningTokens - turnUsageBaseline.reasoningTokens)
        }
      : usage
    // One model per turn is the only case where usage and context can be attributed; several
    // models stay unattributed instead of picking one.
    const model = turnModels.size === 1 ? [...turnModels][0] : undefined
    const context = model && contextWindow && lastRequestInputTokens != null
    current.events.push({
      id: `codex-usage-${stableHash([current.providerTurnId, finalUsage]).slice(0, 16)}`,
      ts: at,
      runId,
      kind: 'harness',
      stage: 'result',
      ...finalUsage,
      ...(model ? { modelUsage: [{ model, ...(context ? { contextWindow } : {}) }] } : {}),
      ...(context ? {
        contextTokens: lastRequestInputTokens,
        contextModel: model,
        contextUsageSource: 'codex_rollout_last_usage',
        contextUsageQuality: 'exact' as const
      } : {})
    })
    current.observable.usage = true
  }

  const addToolCall = (payload: Record<string, unknown>, at: string): void => {
    if (!current) return
    const outerId = stringAt(payload, 'call_id', 'callId', 'id') ?? `call-${stableHash([payload, at]).slice(0, 16)}`
    const name = stringAt(payload, 'name') ?? ''
    if (name === 'wait' || name === 'write_stdin') {
      const input = callInput(payload)
      const rawCellId = input.cell_id ?? input.session_id
      const cellId = typeof rawCellId === 'string' || typeof rawCellId === 'number' ? String(rawCellId) : undefined
      if (cellId) transportCellByOuterCall.set(outerId, cellId)
      return
    }
    const calls = normalizedCodexCalls(payload)
    const logicalIds: string[] = []
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index]
      const toolUseId = calls.length === 1 ? outerId : `${outerId}:${call.suffix ?? index + 1}`
      const cls = classifyTool(call.tool, call.input)
      const mcp = parseMcp(call.tool, call.input)
      const file = fileOpOf(call.tool, call.input)
      const danger = classifyDanger(call.tool, call.input)
      current.events.push(...inferredSkillEvents(call.tool, call.input, runId, at, toolUseId))
      current.events.push({
        id: `codex-tool-${stableHash([toolUseId, call.tool]).slice(0, 16)}`,
        ts: at,
        runId,
        kind: cls.kind,
        stage: `${cls.kind}:${cls.name}`,
        tool: call.tool,
        name: cls.name,
        toolUseId,
        input: call.input,
        ...mcp,
        ...file,
        ...(danger ? { danger } : {})
      })
      logicalIds.push(toolUseId)
      toolById.set(toolUseId, call.tool)
    }
    if (logicalIds.length) {
      logicalIdsByOuterCall.set(outerId, logicalIds)
      current.pendingToolCalls.add(outerId)
      current.observable.tools = true
      current.observable.mcps = true
      current.observable.errors = true
      if (current.events.some((event) => event.kind === 'skill')) current.observable.skills = true
    }
  }

  const addToolOutput = (payload: Record<string, unknown>, at: string): void => {
    if (!current) return
    const outerId = stringAt(payload, 'call_id', 'callId', 'id')
    if (!outerId) return
    const rawOutput = payload.output ?? payload.result ?? payload.tools ?? payload.error
    const output = outputText(rawOutput)
    const transportCell = transportCellByOuterCall.get(outerId)
    const targetOuterId = transportCell ? asyncOuterCallByCell.get(transportCell) : undefined
    const logicalOuterId = targetOuterId ?? outerId
    const ids = logicalIdsByOuterCall.get(logicalOuterId) ?? [logicalOuterId]
    const cellId = runningCellId(output)
    if (cellId) {
      asyncOuterCallByCell.set(cellId, logicalOuterId)
      return
    }
    if (rejectedBeforeExecution(output)) {
      const rejected = new Set(ids)
      current.events = current.events.filter((event) => !event.toolUseId || !rejected.has(event.toolUseId))
      for (const id of ids) {
        toolById.delete(id)
      }
      logicalIdsByOuterCall.delete(logicalOuterId)
      current.pendingToolCalls.delete(logicalOuterId)
      return
    }
    const indexed = indexedToolOutputs(rawOutput, ids.length)
    for (let index = 0; index < ids.length; index++) {
      const toolUseId = ids[index]
      const logicalOutput = indexed[index]
      const resultOutput = logicalOutput?.output ?? output
      const failed = logicalOutput?.failed ?? outputFailed(payload, resultOutput)
      current.events.push({
        id: `codex-result-${stableHash([toolUseId, resultOutput]).slice(0, 16)}`,
        ts: at,
        runId,
        kind: 'tool',
        stage: 'tool_result',
        tool: toolById.get(toolUseId),
        toolUseId,
        text: resultOutput,
        output: resultOutput,
        isError: failed
      })
    }
    current.pendingToolCalls.delete(logicalOuterId)
    if (transportCell) asyncOuterCallByCell.delete(transportCell)
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = stringAt(row, 'type')
    const payload = nestedRecord(row, 'payload') ?? {}
    const at = timestampOf(row)
    lastAt = at
    if (type === 'session_meta' || type === 'turn_context' || type === 'event_msg' || type === 'response_item') sawCodexLine = true
    if (type === 'event_msg' && payload.type === 'task_started') {
      finishUsage(at)
      current = {
        providerTurnId: stringAt(payload, 'turn_id', 'turnId'),
        userText: '',
        startedAt: at,
        events: [],
        observable: {
          tools: true,
          skills: true,
          mcps: true,
          hooks: false,
          usage: false,
          files: false,
          errors: true
        },
        childThreads: [],
        pendingToolCalls: new Set()
      }
      turns.push(current)
      turnUsageBaseline = { ...cumulativeUsage }
      latestTurnCumulative = undefined
      usage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 }
      // 去重只在一轮之内成立：新一轮的第一帧即使和上一轮末帧相同，也是真实用量。
      lastUsageFilter = new CodexUsageDeltaFilter()
      usageObserved = false
      usageFinished = false
      turnModels = new Set()
      lastRequestInputTokens = undefined
      lastAssistant = undefined
      injectedSkill = undefined
      logicalIdsByOuterCall = new Map()
      toolById = new Map()
      asyncOuterCallByCell = new Map()
      transportCellByOuterCall = new Map()
      continue
    }
    if (!current) continue

    if (type === 'turn_context') {
      const model = stringAt(payload, 'model')
      if (model) turnModels.add(model)
      continue
    }

    const hook = codexHookEvent(payload, runId, at)
    if (hook) {
      current.events.push(hook)
      current.observable.hooks = true
      continue
    }

    if (type === 'event_msg' && payload.type === 'user_message') {
      current.userText = stringAt(payload, 'message', 'text', 'prompt') ?? textContent(payload.content) ?? current.userText
      continue
    }
    if (type === 'event_msg' && payload.type === 'sub_agent_activity') {
      const sessionId = stringAt(payload, 'agent_thread_id', 'agentThreadId')
      const parentToolUseId = stringAt(payload, 'event_id', 'eventId')
      const name = stringAt(payload, 'agent_path', 'agentPath')?.replace(/^\/root\//, '')
      if (sessionId && !current.childThreads.some((child) => child.sessionId === sessionId)) {
        current.childThreads.push({ sessionId, parentToolUseId, name })
      }
      if (payload.kind === 'started') {
        current.events.push({
          id: `codex-agent-${stableHash([sessionId, parentToolUseId, at]).slice(0, 16)}`,
          ts: at,
          runId,
          kind: 'agent',
          stage: `agent:${name ?? 'subagent'}`,
          tool: 'Agent',
          toolUseId: parentToolUseId,
          agentId: sessionId,
          name: name ?? 'subagent',
          input: { source: 'sub_agent_activity', sessionId }
        })
      }
      continue
    }
    if (type === 'event_msg' && payload.type === 'patch_apply_end') {
      const outerId = stringAt(payload, 'call_id', 'callId')
      if (outerId) {
        const ids = logicalIdsByOuterCall.get(outerId) ?? [outerId]
        const output = outputText(payload.stdout ?? payload.stderr)
        for (const toolUseId of ids) {
          current.events.push({
            id: `codex-patch-result-${stableHash([toolUseId, at]).slice(0, 16)}`,
            ts: at,
            runId,
            kind: 'tool',
            stage: 'tool_result',
            tool: toolById.get(toolUseId) ?? 'Edit',
            toolUseId,
            text: output,
            output,
            isError: payload.success === false
          })
        }
      }
      const rawChanges = payload.changes
      const changes: Array<[string, Record<string, unknown>]> = Array.isArray(rawChanges)
        ? rawChanges.flatMap((path) => typeof path === 'string' ? [[path, {}] as [string, Record<string, unknown>]] : [])
        : rawChanges && typeof rawChanges === 'object'
          ? Object.entries(rawChanges as Record<string, unknown>).map(([path, rawChange]) => [
              path,
              rawChange && typeof rawChange === 'object' && !Array.isArray(rawChange)
                ? rawChange as Record<string, unknown>
                : {}
            ])
          : []
      for (const [path] of changes) {
        current.events.push({
          id: `codex-file-${stableHash([path, at]).slice(0, 16)}`,
          ts: at,
          runId,
          kind: 'harness',
          stage: 'file_op',
          filePath: path,
          fileOp: 'edit'
        })
      }
      current.observable.files = current.observable.files || changes.length > 0
      continue
    }
    if (type === 'event_msg' && payload.type === 'token_count') {
      const info = nestedRecord(payload, 'info') ?? {}
      const last = nestedRecord(info, 'last_token_usage')
      const total = nestedRecord(info, 'total_token_usage')
      const window = info.model_context_window
      if (typeof window === 'number' && Number.isFinite(window) && window > 0) contextWindow = window
      if (last && typeof last.input_tokens === 'number' && Number.isFinite(last.input_tokens) && last.input_tokens >= 0) {
        lastRequestInputTokens = last.input_tokens
      }
      if (total) {
        const number = (key: string): number => typeof total[key] === 'number' && Number.isFinite(total[key]) ? total[key] as number : 0
        latestTurnCumulative = {
          tokensIn: number('input_tokens'),
          tokensOut: number('output_tokens'),
          cacheReadTokens: number('cached_input_tokens'),
          cacheCreationTokens: number('cache_write_input_tokens'),
          reasoningTokens: number('reasoning_output_tokens')
        }
        cumulativeUsage = { ...latestTurnCumulative }
        usageObserved = true
      }
      // `total_token_usage` 缺失时才会用到这些增量求和。Codex 可能把同一帧
      // `last_token_usage` 连续广播多次，相邻同值帧必须丢掉，否则求和会高估。
      if (last && lastUsageFilter.admit(last)) {
        const add = (key: string): number => typeof last[key] === 'number' && Number.isFinite(last[key]) ? last[key] as number : 0
        usage.tokensIn += add('input_tokens')
        usage.tokensOut += add('output_tokens')
        usage.cacheReadTokens += add('cached_input_tokens')
        usage.cacheCreationTokens += add('cache_write_input_tokens')
        usage.reasoningTokens += add('reasoning_output_tokens')
        usageObserved = true
      }
      continue
    }
    if (type === 'event_msg' && payload.type === 'agent_message') {
      const assistant = stringAt(payload, 'message', 'text') ?? textContent(payload.content)
      if (assistant) addAssistant(assistant, at, stringAt(payload, 'id'))
      continue
    }
    if (type === 'event_msg' && payload.type === 'context_compacted') {
      current.events.push({
        id: `codex-compaction-${stableHash([current.providerTurnId, at]).slice(0, 16)}`,
        ts: at,
        runId,
        kind: 'harness',
        stage: 'context_compaction',
        compaction: {},
        input: {},
        runtimeMetadata: { source: 'codex_rollout_context_compacted' }
      })
      continue
    }
    if (type === 'event_msg' && payload.type === 'task_complete') {
      const turnId = stringAt(payload, 'turn_id', 'turnId')
      if (current.providerTurnId && turnId !== current.providerTurnId) continue
      if (current.terminalStatus) continue
      finishUsage(at)
      current.completedAt = at
      current.terminalStatus = terminalStatus(payload, payload.error != null ? 'failed' : 'completed')
      const assistant = stringAt(payload, 'last_agent_message', 'lastAgentMessage') ?? lastAssistant
      if (assistant) addAssistant(assistant, at, stringAt(payload, 'id'), true)
      if (payload.error != null) current.events.push({
        id: `codex-error-${stableHash([current.providerTurnId, payload.error]).slice(0, 16)}`,
        ts: at,
        runId,
        kind: 'harness',
        stage: 'task_error',
        text: summarize(payload.error),
        output: summarize(payload.error),
        isError: true
      })
      continue
    }
    if (type === 'event_msg' && payload.type === 'turn_aborted') {
      const turnId = stringAt(payload, 'turn_id', 'turnId')
      if (current.providerTurnId && turnId !== current.providerTurnId) continue
      if (current.terminalStatus) continue
      const canonicalCompletedAt = epochSecondsAt(payload, 'completed_at', 'completedAt')
      const canonicalStartedAt = epochSecondsAt(payload, 'started_at', 'startedAt')
      const durationMs = typeof payload.duration_ms === 'number' && Number.isFinite(payload.duration_ms) && payload.duration_ms >= 0
        ? Math.round(payload.duration_ms)
        : undefined
      const hasCanonicalTiming = !!canonicalCompletedAt || !!canonicalStartedAt || durationMs != null
      const canonicalWallMs = canonicalCompletedAt && canonicalStartedAt
        ? Date.parse(canonicalCompletedAt) - Date.parse(canonicalStartedAt)
        : undefined
      if (hasCanonicalTiming && (
        !canonicalCompletedAt || !canonicalStartedAt || durationMs == null ||
        canonicalWallMs == null || canonicalWallMs < 0 || durationMs > canonicalWallMs + 999
      )) {
        continue
      }
      const completedAt = canonicalCompletedAt ?? at
      finishUsage(completedAt)
      current.completedAt = completedAt
      if (canonicalStartedAt) current.startedAt = canonicalStartedAt
      if (durationMs != null) current.durationMs = durationMs
      current.terminalStatus = terminalStatus(payload, 'interrupted')
      continue
    }
    if (type !== 'response_item') continue

    const itemType = stringAt(payload, 'type')
    if (itemType === 'message' && stringAt(payload, 'role') === 'user') {
      const text = textContent(payload.content)
      const skill = skillInjection(text)
      if (skill) {
        injectedSkill = skill
        current.events.push(explicitSkillEvent(skill, runId, at))
        current.observable.skills = true
      } else if (
        text &&
        !/^\s*(?:<recommended_plugins>|# AGENTS\.md instructions|<environment_context>)/.test(text) &&
        !current.userText
      ) {
        current.userText = text
      }
      continue
    }
    if (itemType === 'message' && stringAt(payload, 'role') === 'assistant') {
      const assistant = textContent(payload.content)
      if (assistant) addAssistant(assistant, at, stringAt(payload, 'id'))
      continue
    }
    if (itemType === 'agent_message') {
      const assistant = stringAt(payload, 'message', 'text') ?? textContent(payload.content)
      if (assistant) addAssistant(assistant, at, stringAt(payload, 'id'))
      continue
    }
    if (itemType === 'reasoning') {
      const thinking = textContent(payload.summary) ?? stringAt(payload, 'text')
      if (thinking) current.events.push({
        id: `codex-thinking-${stableHash([current.providerTurnId, at, thinking]).slice(0, 16)}`,
        ts: at,
        runId,
        kind: 'model',
        stage: 'thinking',
        thinking,
        ...(stringAt(payload, 'id') ? { messageId: stringAt(payload, 'id') } : {})
      })
      continue
    }

    const isCall = itemType === 'custom_tool_call' || itemType === 'function_call'
    if (isCall) {
      addToolCall(payload, at)
      continue
    }

    const isOutput = itemType === 'custom_tool_call_output' || itemType === 'function_call_output'
    if (isOutput) {
      addToolOutput(payload, at)
    }
  }
  if (lastAt) finishUsage(lastAt)
  for (const turn of turns) {
    const injection = turn.events.find((event) =>
      event.kind === 'skill' &&
      (event.input as Record<string, unknown> | undefined)?.source === 'skill_injection'
    )
    const skill = injection?.name ?? (turn === current ? injectedSkill : undefined)
    if (skill && turn.userText && !turn.userText.startsWith('/')) turn.userText = `/${skill} ${turn.userText}`
  }
  return { recognized: sawCodexLine && turns.length > 0, turns }
}

function overlapsTurn(parent: ParsedTranscriptTurn, child: ParsedTranscriptTurn): boolean {
  const parentStart = Date.parse(parent.startedAt ?? '')
  const parentEnd = Date.parse(parent.completedAt ?? '')
  const childStart = Date.parse(child.startedAt ?? '')
  const childEnd = Date.parse(child.completedAt ?? child.startedAt ?? '')
  if (![parentStart, parentEnd, childStart, childEnd].every(Number.isFinite)) return true
  return childStart <= parentEnd && childEnd >= parentStart
}

async function codexChildRollout(parentPath: string, sessionId: string): Promise<string | undefined> {
  const dayDir = dirname(parentPath)
  const findIn = async (dir: string): Promise<string | undefined> => {
    try {
      const names = await readdir(dir)
      const name = names.find((candidate) => candidate.endsWith(`-${sessionId}.jsonl`) || candidate === `${sessionId}.jsonl`)
      return name ? join(dir, name) : undefined
    } catch {
      return undefined
    }
  }
  const sameDay = await findIn(dayDir)
  if (sameDay) return sameDay
  // A long parent turn can cross midnight. Bound the fallback to sibling day directories in the same month.
  const monthDir = dirname(dayDir)
  try {
    const days = await readdir(monthDir, { withFileTypes: true })
    for (const day of days) {
      if (!day.isDirectory() || join(monthDir, day.name) === dayDir) continue
      const found = await findIn(join(monthDir, day.name))
      if (found) return found
    }
  } catch {
    // Missing/legacy session layout remains partial evidence, never a recorder failure.
  }
  return undefined
}

async function codexTurnWithChildren(
  turn: ParsedTranscriptTurn,
  transcriptPath: string,
  runId: string,
  seen = new Set<string>()
): Promise<{ events: TraceEvent[]; complete: boolean; observable: TranscriptRead['observable'] }> {
  const events = [...turn.events]
  const observable = { ...turn.observable }
  let complete = true
  for (const child of turn.childThreads) {
    if (seen.has(child.sessionId)) continue
    seen.add(child.sessionId)
    const childPath = await codexChildRollout(transcriptPath, child.sessionId)
    if (!childPath) {
      complete = false
      continue
    }
    let parsed: ReturnType<typeof parseCodexRollout>
    try {
      const childIdentity = transcriptIdentity(await stat(childPath))
      const childTranscript = await readTranscriptWindow(childPath, childIdentity.size, 0, childIdentity)
      parsed = parseCodexRollout(childTranscript.content, runId)
      complete = complete && childTranscript.consistent && !childTranscript.truncated
    } catch {
      complete = false
      continue
    }
    const childTurns = parsed.turns.filter((candidate) => overlapsTurn(turn, candidate))
    if (!parsed.recognized || childTurns.length === 0) {
      complete = false
      continue
    }
    for (const childTurn of childTurns) {
      const nested = await codexTurnWithChildren(childTurn, childPath, runId, seen)
      complete = complete && nested.complete
      observable.skills = observable.skills || nested.observable.skills
      observable.mcps = observable.mcps || nested.observable.mcps
      observable.hooks = observable.hooks || nested.observable.hooks
      observable.files = observable.files || nested.observable.files
      observable.errors = observable.errors || nested.observable.errors
      events.push(...nested.events.flatMap((event): TraceEvent[] => {
        // Root usage and assistant response are authoritative for the user turn; child usage/text must not be added again.
        if (event.kind === 'model' || (event.kind === 'harness' && event.stage === 'result')) return []
        return [{
          ...event,
          agentId: event.agentId ?? child.sessionId,
          parentToolUseId: event.parentToolUseId ?? child.parentToolUseId,
          runtimeMetadata: {
            ...event.runtimeMetadata,
            childTranscript: childPath,
            childAgent: child.name ?? child.sessionId
          }
        }]
      }))
    }
  }
  return { events, complete, observable }
}

export interface TranscriptSnapshotIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

function transcriptIdentity(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): TranscriptSnapshotIdentity {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

function sameTranscriptIdentity(left: TranscriptSnapshotIdentity, right: TranscriptSnapshotIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

export async function readTranscriptWindow(
  path: string,
  endOffset: number,
  preferredStartOffset = 0,
  expectedIdentity?: TranscriptSnapshotIdentity
): Promise<{
  content: string
  startOffset: number
  endOffset: number
  identity?: TranscriptSnapshotIdentity
  truncated: boolean
  consistent: boolean
}> {
  const boundedEnd = Math.max(0, endOffset)
  const preferredStart = Math.max(0, Math.min(preferredStartOffset, boundedEnd))
  // The start offset is captured when the user turn opens. A later byte cap would
  // permanently erase early events from a large turn, so read the complete bounded
  // snapshot from that authority rather than silently advancing the start cursor.
  const start = preferredStart
  const length = boundedEnd - start
  const handle = await openFile(path, 'r')
  const buffer = Buffer.allocUnsafe(length)
  let bytesRead = 0
  let before: TranscriptSnapshotIdentity | undefined
  let after: TranscriptSnapshotIdentity | undefined
  try {
    before = transcriptIdentity(await handle.stat())
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    after = transcriptIdentity(await handle.stat())
  } finally {
    await handle.close()
  }
  let pathIdentity: TranscriptSnapshotIdentity | undefined
  try {
    pathIdentity = transcriptIdentity(await stat(path))
  } catch {
    // A rotated-away path is unstable even when the already-open handle was still readable.
  }
  const consistent = bytesRead === length && !!before && !!after && !!pathIdentity &&
    (!expectedIdentity || sameTranscriptIdentity(before, expectedIdentity)) &&
    sameTranscriptIdentity(before, after) && sameTranscriptIdentity(after, pathIdentity)
  let contentStart = start
  let contentBuffer = buffer.subarray(0, bytesRead)
  let truncated = start > preferredStart
  if (start > 0) {
    const firstNewline = contentBuffer.indexOf(0x0a)
    if (firstNewline >= 0) {
      contentStart += firstNewline + 1
      contentBuffer = contentBuffer.subarray(firstNewline + 1)
    } else {
      contentStart += contentBuffer.length
      contentBuffer = Buffer.alloc(0)
      truncated = true
    }
  }
  return {
    content: contentBuffer.toString('utf8'),
    startOffset: contentStart,
    endOffset: start + bytesRead,
    ...(consistent && after ? { identity: after } : {}),
    truncated,
    consistent
  }
}

interface TranscriptSnapshotCacheEntry {
  key: string
  read: TranscriptRead
}

const TRANSCRIPT_SNAPSHOT_CACHE_LIMIT = 8
const transcriptSnapshotCache = new Map<string, TranscriptSnapshotCacheEntry>()
let transcriptSnapshotCacheHits = 0
let transcriptSnapshotCacheMisses = 0

/** Process-local diagnostics used by complexity tests and the informational recovery benchmark. */
export function transcriptSnapshotCacheStats(): { hits: number; misses: number; entries: number } {
  return { hits: transcriptSnapshotCacheHits, misses: transcriptSnapshotCacheMisses, entries: transcriptSnapshotCache.size }
}

export function resetTranscriptSnapshotCache(): void {
  transcriptSnapshotCache.clear()
  transcriptSnapshotCacheHits = 0
  transcriptSnapshotCacheMisses = 0
}

function transcriptSnapshotCacheKey(args: {
  path: string
  startOffset?: number
  stable: boolean
  runId: string
  provider: ProviderId
  promptHash?: string
  providerTurnId?: string
  identity: TranscriptSnapshotIdentity
}): string {
  return JSON.stringify([
    args.path, args.startOffset ?? 0, args.stable, args.runId, args.provider,
    args.promptHash ?? '', args.providerTurnId ?? '', args.identity.dev, args.identity.ino,
    args.identity.size, args.identity.mtimeMs, args.identity.ctimeMs
  ])
}

async function parseTranscriptSnapshot(args: {
  path: string
  endOffset: number
  startOffset?: number
  stable: boolean
  runId: string
  provider: ProviderId
  promptHash?: string
  providerTurnId?: string
  identity?: TranscriptSnapshotIdentity
}): Promise<TranscriptRead> {
  const snapshot = await readTranscriptWindow(args.path, args.endOffset, args.startOffset, args.identity)
  const stable = args.stable && snapshot.consistent
  const source = snapshot.consistent && snapshot.identity ? {
    content: snapshot.content,
    sourcePath: args.path,
    startOffset: snapshot.startOffset,
    endOffset: snapshot.endOffset,
    identity: snapshot.identity,
    sourceCompleteness: snapshot.truncated ? 'partial' as const : 'complete' as const
  } : undefined
  if (args.provider === 'codex') {
    const parsed = parseCodexRollout(snapshot.content, args.runId)
    const direct = args.providerTurnId ? parsed.turns.find((turn) => turn.providerTurnId === args.providerTurnId) : undefined
    const matching = args.promptHash
      ? [...parsed.turns].reverse().find((turn) => {
          const candidates = [turn.userText, turn.userText.replace(/^\/[A-Za-z0-9_-]+\s*/, '')]
          return candidates.some((candidate) => createHash('sha256').update(candidate).digest('hex') === args.promptHash)
        })
      : undefined
    const turn = args.providerTurnId
      ? direct
      : args.promptHash
        ? matching
        : parsed.turns.at(-1)
    const identityMatched = !args.providerTurnId && !args.promptHash ? undefined : !!turn
    const enriched = turn
      ? await codexTurnWithChildren(turn, args.path, args.runId)
      : {
          events: [],
          complete: false,
          observable: {
            tools: false,
            skills: false,
            mcps: false,
            hooks: false,
            usage: false,
            files: false,
            errors: false
          }
        }
    return {
      stable,
      ...(source ? { source } : {}),
      observed: parsed.recognized,
      ...(identityMatched != null ? { identityMatched } : {}),
      complete: stable && !snapshot.truncated && enriched.complete,
      ...(turn?.terminalStatus ? { terminalStatus: turn.terminalStatus } : {}),
      ...(turn?.completedAt ? { completedAt: turn.completedAt } : {}),
      ...(turn?.startedAt ? { startedAt: turn.startedAt } : {}),
      ...(turn?.durationMs != null ? { durationMs: turn.durationMs } : {}),
      toolStreamComplete: stable && !snapshot.truncated && !!turn && turn.pendingToolCalls.size === 0,
      ...(turn?.userText ? { userText: turn.userText } : {}),
      events: enriched.events,
      observable: enriched.observable
    }
  }
  const turns = parseTranscriptToTurns(snapshot.content, {
    runId: args.runId,
    newId: () => `transcript-${randomUUID()}`,
    now: () => new Date().toISOString()
  })
  const direct = args.providerTurnId
    ? turns.find((turn) => turn.providerTurnId === args.providerTurnId)
    : undefined
  const matching = args.promptHash
    ? [...turns].reverse().find((turn) => {
        const command = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>[\s\S]*?<command-args>\s*([\s\S]*?)\s*<\/command-args>/i.exec(turn.userText)
        const candidates = [
          turn.userText,
          ...(command ? [`${command[1]}${command[2].trim() ? ` ${command[2].trim()}` : ''}`] : [])
        ]
        return candidates.some((candidate) => createHash('sha256').update(candidate).digest('hex') === args.promptHash)
      })
    : undefined
  const turn = args.providerTurnId
    ? direct
    : args.promptHash
      ? matching
      : turns.at(-1)
  const identityMatched = !args.providerTurnId && !args.promptHash ? undefined : !!turn
  const events = [...turn?.items ?? []]
  if (args.provider === 'qoder' && turn) {
    // Prompt text can recover display content, but is not billing identity.
    // Only the hook's authoritative ID may select a root; let the native parser
    // reject duplicate prompt IDs instead of promoting the first parsed UUID.
    const parsed = qoderCreditRequests(snapshot.content, args.providerTurnId ? [{
      runId: args.runId, providerTurnId: args.providerTurnId
    }] : [])
    events.push({
      id: `credits:${args.runId}`, runId: args.runId,
      ts: events.at(-1)?.ts ?? new Date().toISOString(),
      kind: 'harness', stage: 'credit_usage', runtimeProvider: 'qoder_cli',
      creditUsage: creditUsageEvidence(parsed.requests, 'qoder_native_transcript')
    })
  }
  return {
    stable,
    ...(source ? { source } : {}),
    observed: turns.length > 0,
    ...(identityMatched != null ? { identityMatched } : {}),
    complete: stable && !snapshot.truncated,
    ...(turn?.userText ? { userText: turn.userText } : {}),
    events,
    observable: {
      tools: turns.length > 0,
      skills: turns.length > 0,
      mcps: turns.length > 0,
      hooks: events.some((event) => event.kind === 'hook'),
      usage: events.some((event) => event.kind === 'harness' && (event.stage === 'result' || event.stage === 'credit_usage')),
      files: events.some((event) => !!event.filePath && !!event.fileOp),
      errors: turns.length > 0
    }
  }
}

function archivedCodexTranscriptPath(path: string): string | undefined {
  const marker = `${sep}sessions${sep}`
  const index = path.lastIndexOf(marker)
  if (index < 0) return undefined
  return join(path.slice(0, index), 'archived_sessions', basename(path))
}

async function readableTranscriptPath(path: string, provider: ProviderId): Promise<string> {
  try {
    await stat(path)
    return path
  } catch {
    if (provider !== 'codex') return path
  }
  const archived = archivedCodexTranscriptPath(path)
  if (!archived) return path
  try {
    await stat(archived)
    return archived
  } catch {
    return path
  }
}

function transcriptLineAnchor(
  line: string,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string
): 'turn' | 'user' | undefined {
  let row: Record<string, unknown>
  try {
    row = JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (provider === 'codex') {
    const payload = nestedRecord(row, 'payload') ?? {}
    if (row.type === 'event_msg' && payload.type === 'task_started') {
      const id = stringAt(payload, 'turn_id', 'turnId')
      return providerTurnId ? id === providerTurnId ? 'turn' : undefined : !promptHash ? 'turn' : undefined
    }
    if (row.type !== 'event_msg' || payload.type !== 'user_message') return undefined
    const text = stringAt(payload, 'message', 'text', 'prompt') ?? textContent(payload.content) ?? ''
    const matchesHash = !!promptHash && [text, text.replace(/^\/[A-Za-z0-9_-]+\s*/, '')]
      .some((candidate) => createHash('sha256').update(candidate).digest('hex') === promptHash)
    return matchesHash || !promptHash && !providerTurnId ? 'user' : undefined
  }
  if (row.type !== 'user') return undefined
  const id = stringAt(row, 'promptId', 'prompt_id', 'turnId', 'turn_id')
  if (providerTurnId && id === providerTurnId) return 'turn'
  const text = textContent((row.message as Record<string, unknown> | undefined)?.content) ?? ''
  const command = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>[\s\S]*?<command-args>\s*([\s\S]*?)\s*<\/command-args>/i.exec(text)
  const candidates = [
    text,
    ...(command ? [`${command[1]}${command[2].trim() ? ` ${command[2].trim()}` : ''}`] : [])
  ]
  const matchesHash = !!promptHash && candidates
    .some((candidate) => createHash('sha256').update(candidate).digest('hex') === promptHash)
  return matchesHash || !promptHash && !providerTurnId ? 'turn' : undefined
}

async function transcriptAnchorOffset(
  path: string,
  endOffset: number,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string
): Promise<number> {
  if (endOffset <= 0 || !promptHash && !providerTurnId) return 0
  const handle = await openFile(path, 'r')
  const chunkBytes = 1024 * 1024
  let cursor = endOffset
  let suffix = Buffer.alloc(0)
  let matchedUserOffset: number | undefined
  let matchedTurnOffset: number | undefined
  try {
    while (cursor > 0) {
      const start = Math.max(0, cursor - chunkBytes)
      const chunk = Buffer.allocUnsafe(cursor - start)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start)
      if (bytesRead !== chunk.length) return 0
      const combined = Buffer.concat([chunk, suffix])
      let lineEnd = combined.length
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== 0x0a) continue
        const lineStart = index + 1
        if (lineEnd > lineStart) {
          const absoluteOffset = start + lineStart
          const anchor = transcriptLineAnchor(combined.subarray(lineStart, lineEnd).toString('utf8'), provider, promptHash, providerTurnId)
          const windowOffset = Math.max(0, absoluteOffset - 1)
          if (provider !== 'codex') {
            if (anchor === 'turn') return windowOffset
          } else {
            const anyAnchor = transcriptLineAnchor(
              combined.subarray(lineStart, lineEnd).toString('utf8'), provider, undefined, undefined
            )
            if (matchedTurnOffset != null && anyAnchor === 'turn') return windowOffset
            if (anchor === 'turn' || matchedUserOffset != null && anyAnchor === 'turn') {
              matchedTurnOffset = windowOffset
            } else if (anchor === 'user' && matchedUserOffset == null) {
              matchedUserOffset = windowOffset
            }
          }
        }
        lineEnd = index
      }
      suffix = combined.subarray(0, lineEnd)
      // NUL cannot occur in a valid JSONL record. Sparse/uninitialized prefixes are
      // therefore a hard format boundary, not evidence that must be loaded to byte 0.
      if (matchedTurnOffset != null && suffix.includes(0)) return matchedTurnOffset
      cursor = start
    }
    if (suffix.length) {
      const firstLine = suffix.toString('utf8')
      const anchor = transcriptLineAnchor(firstLine, provider, promptHash, providerTurnId)
      if (anchor === 'turn') return 0
      if (provider === 'codex' && matchedTurnOffset != null && transcriptLineAnchor(firstLine, provider) === 'turn') return 0
      if (anchor === 'user' && matchedUserOffset == null) matchedUserOffset = 0
    }
    return matchedTurnOffset ?? matchedUserOffset ?? 0
  } finally {
    await handle.close()
  }
}

async function cachedTranscriptSnapshot(args: {
  path: string
  startOffset?: number
  stable: boolean
  runId: string
  provider: ProviderId
  promptHash?: string
  providerTurnId?: string
  identity: TranscriptSnapshotIdentity
}): Promise<TranscriptRead> {
  const key = transcriptSnapshotCacheKey(args)
  const cached = transcriptSnapshotCache.get(key)
  if (cached) {
    transcriptSnapshotCache.delete(key)
    transcriptSnapshotCache.set(key, cached)
    transcriptSnapshotCacheHits++
    return cached.read
  }
  transcriptSnapshotCacheMisses++
  const read = await parseTranscriptSnapshot({ ...args, endOffset: args.identity.size })
  // A read that raced truncation/rotation must be retried; caching it under the stable identity
  // would otherwise keep a recoverable turn pending for the lifetime of this process.
  if (!args.stable || read.stable) transcriptSnapshotCache.set(key, { key, read })
  while (transcriptSnapshotCache.size > TRANSCRIPT_SNAPSHOT_CACHE_LIMIT) {
    const oldest = transcriptSnapshotCache.keys().next().value
    if (typeof oldest !== 'string') break
    transcriptSnapshotCache.delete(oldest)
  }
  return read
}

async function stableTranscript(
  path: string,
  runId: string,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string,
  startOffset?: number
): Promise<TranscriptRead> {
  path = await readableTranscriptPath(path, provider)
  // Recompute an exact JSONL turn anchor. Older persisted offsets were heuristic
  // byte rewinds and may begin inside a large prompt, so they are never evidence.
  startOffset = 0
  let previous = -1
  let latestIdentity: TranscriptSnapshotIdentity | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    let identity: TranscriptSnapshotIdentity
    try {
      const info = await stat(path)
      identity = {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs
      }
    } catch {
      return {
        stable: true,
        observed: false,
        ...(providerTurnId || promptHash ? { identityMatched: false } : {}),
        complete: true,
        events: [],
        observable: {
          tools: false,
          skills: false,
          mcps: false,
          hooks: false,
          usage: false,
          files: false,
          errors: false
        }
      }
    }
    latestIdentity = identity
    if (identity.size === previous) {
      startOffset = await transcriptAnchorOffset(path, identity.size, provider, promptHash, providerTurnId)
      return cachedTranscriptSnapshot({ path, startOffset, stable: true, runId, provider, promptHash, providerTurnId, identity })
    }
    previous = identity.size
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (latestIdentity) startOffset = await transcriptAnchorOffset(path, latestIdentity.size, provider, promptHash, providerTurnId)
  return latestIdentity
    ? cachedTranscriptSnapshot({
        path,
        startOffset,
        stable: false,
        runId,
        provider,
        promptHash,
        providerTurnId,
        identity: latestIdentity
      })
    : parseTranscriptSnapshot({
        path,
        endOffset: 0,
        startOffset,
        stable: false,
        runId,
        provider,
        promptHash,
        providerTurnId
      })
}

async function readStoredEvents(path: string): Promise<TraceEvent[]> {
  const events: TraceEvent[] = []
  for (const name of await listFiles(path)) {
    if (!name.endsWith('.json')) continue
    const stored = await readJson<StoredLifecycleEvent>(join(path, name))
    if (stored?.schemaVersion === 1 && Array.isArray(stored.traceEvents)) events.push(...stored.traceEvents)
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts))
}

function dedupeTraceEvents(events: TraceEvent[]): TraceEvent[] {
  const seen = new Set<string>()
  return events.filter((event) => {
    const logicalToolKey = event.kind === 'skill'
      ? event.toolUseId
        ? { lifecycle: 'skill', name: event.name ?? event.tool ?? 'unknown', toolUseId: event.toolUseId }
        : {
            lifecycle: 'skill',
            name: event.name ?? event.tool ?? 'unknown',
            messageId: event.messageId,
            source: (event.input as Record<string, unknown> | undefined)?.source,
            id: event.id
          }
      : event.toolUseId
      ? {
          lifecycle: event.stage === 'tool_result' ? 'result' : 'start',
          toolUseId: event.toolUseId
        }
      : undefined
    const key = stableHash(logicalToolKey ?? {
      kind: event.kind,
      stage: event.stage,
      hookId: event.hookId,
      hookOutcome: event.hookOutcome,
      tool: event.tool,
      text: event.text,
      ts: event.ts
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function toolEventKey(event: TraceEvent): string | undefined {
  if (!event.toolUseId) return undefined
  return event.stage === 'tool_result' ? `result:${event.toolUseId}` : `start:${event.toolUseId}`
}

function isLogicalCallEvent(event: TraceEvent): boolean {
  return event.stage === 'tool_result' ||
    (event.stage !== 'tool_result' && ['tool', 'skill', 'agent'].includes(event.kind) && !!(event.tool || event.name))
}

export function mergeTurnTraceEvents(
  lifecycle: TraceEvent[],
  transcript: TraceEvent[],
  transcriptToolStreamComplete = true
): TraceEvent[] {
  const transcriptToolKeys = new Set(transcript.map(toolEventKey).filter((key): key is string => !!key))
  const transcriptHasLogicalCalls = transcript.some((event) => isLogicalCallEvent(event) && event.stage !== 'tool_result')
  const transcriptCallsAuthoritative = transcriptToolStreamComplete && transcriptHasLogicalCalls
  const transcriptHasAssistant = transcript.some((event) => event.kind === 'model' && event.stage === 'text')
  const transcriptHasUsage = transcript.some((event) => event.kind === 'harness' && event.stage === 'result')
  // 带脚本身份的 transcript hook 运行是权威证据；此时 recorder 自己的投递事件只会重复计数。
  const transcriptHasHookRuns = transcript.some((event) => event.kind === 'hook' && event.stage !== HOOK_DELIVERY_STAGE)
  const filteredLifecycle = lifecycle.filter((event) => {
    if (transcriptCallsAuthoritative && isLogicalCallEvent(event)) return false
    const key = toolEventKey(event)
    if (key && transcriptToolKeys.has(key)) return false
    if (transcriptHasAssistant && event.kind === 'model' && event.stage === 'text') return false
    if (transcriptHasUsage && event.kind === 'harness' && event.stage === 'result') return false
    if (transcriptHasHookRuns && event.kind === 'hook' && event.stage === HOOK_DELIVERY_STAGE) return false
    if (transcript.length && event.kind === 'skill' && !event.toolUseId) return false
    return true
  })
  return dedupeTraceEvents([...filteredLifecycle, ...transcript])
}

async function nextSessionState(dataRoot: string, root: string, provider: ProviderId, sessionId: string): Promise<SessionState> {
  const cached = await readJson<SessionState>(statePath(root))
  if (cached) return cached
  const committed = (await listRecords(dataRoot)).filter((record) => record.provider.id === provider && record.sessionId === sessionId)
  const maxGeneration = Math.max(...committed.map((record) => record.generation), 0)
  const maxTurnIndex = Math.max(...committed.map((record) => record.turnIndex), 0)
  return { schemaVersion: 1, lastGeneration: maxGeneration, lastTurnIndex: maxTurnIndex }
}

async function beginOpenTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionId: string,
  event: string,
  payload: Record<string, unknown>,
  managedByScry = false,
  staleTerminalProtection = false
): Promise<OpenTurnState> {
  const root = sessionRoot(enablement.dataRoot, provider, sessionId)
  const session = await nextSessionState(enablement.dataRoot, root, provider, sessionId)
  const generation = session.lastGeneration + 1
  const turnIndex = session.lastTurnIndex + 1
  const prompt = promptOf(payload)
  const promptHash = prompt ? createHash('sha256').update(prompt).digest('hex') : undefined
  const rawManagedRunId = managedByScry ? stringAt(payload, 'scry_managed_run_id') : undefined
  const rawManagedPromptHash = managedByScry ? stringAt(payload, 'scry_managed_prompt_hash') : undefined
  const managedRunId = rawManagedRunId && rawManagedRunId.length <= 256 && !/[\r\n]/.test(rawManagedRunId)
    ? rawManagedRunId
    : undefined
  const managedPromptHash = rawManagedPromptHash && /^[a-f0-9]{64}$/.test(rawManagedPromptHash)
    ? rawManagedPromptHash
    : undefined
  const providerTurnId = providerTurnIdOf(payload, provider)
  const transcriptPath = transcriptPathOf(payload)
  const transcriptOffset = transcriptPath ? 0 : undefined
  const open: OpenTurnState = {
    ...(isFullToolContentPolicy(enablement.config.capture) ? { toolContentPolicy: {
      toolOutput: 'full' as const,
      toolContentFieldBytes: enablement.config.capture.toolContentFieldBytes,
      toolContentTurnBytes: enablement.config.capture.toolContentTurnBytes
    } } : {}),
    schemaVersion: 1,
    provider,
    sessionId,
    generation,
    turnIndex,
    status: 'open',
    startedAt: timestampOf(payload),
    startFingerprint: startFingerprintOf(provider, event, payload),
    ...(enablement.config.capture.prompt && prompt ? { prompt } : {}),
    ...(promptHash ? { promptHash } : {}),
    ...(managedRunId ? { managedRunId } : {}),
    ...(managedPromptHash ? { managedPromptHash } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(transcriptOffset != null ? { transcriptStartOffset: transcriptOffset } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
    ...(managedByScry ? { managedByScry: true } : {}),
    ...(staleTerminalProtection ? { staleTerminalProtection: true } : {}),
    captures: []
  }
  // Publish the initial identity durably before acknowledging the start hook.
  await writeJsonAtomic(openPath(root), open)
  await writeJsonAtomic(statePath(root), { ...session, lastGeneration: generation, lastTurnIndex: turnIndex })
  if (!managedByScry && enablement.config.capture.diff) {
    const captureDir = join(turnRoot(root, generation), 'captures')
    const repositories = await discoverRepositories(enablement.workspaceRoot, enablement.config)
    open.captures = await Promise.all(repositories.map(async (repository) => ({
      repository,
      capture: await beginGitTurnDiff(repository, 5_000, captureDir, [enablement.dataRoot])
    })))
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  return open
}

/** A timestamp is usable as an end time only inside this turn's own window. */
function credibleAt(value: string | undefined, startedMs: number, ceilingMs: number): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms < startedMs || ms > ceilingMs) return undefined
  return new Date(ms).toISOString()
}

/**
 * `completedAt` may only come from this turn's own evidence. Without a terminal observation the last
 * thing actually observed is a lower bound, reported as partial — the alternative used to be the
 * next prompt's arrival, which silently billed the user's idle time to the Agent.
 */
function resolveTurnEnd(
  open: OpenTurnState,
  startedAt: string,
  transcript: { completedAt?: string },
  events: TraceEvent[],
  forced?: 'expired'
): { completedAt: string; termination: Evidence<TurnTermination> } {
  const startedMs = Date.parse(startedAt)
  const ceilingMs = Date.now() + TERMINAL_CLOCK_SKEW_MS
  const reason: TurnEndReason = open.endReason ?? forced ?? 'provider_terminal'
  const observedAt = open.closingAt ? { observedAt: open.closingAt } : {}
  const transcriptEnd = credibleAt(transcript.completedAt, startedMs, ceilingMs)
  if (transcriptEnd) {
    return {
      completedAt: transcriptEnd,
      termination: available({ reason, completedAtSource: 'provider_transcript', ...observedAt }, ['provider_transcript'])
    }
  }
  const terminalEnd = credibleAt(open.terminalAt, startedMs, ceilingMs)
  if (terminalEnd) {
    const completedAtSource = open.terminalAtSource ?? 'provider_terminal_event'
    return {
      completedAt: terminalEnd,
      // A hook firing at the end is close to the real end, but it is our clock, not the Provider's.
      termination: available(
        { reason, completedAtSource, ...observedAt },
        ['lifecycle_hooks'],
        completedAtSource === 'provider_terminal_event' ? 'exact' : 'estimated'
      )
    }
  }
  const lastActivity = events
    .map((event) => credibleAt(event.ts, startedMs, ceilingMs))
    .filter((value): value is string => !!value)
    .sort()
    .at(-1)
  if (lastActivity) {
    return {
      completedAt: lastActivity,
      termination: partial(
        { reason, completedAtSource: 'last_observed_activity', ...observedAt },
        ['lifecycle_hooks'],
        'no terminal event was observed; completedAt is the last observed activity and is a lower bound',
        'estimated'
      )
    }
  }
  return {
    completedAt: startedAt,
    termination: partial(
      { reason, completedAtSource: 'turn_start', ...observedAt },
      ['recorder_open_turn'],
      'no terminal event and no activity were observed, so this turn has no known end time or duration'
    )
  }
}

async function quarantineOpenTurn(
  dataRoot: string,
  root: string,
  open: OpenTurnState,
  reason: 'managed_replaced' | 'legacy_migration'
): Promise<void> {
  await writeJsonAtomic(join(turnRoot(root, open.generation), 'pending-open.json'), {
    ...open,
    quarantinedAt: new Date().toISOString(),
    reason
  }, { sync: false })
  await rm(openPath(root), { force: true })
  await updateHealth(dataRoot, { lastError: { at: new Date().toISOString(), message: `recorder turn quarantined: ${reason}` } })
}

async function storeLifecycleEvent(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: OpenTurnState,
  event: string,
  payload: Record<string, unknown>
): Promise<string> {
  const root = sessionRoot(enablement.dataRoot, open.provider, open.sessionId)
  const id = stableHash({ event, sessionId: open.sessionId, generation: open.generation, payload })
  const contentPolicy = open.toolContentPolicy ?? enablement.config.capture
  const traceEvents = await persistRecorderEventContent(lifecycleTraceEvents({
    provider: open.provider,
    event,
    payload,
    runId: `${open.provider}:${open.sessionId}:${open.generation}`,
    captureOutput: contentPolicy.toolOutput === 'summary',
    toolContentPolicy: contentPolicy
  }), contentPolicy, 'lifecycle_hook', enablement.dataRoot)
  const stored: StoredLifecycleEvent = {
    schemaVersion: 1,
    id,
    event,
    observedAt: observedNow(),
    traceEvents,
    ...(transcriptPathOf(payload) ? { transcriptPath: transcriptPathOf(payload) } : {})
  }
  await writeJsonAtomic(join(turnRoot(root, open.generation), 'events', `${id}.json`), stored, { sync: false })
  // 子 agent 线程有自己的 transcript；顶层轮的 transcript 锚点不能被它改写，否则整轮证据会读错文件。
  const transcriptPath = subagentScopedPayload(payload) ? undefined : transcriptPathOf(payload)
  if (transcriptPath && transcriptPath !== open.transcriptPath) {
    open.transcriptPath = transcriptPath
    open.transcriptStartOffset = 0
    await writeJsonAtomic(openPath(root), open, { sync: false })
  } else if (transcriptPath && open.transcriptStartOffset == null) {
    open.transcriptStartOffset = 0
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  return id
}

function terminalStatus(payload: Record<string, unknown>, fallback: AgentTurnRecord['status']): AgentTurnRecord['status'] {
  const status = stringAt(payload, 'status', 'outcome', 'reason')?.toLowerCase()
  if (status?.includes('cancel')) return 'cancelled'
  if (status?.includes('interrupt')) return 'interrupted'
  if (status?.includes('fail') || status?.includes('error') || payload.error != null) return 'failed'
  return fallback
}

/** Re-stamp every populated evidence section as `partial` with one shared reason. */
function degradeEvidenceSections(evidence: TurnEvidence, reason: string): void {
  const source = evidence.tools.source
  if (evidence.tools.value) evidence.tools = partial(evidence.tools.value, source, reason)
  if (evidence.skills.value) evidence.skills = partial(evidence.skills.value, source, reason)
  if (evidence.mcps.value) evidence.mcps = partial(evidence.mcps.value, source, reason)
  if (evidence.files.value) evidence.files = partial(evidence.files.value, source, reason)
  if (evidence.errors.value) evidence.errors = partial(evidence.errors.value, source, reason)
  if (evidence.usage.value) evidence.usage = partial(evidence.usage.value, source, reason)
  if (evidence.hooks.value) evidence.hooks = partial(evidence.hooks.value, source, reason)
  if (evidence.compactions?.value) evidence.compactions = partial(evidence.compactions.value, source, reason)
  if (evidence.modelSegments?.value) evidence.modelSegments = partial(evidence.modelSegments.value, source, reason)
  if (evidence.dangerousOperations.value) {
    evidence.dangerousOperations = partial(evidence.dangerousOperations.value, source, reason)
  }
  if (evidence.modelTiming?.value && evidence.modelTiming.value.method !== 'provider_api') {
    evidence.modelTiming = partial(evidence.modelTiming.value, evidence.modelTiming.source, reason)
  }
}

async function persistRecorderEventContent(
  events: TraceEvent[],
  policy: ToolContentPolicy,
  source: string,
  dataRoot: string
): Promise<TraceEvent[]> {
  const tools = await persistToolEventContent(
    events, policy, source,
    (content, encoding) => writeRecorderContent(dataRoot, content, encoding)
  )
  return persistModelEventContent(
    tools, source,
    (content, encoding) => writeRecorderContent(dataRoot, content, encoding)
  )
}

async function persistTurnDiffContent(
  dataRoot: string,
  snapshots: import('../../shared/trace.js').TurnDiffSnapshot[]
): Promise<import('../../shared/trace.js').TurnDiffSnapshot[]> {
  return Promise.all(snapshots.map(async (snapshot) => ({
    ...snapshot,
    files: await Promise.all(snapshot.files.map(async (file) => {
      if (!file.patch) return file
      const full = captureToolContent(file.patch, {
        source: 'git_turn_diff', maxBytes: null, sourceCompleteness: 'complete'
      })
      if (full.content === undefined) return file
      const contentRef = await writeRecorderContent(dataRoot, full.content, 'utf8')
      const patchContent = { ...full, contentRef }
      return {
        ...file,
        patch: patchContent.content,
        patchContent,
        patchStatus: patchContent.storage === 'complete' ? 'captured' as const : 'truncated' as const
      }
    }))
  })))
}

async function finalizeOpenTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: OpenTurnState,
  payload: Record<string, unknown>,
  fallbackStatus: AgentTurnRecord['status'],
  options: {
    allowUnstableTranscript?: boolean
    /**
     * Stop waiting for evidence that will never arrive and force this turn closed, recording why.
     * Independent of the outcome: an open turn that never ended is `interrupted`, a turn whose
     * terminal already arrived stays `completed` - what this gates is giving up, not the verdict.
     */
    forcedReason?: string
  } = {}
): Promise<RecorderHookResult> {
  const root = sessionRoot(enablement.dataRoot, open.provider, open.sessionId)
  const runId = `${open.provider}:${open.sessionId}:${open.generation}`
  let transcript = open.transcriptPath
    ? await stableTranscript(
        open.transcriptPath,
        runId,
        open.provider,
        open.promptHash,
        open.providerTurnId,
        open.transcriptStartOffset
      )
    : {
        stable: true,
        observed: false,
        complete: true,
        events: [],
        observable: {
          tools: false,
          skills: false,
          mcps: false,
          hooks: false,
          usage: false,
          files: false,
          errors: false
        }
      }
  if (!transcript.stable && !options.allowUnstableTranscript) return { status: 'pending', reason: 'transcript is still changing' }
  let identityUnmatched = false
  if (transcript.identityMatched === false) {
    // Waiting for identity to appear is right while a turn may still converge, but an expired turn
    // never will: Providers rotate transcripts away, and holding the turn open forever loses it and
    // keeps the daemon alive. Close it on lifecycle evidence alone rather than borrowing content
    // that was never confirmed to be this turn's.
    if (!options.forcedReason) return { status: 'pending', reason: 'target turn is not present in transcript snapshot' }
    identityUnmatched = true
    transcript = {
      stable: true,
      observed: false,
      complete: false,
      events: [],
      observable: { tools: false, skills: false, mcps: false, hooks: false, usage: false, files: false, errors: false }
    }
  }
  const contentPolicy = open.toolContentPolicy ?? enablement.config.capture
  const storedEvents = await readStoredEvents(join(turnRoot(root, open.generation), 'events'))
  const transcriptEvents = await persistRecorderEventContent(
    transcript.events,
    contentPolicy,
    'provider_transcript',
    enablement.dataRoot
  )
  const mergedEvents = mergeTurnTraceEvents(storedEvents, transcriptEvents, transcript.toolStreamComplete === true)
  // An expired turn's baseline can be days old, so finishing its diff would attribute every later
  // change — including other turns' work — to this one. Release the baseline instead of publishing
  // an attribution we cannot defend, and say why.
  if (options.forcedReason) {
    await Promise.all(open.captures.map(({ capture }) => cancelGitTurnDiff(capture).catch(() => undefined)))
  }
  const diffs = options.forcedReason
    ? []
    : limitTurnDiffPatchBytes(await persistTurnDiffContent(
        enablement.dataRoot,
        await Promise.all(open.captures.map(async ({ repository, capture }) =>
          finishGitTurnDiff(capture, undefined, {
            ...turnChangeHints(repository, mergedEvents),
            patchExcludeBasenames: enablement.config.capture.patchExcludeBasenames,
            completePatches: true
          })
        ))
      ))
  const diffEvents: TraceEvent[] = diffs.map((turnDiff, index) => ({
    id: `diff-${open.generation}-${index}`,
    ts: turnDiff.afterAt,
    runId,
    kind: 'harness',
    stage: 'turn_diff',
    turnDiff
  }))
  const startedAt = transcript.startedAt ?? open.startedAt
  const end = resolveTurnEnd(open, startedAt, transcript, mergedEvents, options.forcedReason ? 'expired' : undefined)
  const completedAt = end.completedAt
  const startedMs = Date.parse(startedAt)
  const completedMs = Date.parse(completedAt)
  const wallDurationMs = Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
    ? completedMs - startedMs
    : undefined
  const wallEvents: TraceEvent[] = wallDurationMs == null ? [] : [{
    id: `turn-wall-${open.generation}`,
    ts: completedAt,
    runId,
    kind: 'harness',
    stage: 'turn_wall',
    durationMs: wallDurationMs,
    runtimeMetadata: { source: 'recorder_observed_wall' }
  }]
  const events = dedupeTraceEvents([...mergedEvents, ...wallEvents, ...diffEvents])
  const hasUsage = events.some((event) => event.kind === 'harness' && (event.stage === 'result' || event.stage === 'credit_usage'))
  const hasToolEvidence = events.some((event) =>
    event.stage !== 'tool_result' && ['tool', 'skill', 'agent'].includes(event.kind) && !!(event.tool || event.name)
  )
  const hasHookEvidence = events.some((event) => event.kind === 'hook')
  const evidence = aggregateTurnEvidence({
    userText: open.provider === 'qoder' || open.provider === 'claude'
      ? open.prompt ?? transcript.userText
      : transcript.userText ?? open.prompt,
    events,
    source: transcript.observed ? 'provider_transcript+lifecycle_hooks' : 'lifecycle_hooks',
    toolContentPolicy: open.toolContentPolicy ?? enablement.config.capture,
    observable: {
      assistant: transcript.observed || events.some((event) => event.kind === 'model' && event.stage === 'text'),
      tools: hasToolEvidence || transcript.observable.tools,
      skills: events.some((event) => event.kind === 'skill') || transcript.observable.skills,
      mcps: events.some((event) => event.kind === 'tool' && event.isMcp) || transcript.observable.mcps,
      hooks: enablement.config.capture.hooks && (hasHookEvidence || transcript.observable.hooks),
      usage: hasUsage || transcript.observable.usage,
      files: events.some((event) => !!event.filePath && !!event.fileOp) || transcript.observable.files,
      errors: hasToolEvidence || transcript.observable.errors || events.some((event) =>
        event.kind === 'harness' && event.stage === 'task_error' && event.isError === true
      ),
      diff: enablement.config.capture.diff
    }
  })
  if (transcript.complete === false) {
    degradeEvidenceSections(
      evidence,
      'transcript snapshot was incomplete or one or more child agent transcripts were unavailable'
    )
  }
  // A force-closed turn stopped converging, so nothing it holds can be called complete even when
  // the transcript window itself parsed cleanly.
  if (options.forcedReason) {
    const reason = identityUnmatched
      ? `${options.forcedReason}; the transcript no longer contains this turn, so only lifecycle-hook evidence remains`
      : options.forcedReason
    degradeEvidenceSections(evidence, reason)
    evidence.diff = unavailable(
      `${options.forcedReason}; the turn diff baseline spans that window and cannot be attributed to this turn`
    )
    if (identityUnmatched) {
      evidence.assistant = unavailable(`${options.forcedReason}; the transcript no longer contains this turn`)
      evidence.modelSegments = unavailable(`${options.forcedReason}; the transcript no longer contains this turn`)
    }
  }
  if (!enablement.config.capture.prompt) evidence.user = disabled('prompt capture disabled by config')
  if (!enablement.config.capture.assistant) {
    evidence.assistant = disabled('assistant capture disabled by config')
    evidence.modelSegments = disabled('assistant capture disabled by config')
  }
  if (!enablement.config.capture.hooks) evidence.hooks = disabled('hook capture disabled by config')
  const transcriptEvidence: NonNullable<TurnEvidence['transcript']> = await (async (): Promise<NonNullable<TurnEvidence['transcript']>> => {
    if (!open.transcriptPath) return unavailable('provider transcript path was not observable')
    if (!enablement.config.capture.prompt || !enablement.config.capture.assistant || !isFullToolContentPolicy(contentPolicy)) {
      return disabled('raw transcript capture disabled by content policy')
    }
    if (!transcript.source) return unavailable('stable transcript bytes were not available for this turn')
    const source = transcript.source
    if (Buffer.byteLength(source.content) !== source.endOffset - source.startOffset) {
      return unavailable('transcript range was not valid UTF-8 and could not be stored exactly')
    }
    const contentRef = await writeRecorderContent(enablement.dataRoot, source.content, 'utf8')
    const value = {
      contentRef,
      sourcePath: source.sourcePath,
      startOffset: source.startOffset,
      endOffset: source.endOffset,
      identity: source.identity,
      sourceCompleteness: source.sourceCompleteness
    }
    return source.sourceCompleteness === 'complete'
      ? available(value, ['provider_transcript'])
      : partial(value, ['provider_transcript'], 'transcript parser window started after an incomplete source line', 'exact')
  })()
  const recordId = stableHash({
    workspace: enablement.config.workspaceId,
    provider: open.provider,
    sessionId: open.sessionId,
    generation: open.generation,
    startedAt: open.startedAt
  }).slice(0, 32)
  // Only explicit, turn-scoped lifecycle evidence can associate a workflow.
  // The numeric recorder generation is independent of the caller's generation.
  const taskEvents = storedEvents.filter((event) => event.stage === 'task_context' && event.kind === 'harness')
  const taskContexts = new Map(taskEvents.map((event) => [stableHash([
    event.runtimeMetadata?.invalid, event.runtimeMetadata?.taskId, event.runtimeMetadata?.taskGeneration
  ]), event.runtimeMetadata]))
  const taskContext = taskContexts.size === 1 ? [...taskContexts.values()][0] : undefined
  const boundTask = taskContext && taskContext.invalid !== true && typeof taskContext.taskId === 'string' &&
    typeof taskContext.taskGeneration === 'string' ? taskContext : undefined
  const modelEvents = storedEvents.filter((event) => event.stage === 'provider_model' && event.kind === 'harness')
  const models = new Set(modelEvents.flatMap((event) => {
    const ids = event.runtimeMetadata?.modelIds
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  }))
  // A dropped model used to be indistinguishable from a provider that never
  // reports one, which pushed consumers toward inferring the requested model.
  // Each cause now gets its own status and reason, and none of them permits a
  // guess.
  const modelIdentity = resolveModelIdentity(modelEvents, models, evidence.usage.value?.model)
  const model = modelIdentity.model
  const turnRoleEvents = storedEvents.filter((event) => event.stage === 'turn_role' && event.kind === 'harness')
  const turnRoles = new Map(turnRoleEvents.map((event) => [stableHash([
    event.runtimeMetadata?.invalid, event.runtimeMetadata?.role, event.runtimeMetadata?.roleSource,
    event.runtimeMetadata?.roleParentId, event.runtimeMetadata?.reviewedSessionId
  ]), event.runtimeMetadata]))
  const turnRoleMetadata = turnRoles.size === 1 ? [...turnRoles.values()][0] : undefined
  const observedTurnRole = turnRoleMetadata && turnRoleMetadata.invalid !== true &&
    typeof turnRoleMetadata.role === 'string' && typeof turnRoleMetadata.roleSource === 'string'
    ? {
        role: String(turnRoleMetadata.role),
        source: String(turnRoleMetadata.roleSource),
        ...(typeof turnRoleMetadata.roleParentId === 'string' ? { parentId: String(turnRoleMetadata.roleParentId) } : {}),
        ...(typeof turnRoleMetadata.reviewedSessionId === 'string'
          ? { reviewedSessionId: String(turnRoleMetadata.reviewedSessionId) }
          : {})
      }
    : undefined
  const draft: Omit<AgentTurnRecord, 'sequence'> = {
    schemaVersion: 1,
    recordKind: 'agent_turn',
    recordId,
    recorderVersion: RECORDER_VERSION,
    workspace: { id: enablement.config.workspaceId, root: enablement.workspaceRoot },
    provider: {
      id: open.provider,
      ...(model ? { model } : {}),
      modelStatus: modelIdentity.status,
      ...(modelIdentity.source ? { modelSource: modelIdentity.source } : {}),
      ...(modelIdentity.omissionReason ? { modelOmissionReason: modelIdentity.omissionReason } : {})
    },
    linkedTaskId: boundTask ? String(boundTask.taskId) : null,
    ...(boundTask ? { linkedTaskGeneration: String(boundTask.taskGeneration) } : {}),
    taskLinkStatus: boundTask ? 'bound' : taskEvents.length ? 'conflict' : 'unbound',
    // Absence of a host-supplied role is reported as `unobserved`, never as a
    // main-agent turn: text prefixes are not an identity boundary.
    turnRoleStatus: observedTurnRole ? 'observed' : turnRoleEvents.length ? 'conflict' : 'unobserved',
    ...(observedTurnRole ? { turnRole: observedTurnRole } : {}),
    sessionId: open.sessionId,
    ...(open.providerTurnId ? { providerTurnId: open.providerTurnId } : {}),
    generation: open.generation,
    turnIndex: open.turnIndex,
    startedAt,
    completedAt,
    durationMs: (end.termination.value?.completedAtSource === 'provider_transcript' ? transcript.durationMs : undefined) ?? (
      Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : 0
    ),
    status: transcript.terminalStatus ?? terminalStatus(payload, fallbackStatus),
    termination: end.termination,
    transcript: transcriptEvidence,
    ...evidence
  }
  const committed = await commitRecord(enablement.dataRoot, draft)
  const session = await nextSessionState(enablement.dataRoot, root, open.provider, open.sessionId)
  const committedProviderTurnIds = open.providerTurnId
    ? [...new Set([...(session.committedProviderTurnIds ?? []), open.providerTurnId])].slice(-200)
    : session.committedProviderTurnIds
  await writeJsonAtomic(statePath(root), {
    ...session,
    lastCommittedRecordId: committed.record.recordId,
    ...(committedProviderTurnIds ? { committedProviderTurnIds } : {})
  }, { sync: false })
  await rm(openPath(root), { force: true })
  await clearRuntimeTurn(enablement.dataRoot, turnRoot(root, open.generation))
  return { status: committed.status, record: committed.record }
}

function isClaudeTaskNotification(payload: Record<string, unknown>): boolean {
  const origin = nestedRecord(payload, 'origin')
  return stringAt(origin ?? {}, 'kind') === 'task-notification' ||
    (promptOf(payload)?.trimStart().startsWith('<task-notification>') ?? false)
}

function continuationProviderTurnIds(open: OpenTurnState): string[] {
  return open.continuationProviderTurnIds ?? []
}

async function rememberContinuationProviderTurn(
  root: string,
  open: OpenTurnState,
  providerTurnId: string | undefined
): Promise<void> {
  if (!providerTurnId || providerTurnId === open.providerTurnId) return
  const ids = [...new Set([...continuationProviderTurnIds(open), providerTurnId])].slice(-200)
  open.continuationProviderTurnIds = ids
  await writeJsonAtomic(openPath(root), open, { sync: false })
}

function isContinuationProviderTurn(open: OpenTurnState, providerTurnId: string | undefined): boolean {
  return !!providerTurnId && continuationProviderTurnIds(open).includes(providerTurnId)
}

function isSynthetic(payload: Record<string, unknown>): boolean {
  return payload.isMeta === true || payload.synthetic === true || stringAt(payload, 'source') === 'synthetic'
}

/**
 * Codex guardian (auto-review) subagents reuse the parent session_id and carry no agent_id,
 * but their transcript_path is the child's own rollout, whose first `session_meta` row
 * declares `source.subagent`. A rollout named after the session itself is the main thread
 * and is never opened.
 */
async function codexSubagentTranscript(payload: Record<string, unknown>, sessionId: string): Promise<boolean> {
  const path = transcriptPathOf(payload)
  if (!path) return false
  const name = basename(path)
  if (!name.startsWith('rollout-') || !name.endsWith('.jsonl') || name.includes(sessionId)) return false
  let handle
  try {
    handle = await openFile(path, 'r')
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
      if (bytesRead === 0) break
      const slice = chunk.subarray(0, bytesRead)
      const newline = slice.indexOf(0x0a)
      chunks.push(newline >= 0 ? slice.subarray(0, newline) : slice)
      total += bytesRead
      if (newline >= 0 || total >= 4 * 1024 * 1024) break
    }
    const first = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    const meta = first.type === 'session_meta' ? nestedRecord(first, 'payload') : undefined
    const source = meta ? nestedRecord(meta, 'source') : undefined
    return !!source && 'subagent' in source
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

function trustedManagedIdentityPayload(
  payload: Record<string, unknown>,
  managed: boolean | undefined,
  env: NodeJS.ProcessEnv
): Record<string, unknown> {
  const trusted = { ...payload }
  delete trusted.scry_managed_run_id
  delete trusted.scry_managed_prompt_hash
  delete trusted[CODEX_SUBAGENT_MARKER]
  if (!managed) return trusted
  const runId = env.SCRY_MANAGED_RUN_ID?.trim()
  const promptHash = env.SCRY_MANAGED_PROMPT_HASH?.trim()
  if (runId && runId.length <= 256 && !/[\r\n]/.test(runId) && promptHash && /^[a-f0-9]{64}$/.test(promptHash)) {
    trusted.scry_managed_run_id = runId
    trusted.scry_managed_prompt_hash = promptHash
  }
  return trusted
}

async function isCommittedProviderTurn(
  dataRoot: string,
  root: string,
  provider: ProviderId,
  sessionId: string,
  providerTurnId: string
): Promise<boolean> {
  const state = await readJson<SessionState>(statePath(root))
  if (state?.committedProviderTurnIds?.includes(providerTurnId)) return true
  return (await listRecords(dataRoot)).some((record) =>
    record.provider.id === provider &&
    record.sessionId === sessionId &&
    record.providerTurnId === providerTurnId
  )
}

async function storeOrphanEvent(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  root: string,
  input: RecorderHookInput,
  missingStart: boolean
): Promise<{ status: 'orphan' }> {
  const id = stableHash({ event: input.event, payload: input.payload })
  const path = join(root, 'orphans', `${id}.json`)
  // The session lock serializes delivery and inbox replay. Replays keep the first observation.
  if (await readJson(path)) return { status: 'orphan' }
  const capture = enablement.config.capture
  // Opaque payloads mix prompts, assistant text and tools. Do not bypass disabled categories.
  const capturePayload = capture.prompt && capture.assistant && isFullToolContentPolicy(capture)
  const reason = missingStart ? 'missing_start' : 'no_matching_open_turn'
  const at = observedNow()
  await writeJsonAtomic(path, {
    schemaVersion: 1, event: input.event, observedAt: at, reason,
    payload: captureToolContent(capturePayload ? input.payload : undefined, {
      source: 'orphan_hook', maxBytes: Math.min(capture.toolContentFieldBytes ?? 8 * 1024, capture.toolContentTurnBytes ?? 128 * 1024)
    }),
    ...(!capturePayload ? { omissionReason: 'capture_policy' } : {})
  })
  await updateHealth(enablement.dataRoot, {
    lastError: { at, message: `orphan recorder event: ${input.event} (${reason})` },
    increment: { orphanEvents: 1, ...(missingStart ? { missingStartTerminals: 1 } : {}) }
  })
  await appendRotatingLog(join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${at} WARN orphan ${input.provider} ${input.event} ${reason} id=${id}`)
  return { status: 'orphan' }
}

async function applyHookLocked(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  input: RecorderHookInput,
  sessionId: string
): Promise<RecorderHookResult> {
  const taskNotification = input.provider === 'claude' &&
    START_EVENTS.has(input.event) &&
    isClaudeTaskNotification(input.payload)
  const root = sessionRoot(enablement.dataRoot, input.provider, sessionId)
  let open = await readJson<OpenTurnState>(openPath(root))
  const incomingProviderTurnId = providerTurnIdOf(input.payload, input.provider)
  if (taskNotification) {
    if (!open) return { status: 'ignored' as const, reason: 'task notification has no real user turn' }
    if (open.managedByScry) {
      return { status: 'recorded' as const, reason: 'managed task continuation kept in canonical Scry turn' }
    }
    await rememberContinuationProviderTurn(root, open, incomingProviderTurnId)
    await storeLifecycleEvent(enablement, open, input.event, input.payload)
    return { status: 'recorded' as const, reason: 'task notification continued the current Claude turn' }
  }
  if (START_EVENTS.has(input.event) && subagentScopedPayload(input.payload)) {
    // A sub-agent prompt is not a new user turn: superseding the open parent turn here would end
    // it early and orphan every later parent event.
    if (!open) return { status: 'ignored', reason: 'sub-agent prompt has no open parent turn' }
    await storeLifecycleEvent(enablement, open, input.event, input.payload)
    return { status: 'recorded', reason: 'sub-agent turn attributed to the open parent turn' }
  }
  if (START_EVENTS.has(input.event)) {
    const providerTurnId = incomingProviderTurnId
    const startFingerprint = startFingerprintOf(input.provider, input.event, input.payload)
    let protectNextStart = input.managed !== true && STALE_TERMINAL_PROVIDERS.has(input.provider) && !providerTurnId
    const incomingManagedRunId = stringAt(input.payload, 'scry_managed_run_id')
    const incomingManagedPromptHash = stringAt(input.payload, 'scry_managed_prompt_hash')
    const hasManagedIdentity = !!(
      open?.managedRunId || open?.managedPromptHash ||
      incomingManagedRunId || incomingManagedPromptHash
    )
    const sameManagedIdentity = hasManagedIdentity &&
      !!open?.managedRunId && !!open.managedPromptHash &&
      open.managedRunId === incomingManagedRunId &&
      open.managedPromptHash === incomingManagedPromptHash
    const sameManagedQoderPrompt = input.provider === 'qoder' &&
      input.managed === true &&
      open?.managedByScry === true &&
      !providerTurnId &&
      !open.providerTurnId &&
      !!open.prompt &&
      open.prompt === promptOf(input.payload) &&
      (hasManagedIdentity ? sameManagedIdentity : true)
    if (
      providerTurnId &&
      providerTurnId !== open?.providerTurnId &&
      await isCommittedProviderTurn(enablement.dataRoot, root, input.provider, sessionId, providerTurnId)
    ) return { status: 'duplicate' as const }
    if (open && (
      open.startFingerprint === startFingerprint ||
      (providerTurnId && open.providerTurnId === providerTurnId) ||
      sameManagedQoderPrompt
    )) return { status: 'duplicate' as const }
    if (open) {
      if (open.managedByScry && !input.managed) {
        return { status: 'recorded' as const, reason: 'managed lifecycle start ignored' }
      }
      if (open.managedByScry || input.managed) {
        await quarantineOpenTurn(
          enablement.dataRoot,
          root,
          open,
          open.managedByScry ? 'managed_replaced' : 'legacy_migration'
        )
      } else {
        const fallback = open.status === 'closing' ? 'completed' : 'interrupted'
        protectNextStart ||= fallback === 'interrupted' &&
          STALE_TERMINAL_PROVIDERS.has(input.provider) &&
          !open.providerTurnId &&
          !providerTurnId
        open.status = 'closing'
        // The new prompt only proves this turn stopped converging. Its timestamp is this turn's
        // successor, not its end, so it may set neither terminalAt nor completedAt.
        open.closingAt ??= timestampOf(input.payload)
        open.endReason ??= fallback === 'interrupted' ? 'superseded_by_next_turn' : 'provider_terminal'
        await writeJsonAtomic(openPath(root), open, { sync: false })
        const finalized = await finalizeOpenTurn(enablement, open, input.payload, fallback, { allowUnstableTranscript: true })
        if (finalized.status === 'pending') return finalized
      }
    }
    open = await beginOpenTurn(
      enablement,
      input.provider,
      sessionId,
      input.event,
      input.payload,
      input.managed === true,
      protectNextStart
    )
    if (!open.managedByScry) await storeLifecycleEvent(enablement, open, input.event, input.payload)
    return { status: 'started' as const }
  }
  if (!open) {
    // Shutdown between turns is normal. A Stop-hook continuation also does not prove a missing
    // start; only an actual first terminal can provide that evidence. Keep open-turn handling below.
    if (SESSION_END_EVENTS.has(input.event) || (
      input.event === 'Stop' && STOP_HOOK_ACTIVE_PROVIDERS.has(input.provider) && input.payload.stop_hook_active === true
    )) return { status: 'duplicate' as const }
    const terminal = END_EVENTS.has(input.event)
    if (terminal) {
      if (incomingProviderTurnId && await isCommittedProviderTurn(enablement.dataRoot, root, input.provider, sessionId, incomingProviderTurnId)) {
        return { status: 'duplicate' as const }
      }
      const terminalAt = explicitTimestampOf(input.payload)
      if (!incomingProviderTurnId && terminalAt) {
        const terminalMs = Date.parse(terminalAt)
        const state = await readJson<SessionState>(statePath(root))
        const record = state?.lastCommittedRecordId ? await findRecordById(enablement.dataRoot, state.lastCommittedRecordId) : undefined
        if (record?.provider.id === input.provider && record.sessionId === sessionId &&
          terminalMs >= Date.parse(record.startedAt) && terminalMs <= Date.parse(record.completedAt) &&
          record.termination?.value?.completedAtSource === 'provider_terminal_event') {
          return { status: 'duplicate' as const }
        }
      }
    }
    if (input.managed && !terminal) return { status: 'ignored' as const, reason: 'managed turn has no open identity' }
    return storeOrphanEvent(enablement, root, input, terminal)
  }
  if (open.managedByScry) {
    if (!END_EVENTS.has(input.event) && !SESSION_END_EVENTS.has(input.event)) return { status: 'recorded' as const }
    open.status = 'closing'
    open.closingAt = timestampOf(input.payload)
    open.endReason ??= SESSION_END_EVENTS.has(input.event) ? 'session_end' : 'provider_terminal'
    await writeJsonAtomic(openPath(root), open)
    return { status: 'pending' as const, reason: 'managed turn awaits canonical Scry evidence' }
  }
  if (
    incomingProviderTurnId &&
    open.providerTurnId &&
    incomingProviderTurnId !== open.providerTurnId &&
    !isContinuationProviderTurn(open, incomingProviderTurnId)
  ) {
    if (await isCommittedProviderTurn(enablement.dataRoot, root, input.provider, sessionId, incomingProviderTurnId)) {
      return { status: 'duplicate' as const }
    }
    // 子 agent 线程复用父会话 id，但带自己的 turn_id（Codex 实测：agent_id/agent_type 同时出现）。
    // 这类事件属于当前打开的顶层轮，不能丢成 orphan；但它的终态只结束子 agent，不结束父轮。
    if (subagentScopedPayload(input.payload)) {
      await storeLifecycleEvent(enablement, open, input.event, input.payload)
      return { status: 'recorded' as const, reason: 'sub-agent turn attributed to the open parent turn' }
    }
    return storeOrphanEvent(enablement, root, input, END_EVENTS.has(input.event) || SESSION_END_EVENTS.has(input.event))
  }
  const sessionEndEvent = SESSION_END_EVENTS.has(input.event)
  const endEvent = END_EVENTS.has(input.event) || sessionEndEvent
  if (open.deferredTerminalEventId) {
    if (endEvent) return { status: 'pending' as const, reason: 'unidentified terminal is already deferred' }
    await rm(join(turnRoot(root, open.generation), 'events', `${open.deferredTerminalEventId}.json`), { force: true })
    open.status = 'open'
    delete open.closingAt
    delete open.deferredTerminalAt
    delete open.deferredTerminalEventId
    delete open.staleTerminalProtection
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  const explicitTerminalAt = endEvent && !incomingProviderTurnId ? explicitTimestampOf(input.payload) : undefined
  // Stale-terminal protection weighs one Provider terminal against a possibly newer one. A session
  // or process end has no such competitor: deferring or discarding it would leave the turn open
  // for the next prompt to close, which is the inflation this path exists to prevent.
  if (!sessionEndEvent && explicitTerminalAt && Date.parse(explicitTerminalAt) < Date.parse(open.startedAt)) {
    return { status: 'duplicate' as const, reason: 'stale unidentified terminal predates the open turn' }
  }
  if (endEvent && !sessionEndEvent && !incomingProviderTurnId && !explicitTerminalAt && open.staleTerminalProtection) {
    const terminalAt = explicitTerminalAt ?? timestampOf(input.payload)
    const elapsed = Date.parse(terminalAt) - Date.parse(open.startedAt)
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= STALE_TERMINAL_WINDOW_MS) {
      const eventId = await storeLifecycleEvent(enablement, open, input.event, input.payload)
      open.status = 'closing'
      open.closingAt = terminalAt
      open.terminalAt = terminalAt
      open.terminalAtSource = 'recorder_observed_terminal'
      open.endReason ??= 'provider_terminal'
      open.deferredTerminalAt = new Date().toISOString()
      open.deferredTerminalEventId = eventId
      await writeJsonAtomic(openPath(root), open)
      return { status: 'pending' as const, reason: 'unidentified early terminal deferred for stale-event protection' }
    }
  }
  await storeLifecycleEvent(enablement, open, input.event, input.payload)
  if (!endEvent) return { status: 'recorded' as const }
  const terminalAt = explicitTerminalAt ?? explicitTimestampOf(input.payload) ?? timestampOf(input.payload)
  open.status = 'closing'
  open.closingAt = timestampOf(input.payload)
  open.terminalAt = terminalAt
  open.terminalAtSource = explicitTimestampOf(input.payload) ? 'provider_terminal_event' : 'recorder_observed_terminal'
  open.endReason ??= sessionEndEvent ? 'session_end' : 'provider_terminal'
  // A session/process end is not a completion, and it fires while the Provider is shutting down
  // under a tight hook budget. Pin the boundary and verdict durably here, then let recovery do
  // transcript parsing and Git diff work: the end time is already fixed, so deferring cannot
  // stretch it, and a killed hook leaves a closing turn that recovery still finalizes.
  if (sessionEndEvent) open.terminalFallbackStatus ??= 'interrupted'
  await writeJsonAtomic(openPath(root), open)
  if (sessionEndEvent) {
    return { status: 'pending' as const, reason: 'session end persisted; turn aggregation deferred to recovery' }
  }
  if (
    input.provider === 'claude' &&
    input.event === 'Stop' &&
    (open.providerTurnId || continuationProviderTurnIds(open).length > 0)
  ) {
    return { status: 'pending' as const, reason: 'Claude turn awaits continuations or recorder recovery' }
  }
  return finalizeOpenTurn(enablement, open, input.payload, 'completed', { allowUnstableTranscript: true })
}

interface QueuedHook {
  schemaVersion: 1
  provider: ProviderId
  sessionId: string
  event: string
  payload: Record<string, unknown>
  managed?: boolean
  arrivedAt: string
}

function isLockTimeout(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ELOCKTIMEOUT'
}

function hookInbox(dataRoot: string, provider: ProviderId, sessionId: string): string {
  return join(sessionRoot(dataRoot, provider, sessionId), 'inbox')
}

async function queueHook(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  input: RecorderHookInput,
  sessionId: string,
  arrivedAt: string
): Promise<void> {
  const entry: QueuedHook = {
    schemaVersion: 1,
    provider: input.provider,
    sessionId,
    event: input.event,
    payload: input.payload,
    ...(input.managed ? { managed: true } : {}),
    arrivedAt
  }
  // Names sort by arrival; the UUID only separates hooks that arrive in the same millisecond.
  const name = `${String(Date.parse(arrivedAt)).padStart(15, '0')}-${randomUUID()}.json`
  await writeJsonAtomic(join(hookInbox(enablement.dataRoot, input.provider, sessionId), name), entry)
  await appendRotatingLog(
    join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} WARN session lock busy; queued ${input.provider} ${input.event} for replay (arrived ${arrivedAt})`
  ).catch(() => undefined)
}

/**
 * Apply queued hooks in arrival order. Caller must hold the session lock. Delivery is
 * at-least-once: a crash between apply and unlink replays the hook, which the lifecycle
 * event ids, start fingerprints and committed-turn checks already absorb.
 */
async function replayQueuedHooks(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionKey: string,
  includeFailed = false
): Promise<number> {
  const root = join(enablement.dataRoot, 'runtime', provider, sessionKey)
  const warn = (name: string, error: unknown) => appendRotatingLog(
    join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} WARN inbox ${provider}/${sessionKey}/${name}: ${error instanceof Error ? error.message : String(error)}`
  ).catch(() => undefined)
  let replayed = 0
  // Each pass is arrival-ordered. An isolated older failure cannot block later arrivals; a retry
  // can therefore execute after them. Lifecycle deduplication, not exactly-once delivery, applies.
  for (const entry of await recorderInboxEntries(root, includeFailed)) {
    let attempts: number
    try {
      attempts = (await readInboxFailure(entry))?.attempts ?? 0
    } catch (error) {
      // Do not overwrite an unreadable attempt counter or block the remaining files.
      await warn(entry.name, error)
      continue
    }
    if (attempts >= INBOX_MAX_ATTEMPTS) continue
    try {
      const queued = await readInboxJson<QueuedHook>(entry.path)
      if (queued === null) continue // ENOENT only: another completed cleanup, not a lost event.
      if (queued.schemaVersion !== 1 || queued.provider !== provider ||
        typeof queued.sessionId !== 'string' || safeKey(queued.sessionId) !== sessionKey ||
        typeof queued.event !== 'string' || !queued.payload || typeof queued.payload !== 'object' ||
        Array.isArray(queued.payload) || typeof queued.arrivedAt !== 'string' ||
        !Number.isFinite(Date.parse(queued.arrivedAt))) {
        throw new Error(`invalid queued recorder hook: ${entry.name}`)
      }
      await hookArrival.run(queued.arrivedAt, () => applyHookLocked(enablement, {
        provider,
        event: queued.event,
        workspace: enablement.workspaceRoot,
        payload: queued.payload,
        managed: queued.managed
      }, queued.sessionId))
    } catch (error) {
      try {
        await quarantineInboxEntry(entry, attempts + 1, error)
        if (attempts + 1 === INBOX_MAX_ATTEMPTS) {
          await recordError(enablement.dataRoot, `inbox retries exhausted ${provider}/${sessionKey}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      } catch (isolationError) {
        // The source remains in place if it cannot be moved; never delete it to make progress.
        await warn(entry.name, isolationError)
      }
      await warn(entry.name, error)
      continue
    }
    // Cleanup failure is not another failed apply. Keeping the event gives at-least-once replay.
    try {
      await rm(entry.path, { force: true })
      await rm(entry.failurePath, { force: true })
      replayed++
    } catch (error) {
      await warn(entry.name, error)
    }
  }
  return replayed
}

export async function handleRecorderHook(input: RecorderHookInput): Promise<RecorderHookResult> {
  // Taken before the lock wait: a hook queued after HOOK_LOCK_WAIT_MS still arrived now.
  const arrivedAt = new Date().toISOString()
  input = {
    ...input,
    payload: trustedManagedIdentityPayload(input.payload, input.managed, input.env ?? process.env)
  }
  const enablement = await resolveRecorderEnablement(input.workspace, input.env)
  if (!enablement.enabled) {
    if (enablement.reason === 'invalid_config') {
      // Observational hook remains fail-open even if the diagnostic directory is unwritable.
      await recordInvalidHookConfig(input.workspace, input.provider, input.event).catch(() => undefined)
    }
    return { status: 'disabled', reason: enablement.reason }
  }
  const sessionId = sessionIdOf(input.payload)
  if (!sessionId) {
    await recordError(enablement.dataRoot, `missing session id for ${input.event}`)
    return { status: 'ignored', reason: 'missing session id' }
  }
  const taskNotification = input.provider === 'claude' &&
    START_EVENTS.has(input.event) &&
    isClaudeTaskNotification(input.payload)
  if (isSynthetic(input.payload) && !taskNotification) return { status: 'ignored', reason: 'synthetic/meta prompt' }
  if (input.provider === 'codex' && await codexSubagentTranscript(input.payload, sessionId)) {
    input = { ...input, payload: { ...input.payload, [CODEX_SUBAGENT_MARKER]: true } }
  }
  try {
    let entered = false
    let result: RecorderHookResult
    try {
      result = await withRecorderSessionLock(enablement.dataRoot, input.provider, sessionId, async () => {
        entered = true
        await replayQueuedHooks(enablement, input.provider, safeKey(sessionId))
        return applyHookLocked(enablement, input, sessionId)
      }, { waitMs: HOOK_LOCK_WAIT_MS })
    } catch (error) {
      if (entered || !isLockTimeout(error)) throw error
      // The session is busy (a long finalize, recovery or a stuck peer). The event was never applied,
      // so queue it durably instead of dropping it; the next lock holder replays it in arrival order.
      await queueHook(enablement, input, sessionId, arrivedAt)
      return { status: 'pending', reason: 'session busy; event queued for replay' }
    }
    try {
      const pending = START_EVENTS.has(input.event) || END_EVENTS.has(input.event)
        ? await pendingHealth(enablement.dataRoot)
        : undefined
      if (pending) {
        await updateHealth(enablement.dataRoot, {
          lastSuccessAt: new Date().toISOString(),
          ...(result.status === 'orphan' ? {} : { lastError: undefined }),
          ...pending
        })
      }
      await recordProviderActivity(enablement.dataRoot, input.provider, input.event)
      if (!input.deferDelivery) {
        const hookEnv = input.env ?? process.env
        // Bounded on the provider critical path; the remainder waits for the next hook,
        // `recorder recover`, or `recorder notify-drain`.
        await drainCommitNotifications(
          enablement.dataRoot,
          await activatedCommitHookEnv(enablement, hookEnv),
          { maxRecords: HOOK_DRAIN_MAX_RECORDS, budgetMs: HOOK_DRAIN_BUDGET_MS }
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendRotatingLog(join(enablement.dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR recorder post-processing: ${message}`).catch(() => undefined)
    }
    return result
  } catch (error) {
    await recordError(enablement.dataRoot, error)
    throw error
  }
}

/**
 * Resolve the CLI-side commit hook grant before draining notifications. A managed host
 * injects the entry itself, so `host-provided` is passed through untouched. Every other
 * invalid bundle fails closed: the env is returned unchanged, no entry is executed, and
 * the reason is logged. Valid bundles are fingerprinted and auto-authorized.
 */
async function activatedCommitHookEnv(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  env: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  try {
    const activation = await resolveCommitHookActivation(enablement.workspaceRoot, enablement.config, env)
    if (activation.status === 'bundle-invalid') {
      await appendRotatingLog(
        join(enablement.dataRoot, 'logs', 'recorder.log'),
        `${new Date().toISOString()} ERROR commit hook not activated (${activation.status}): ${activation.detail}`
      ).catch(() => undefined)
    }
    return commitHookEnv(activation, env)
  } catch {
    return env
  }
}

async function runtimeSessions(dataRoot: string): Promise<Array<{ provider: ProviderId; sessionDir: string }>> {
  const out: Array<{ provider: ProviderId; sessionDir: string }> = []
  for (const provider of ['claude', 'codex', 'qoder', 'opencode', 'pi'] as ProviderId[]) {
    const providerRoot = join(dataRoot, 'runtime', provider)
    let entries
    try {
      entries = await readdir(providerRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) if (entry.isDirectory()) out.push({ provider, sessionDir: join(providerRoot, entry.name) })
  }
  return out
}

async function pendingHealth(dataRoot: string): Promise<{ pendingCount: number; oldestPendingAgeMs: number }> {
  return recorderPendingHealth(dataRoot)
}

export async function refreshRecorderPendingHealth(dataRoot: string): Promise<void> {
  await updateHealth(dataRoot, await pendingHealth(dataRoot))
}

export async function recoverRecorder(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  probe?: RecorderRecoveryProbe
): Promise<{ recovered: number; pending: number; expired: number }> {
  const enablement = await resolveRecorderEnablement(workspace, env)
  if (!enablement.enabled) return { recovered: 0, pending: 0, expired: 0 }
  const expiryMs = OPEN_TURN_EXPIRY_MS
  let recovered = 0
  let pending = 0
  let expired = 0
  let managedPresent = false
  for (const item of await runtimeSessions(enablement.dataRoot)) {
    // Hooks queued behind a busy lock must land before this pass judges the open turn.
    if ((await recorderInboxEntries(item.sessionDir)).length) {
      // A corrupt first event must not prevent admission or later entries from replaying.
      // This on-disk key selects exactly the same lock as a live hook with that session id.
      const sessionKey = basename(item.sessionDir)
      try {
        await withRecorderSessionKeyLock(enablement.dataRoot, item.provider, sessionKey,
          () => replayQueuedHooks(enablement, item.provider, sessionKey, true), { waitMs: SESSION_LOCK_WAIT_MS })
      } catch (error) {
        if (!isLockTimeout(error)) throw error
        pending++
        continue
      }
    }
    const initial = await readJson<OpenTurnState>(openPath(item.sessionDir))
    if (!initial) continue
    // Expiry can degrade evidence only after a real terminal boundary, never create that boundary.
    let forcedExpiry = false
    const result = await withRecorderSessionLock(
      enablement.dataRoot, item.provider, initial.sessionId,
      async () => {
        const open = await readJson<OpenTurnState>(openPath(item.sessionDir))
        if (!open) return { status: 'idle' as const }
        if (open.provider !== item.provider || open.sessionId !== initial.sessionId) {
          return { status: 'idle' as const }
        }
        if (open.managedByScry) return { status: 'managed' as const }
        await probe?.(open)
        // A turn that reaches `closing` inside this pass just converged on real terminal evidence;
        // nothing has been failing to finalize, so it must not be reported as an expiry.
        const wasAlreadyClosing = open.status === 'closing'
        if (open.status === 'open') {
          if (!open.transcriptPath) return { status: 'idle' as const }
          const transcript = await stableTranscript(
            open.transcriptPath,
            `${open.provider}:${open.sessionId}:${open.generation}`,
            open.provider,
            open.promptHash,
            open.providerTurnId,
            open.transcriptStartOffset
          )
          if (!transcript.terminalStatus || !transcript.completedAt || transcript.identityMatched === false) {
            // A long tool, approval wait or silent Provider can still be running. Keep its
            // identity and diff baseline until real terminal evidence arrives.
            return { status: 'idle' as const }
          }
          open.status = 'closing'
          open.closingAt = transcript.completedAt
          open.endReason ??= 'provider_terminal'
          await writeJsonAtomic(openPath(item.sessionDir), open, { sync: false })
        }
        if (open.status !== 'closing') return { status: 'idle' as const }
        if (open.deferredTerminalAt) {
          const deferredAt = Date.parse(open.deferredTerminalAt)
          if (Number.isFinite(deferredAt) && Date.now() - deferredAt < DEFERRED_TERMINAL_GRACE_MS) {
            return { status: 'pending' as const, reason: 'unidentified terminal grace period is still active' }
          }
        }
        // A closing turn already has its terminal event, so the transcript-mtime criterion that
        // protects long-running turns does not apply: what matters is how long we have been failing
        // to finalize it. Past the window we stop retrying forever - identity that was rotated out
        // never comes back, and the diff baseline can no longer be attributed either way.
        const closingExpired = wasAlreadyClosing &&
          await closingTurnStalled(openPath(item.sessionDir), expiryMs)
        if (closingExpired) forcedExpiry = true
        return finalizeOpenTurn(
          enablement,
          open,
          { timestamp: open.closingAt ?? new Date().toISOString() },
          // The terminal event did arrive - that is what put the turn in `closing` - so calling it
          // interrupted would misreport the lifecycle. Only the evidence degrades. A deferred close
          // already decided its own verdict (session end is not a completion) and keeps it.
          open.terminalFallbackStatus ?? 'completed',
          {
            allowUnstableTranscript: true,
            ...(closingExpired ? { forcedReason: CLOSING_TURN_EXPIRED_REASON } : {})
          }
        )
      },
      { waitMs: SESSION_LOCK_WAIT_MS }
    )
    if (result.status === 'managed') managedPresent = true
    else if (result.status === 'pending') pending++
    else if (result.status === 'committed' || result.status === 'duplicate') {
      recovered++
      if (forcedExpiry) expired++
    }
  }
  if (managedPresent) {
    const managed = await recoverManagedRecorderTurns(workspace, env)
    recovered += managed.recovered
    pending += managed.pending
  }
  await updateHealth(enablement.dataRoot, {
    ...(await pendingHealth(enablement.dataRoot)),
    ...(recovered ? { increment: { recoveredRecords: recovered } } : {})
  })
  await drainCommitNotifications(enablement.dataRoot, await activatedCommitHookEnv(enablement, env))
  return { recovered, pending, expired }
}

/** Deliver committed records outside the hook response. Bounded like the inline path was. */
export async function drainRecorderDelivery(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const enablement = await resolveRecorderEnablement(workspace, env)
  if (!enablement.enabled) return
  await drainCommitNotifications(
    enablement.dataRoot,
    await activatedCommitHookEnv(enablement, env),
    { maxRecords: HOOK_DRAIN_MAX_RECORDS, budgetMs: HOOK_DRAIN_BUDGET_MS }
  ).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(
      join(enablement.dataRoot, 'logs', 'recorder.log'),
      `${new Date().toISOString()} ERROR deferred delivery: ${message}`
    ).catch(() => undefined)
  })
}

export const CLOSING_TURN_EXPIRED_REASON =
  'turn received its terminal event but could not be finalized before the expiry window closed'

/**
 * How long a `closing` turn has been failing to finalize, measured by when the recorder last wrote
 * its state rather than by `closingAt`: that field carries a Provider-supplied clock, and a skewed
 * or stale one must not trigger a decision that discards diff evidence. Every real transition
 * rewrites this file, so its mtime is the recorder's own record of last progress. An unreadable
 * state declines to force, since giving up needs positive proof.
 */
async function closingTurnStalled(path: string, expiryMs: number, now = Date.now()): Promise<boolean> {
  const touchedAt = await stat(path).then((info) => info.mtimeMs).catch(() => Number.NaN)
  if (!Number.isFinite(touchedAt)) return false
  return now - touchedAt >= expiryMs
}

export async function recorderEnablement(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<RecorderEnablement> {
  return resolveRecorderEnablement(workspace, env)
}
