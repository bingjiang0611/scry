import { AsyncLocalStorage } from 'node:async_hooks'
import { basename } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { TraceEvent } from '../../shared/trace.js'
import type { AgentTurnRecord, TurnModelSource, TurnModelStatus } from '../../shared/turn-record.js'
import { stableHash } from './store.js'
import type { RecorderOpenTurnState as OpenTurnState } from './runtime-state.js'
import type { TranscriptSnapshotIdentity } from './recorder-transcript-io.js'

export interface RecorderHookInput {
  provider: ProviderId
  event: string
  workspace: string
  payload: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  managed?: boolean
  /** Persist an uncertain transport delivery for lifecycle-deduplicated recovery, without applying it. */
  queueOnly?: boolean
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

export interface StoredLifecycleEvent {
  schemaVersion: 1
  id: string
  event: string
  observedAt: string
  traceEvents: TraceEvent[]
  transcriptPath?: string
}

export interface TranscriptRead {
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

export function stringAt(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

export function nestedRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = payload[key]
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export interface ModelIdentity {
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

export function sessionIdOf(payload: Record<string, unknown>): string | undefined {
  const direct = stringAt(payload, 'session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId')
  if (direct) return direct
  const session = nestedRecord(payload, 'session')
  if (session) return stringAt(session, 'id', 'session_id', 'sessionId')
  const transcript = transcriptPathOf(payload)
  return transcript ? basename(transcript).replace(/\.(jsonl|json)$/i, '') : undefined
}

export function transcriptPathOf(payload: Record<string, unknown>): string | undefined {
  return stringAt(payload, 'transcript_path', 'transcriptPath', 'rollout_path', 'rolloutPath')
}

export function promptOf(payload: Record<string, unknown>): string | undefined {
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

export function explicitTimestampOf(payload: Record<string, unknown>): string | undefined {
  const value = stringAt(payload, 'timestamp', 'ts', 'created_at', 'createdAt') ??
    stringAt(nestedRecord(payload, 'raw_qoder_payload') ?? {}, 'timestamp', 'ts', 'created_at', 'createdAt')
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
}

/** Arrival time of the hook being applied; a queued hook replays with the time it actually arrived. */
export const hookArrival = new AsyncLocalStorage<string>()

export function observedNow(): string {
  return hookArrival.getStore() ?? new Date().toISOString()
}

export function timestampOf(payload: Record<string, unknown>): string {
  return explicitTimestampOf(payload) ?? observedNow()
}

export function startFingerprintOf(provider: ProviderId, event: string, payload: Record<string, unknown>): string {
  const canonicalPayload = provider === 'qoder'
    ? nestedRecord(payload, 'raw_qoder_payload') ?? payload
    : payload
  return stableHash({ event, payload: canonicalPayload })
}

export function epochSecondsAt(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
    const millis = Math.round(value * 1_000)
    const date = new Date(millis)
    if (Number.isFinite(date.getTime())) return date.toISOString()
  }
  return undefined
}

export function summarize(value: unknown, max = 500): string | undefined {
  if (value == null) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export function toolNameOf(payload: Record<string, unknown>): string | undefined {
  return stringAt(payload, 'tool_name', 'toolName', 'name') ?? stringAt(nestedRecord(payload, 'tool') ?? {}, 'name')
}

export function toolInputOf(payload: Record<string, unknown>): Record<string, unknown> {
  return (nestedRecord(payload, 'tool_input') ?? nestedRecord(payload, 'toolInput') ?? nestedRecord(payload, 'input') ?? {})
}

export function toolUseIdOf(payload: Record<string, unknown>): string | undefined {
  return stringAt(payload, 'tool_use_id', 'toolUseId', 'call_id', 'callId', 'id')
}

export function providerTurnIdOf(payload: Record<string, unknown>, provider?: ProviderId): string | undefined {
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

export const CODEX_SUBAGENT_MARKER = 'scry_codex_subagent_transcript'

export function subagentScopedPayload(payload: Record<string, unknown>): boolean {
  return !!(
    payload[CODEX_SUBAGENT_MARKER] === true ||
    stringAt(payload, 'agent_id', 'agentId') ||
    stringAt(payload, 'agent_type', 'agentType') ||
    stringAt(payload, 'agent_transcript_path', 'agentTranscriptPath')
  )
}

export interface ParsedTranscriptTurn {
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

export interface NormalizedCodexCall {
  tool: string
  input: Record<string, unknown>
  suffix?: string
}

export const START_EVENTS = new Set(['UserPromptSubmit', 'chat.message', 'turn.started'])
export const END_EVENTS = new Set(['Stop', 'session.idle', 'session.stop', 'turn/completed', 'turn.completed'])
// These Provider Stop contracts expose the same-turn continuation flag; do not infer parity.
export const STOP_HOOK_ACTIVE_PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'qoder'])
export const SESSION_END_EVENTS = new Set(['SessionEnd', 'session.end', 'session_end', 'session.exited', 'process.exit'])
export const TERMINAL_CLOCK_SKEW_MS = 60_000
export const STALE_TERMINAL_PROVIDERS = new Set<ProviderId>(['qoder', 'opencode'])
export const STALE_TERMINAL_WINDOW_MS = 30_000
export const DEFERRED_TERMINAL_GRACE_MS = 180_000
export const OPEN_TURN_EXPIRY_MS = 24 * 60 * 60 * 1_000

export interface QueuedHook {
  schemaVersion: 1
  provider: ProviderId
  sessionId: string
  event: string
  payload: Record<string, unknown>
  managed?: boolean
  arrivedAt: string
}


export function overlapsTurn(parent: ParsedTranscriptTurn, child: ParsedTranscriptTurn): boolean {
  const parentStart = Date.parse(parent.startedAt ?? '')
  const parentEnd = Date.parse(parent.completedAt ?? '')
  const childStart = Date.parse(child.startedAt ?? '')
  const childEnd = Date.parse(child.completedAt ?? child.startedAt ?? '')
  if (![parentStart, parentEnd, childStart, childEnd].every(Number.isFinite)) return true
  return childStart <= parentEnd && childEnd >= parentStart
}


export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, out))
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((item) => stringsIn(item, out))
  return out
}

export function inferredSkillEvents(
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


export function terminalStatus(payload: Record<string, unknown>, fallback: AgentTurnRecord['status']): AgentTurnRecord['status'] {
  const status = stringAt(payload, 'status', 'outcome', 'reason')?.toLowerCase()
  if (status?.includes('cancel')) return 'cancelled'
  if (status?.includes('interrupt')) return 'interrupted'
  if (status?.includes('fail') || status?.includes('error') || payload.error != null) return 'failed'
  return fallback
}
