import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { classifyTool, fileOpOf, parseMcp, type TraceEvent } from '../../shared/trace.js'
import { disabled, type AgentTurnRecord } from '../../shared/turn-record.js'
import { classifyDanger } from '../../main/danger.js'
import { parseTranscriptToTurns } from '../../main/normalize.js'
import { aggregateTurnEvidence } from './aggregate.js'
import { discoverRepositories, resolveRecorderEnablement, type RecorderEnablement } from './config.js'
import { beginGitTurnDiff, finishGitTurnDiff, type GitTurnDiffCapture } from './git.js'
import { listFiles, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'
import {
  RECORDER_VERSION,
  clearRuntimeTurn,
  commitRecord,
  listRecords,
  recordError,
  safeKey,
  stableHash,
  updateHealth
} from './store.js'

export interface RecorderHookInput {
  provider: ProviderId
  event: string
  workspace: string
  payload: Record<string, unknown>
  env?: NodeJS.ProcessEnv
}

export interface RecorderHookResult {
  status: 'disabled' | 'ignored' | 'started' | 'recorded' | 'committed' | 'duplicate' | 'pending' | 'orphan'
  reason?: string
  record?: AgentTurnRecord
}

interface SessionState {
  schemaVersion: 1
  lastGeneration: number
  lastTurnIndex: number
  lastCommittedRecordId?: string
  committedProviderTurnIds?: string[]
}

interface OpenTurnState {
  schemaVersion: 1
  provider: ProviderId
  sessionId: string
  generation: number
  turnIndex: number
  status: 'open' | 'closing'
  startedAt: string
  closingAt?: string
  prompt?: string
  promptHash?: string
  startFingerprint: string
  transcriptPath?: string
  providerTurnId?: string
  captures: Array<{ repository: string; capture: GitTurnDiffCapture }>
}

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
  observed: boolean
  events: TraceEvent[]
  observable: {
    tools: boolean
    hooks: boolean
    usage: boolean
  }
}

const START_EVENTS = new Set(['UserPromptSubmit', 'chat.message', 'turn.started'])
const END_EVENTS = new Set(['Stop', 'session.idle', 'session.stop', 'turn/completed', 'turn.completed'])

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
  const message = payload.message
  if (typeof message === 'string' && message.trim()) return message
  const messageRecord = nestedRecord(payload, 'message')
  return messageRecord ? stringAt(messageRecord, 'text', 'content', 'prompt') : undefined
}

function timestampOf(payload: Record<string, unknown>): string {
  const value = stringAt(payload, 'timestamp', 'ts', 'created_at', 'createdAt')
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString()
}

function sessionRoot(dataRoot: string, provider: ProviderId, sessionId: string): string {
  return join(dataRoot, 'runtime', provider, safeKey(sessionId))
}

function turnRoot(root: string, generation: number): string {
  return join(root, 'turns', String(generation).padStart(8, '0'))
}

function openPath(root: string): string {
  return join(root, 'open.json')
}

function statePath(root: string): string {
  return join(root, 'session.json')
}

function sessionLock(dataRoot: string, provider: ProviderId, sessionId: string): string {
  return join(dataRoot, 'locks', 'sessions', provider, `${safeKey(sessionId)}.lock`)
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

function providerTurnIdOf(payload: Record<string, unknown>): string | undefined {
  return stringAt(payload, 'turn_id', 'turnId')
    ?? stringAt(nestedRecord(payload, 'task') ?? {}, 'turn_id', 'turnId', 'id')
}

function usageTrace(payload: Record<string, unknown>, runId: string, at: string): TraceEvent | null {
  const usage = nestedRecord(payload, 'usage') ?? nestedRecord(nestedRecord(payload, 'result') ?? {}, 'usage')
  if (!usage) return null
  const number = (key: string): number | undefined => typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] as number : undefined
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
    isError: payload.error != null
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
    const pattern = /(?:^|[/\s"'`])(?:\.claude|\.codex|\.agents)\/skills\/([^/\s"'`]+)(?:\/SKILL\.md)?/g
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
    input: { source: 'tool_path' }
  }))
}

function lifecycleTraceEvents(args: {
  provider: ProviderId
  event: string
  payload: Record<string, unknown>
  runId: string
  captureOutput: boolean
}): TraceEvent[] {
  const at = timestampOf(args.payload)
  const toolName = toolNameOf(args.payload)
  const toolUseId = toolUseIdOf(args.payload)
  const input = toolInputOf(args.payload)
  const out: TraceEvent[] = []
  if (/^PreToolUse(?::|$)/.test(args.event) || args.event === 'tool.execute.before') {
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
        input,
        ...mcp,
        ...file,
        ...(danger ? { danger } : {})
      })
    }
  } else if (/^PostToolUse(?:Failure)?(?::|$)/.test(args.event) || args.event === 'tool.execute.after') {
    const failed = /Failure/.test(args.event) || args.payload.error != null || args.payload.is_error === true
    const result = args.payload.tool_response ?? args.payload.toolResponse ?? args.payload.output ?? args.payload.result ?? args.payload.error
    out.push({
      id: `result-${toolUseId ?? stableHash([args.event, args.payload]).slice(0, 16)}`,
      ts: at,
      runId: args.runId,
      kind: 'tool',
      stage: 'tool_result',
      tool: toolName,
      toolUseId,
      ...(args.captureOutput ? { text: summarize(result), output: summarize(result) } : {}),
      isError: failed
    })
  }
  const usage = usageTrace(args.payload, args.runId, at)
  if (usage) out.push(usage)
  const assistant = stringAt(args.payload, 'assistant_response', 'assistantResponse', 'result_text')
  if (assistant) out.push({ id: `assistant-${stableHash(assistant).slice(0, 16)}`, ts: at, runId: args.runId, kind: 'model', stage: 'text', text: assistant })
  return out
}

interface ParsedTranscriptTurn {
  providerTurnId?: string
  userText: string
  events: TraceEvent[]
  observable: TranscriptRead['observable']
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

function codexHookEvent(payload: Record<string, unknown>, runId: string, at: string): TraceEvent | null {
  const type = stringAt(payload, 'type')
  if (!type || !/^hook_(?:started|progress|response|success|cancelled|additional_context)$/.test(type)) return null
  const outcome = stringAt(payload, 'outcome')
    ?? (type === 'hook_started' ? 'started' : type === 'hook_progress' || type === 'hook_additional_context' ? 'progress' : type === 'hook_cancelled' ? 'cancelled' : 'success')
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
  let lastAssistant: string | undefined

  const finishUsage = (at: string): void => {
    if (!current || !usageObserved) return
    const finalUsage = latestTurnCumulative
      ? {
          tokensIn: Math.max(0, latestTurnCumulative.tokensIn - turnUsageBaseline.tokensIn),
          tokensOut: Math.max(0, latestTurnCumulative.tokensOut - turnUsageBaseline.tokensOut),
          cacheReadTokens: Math.max(0, latestTurnCumulative.cacheReadTokens - turnUsageBaseline.cacheReadTokens),
          cacheCreationTokens: Math.max(0, latestTurnCumulative.cacheCreationTokens - turnUsageBaseline.cacheCreationTokens),
          reasoningTokens: Math.max(0, latestTurnCumulative.reasoningTokens - turnUsageBaseline.reasoningTokens)
        }
      : usage
    current.events.push({
      id: `codex-usage-${stableHash([current.providerTurnId, finalUsage]).slice(0, 16)}`,
      ts: at,
      runId,
      kind: 'harness',
      stage: 'result',
      ...finalUsage
    })
    current.observable.usage = true
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
    if (type === 'session_meta' || type === 'turn_context' || type === 'event_msg' || type === 'response_item') sawCodexLine = true
    if (type === 'event_msg' && payload.type === 'task_started') {
      current = {
        providerTurnId: stringAt(payload, 'turn_id', 'turnId'),
        userText: '',
        events: [],
        observable: { tools: true, hooks: false, usage: false }
      }
      turns.push(current)
      turnUsageBaseline = { ...cumulativeUsage }
      latestTurnCumulative = undefined
      usage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 }
      usageObserved = false
      lastAssistant = undefined
      continue
    }
    if (!current) continue

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
    if (type === 'event_msg' && payload.type === 'token_count') {
      const info = nestedRecord(payload, 'info') ?? {}
      const last = nestedRecord(info, 'last_token_usage')
      const total = nestedRecord(info, 'total_token_usage')
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
      if (last) {
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
      lastAssistant = stringAt(payload, 'message', 'text') ?? textContent(payload.content) ?? lastAssistant
      continue
    }
    if (type === 'event_msg' && payload.type === 'task_complete') {
      finishUsage(at)
      const assistant = stringAt(payload, 'last_agent_message', 'lastAgentMessage') ?? lastAssistant
      if (assistant) current.events.push({
        id: `codex-assistant-${stableHash([current.providerTurnId, assistant]).slice(0, 16)}`,
        ts: at,
        runId,
        kind: 'model',
        stage: 'text',
        text: assistant
      })
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
    if (type !== 'response_item') continue

    const itemType = stringAt(payload, 'type')
    if (itemType === 'message' && stringAt(payload, 'role') === 'assistant') {
      lastAssistant = textContent(payload.content) ?? lastAssistant
      continue
    }
    if (itemType === 'agent_message') {
      lastAssistant = stringAt(payload, 'message', 'text') ?? textContent(payload.content) ?? lastAssistant
      continue
    }

    const isCall = itemType === 'custom_tool_call' || itemType === 'function_call' || itemType === 'tool_search_call'
    if (isCall) {
      const tool = stringAt(payload, 'name') ?? itemType
      const toolUseId = stringAt(payload, 'call_id', 'callId', 'id')
      const input = callInput(payload)
      const cls = classifyTool(tool, input)
      const mcp = parseMcp(tool, input)
      const file = fileOpOf(tool, input)
      const danger = classifyDanger(tool, input)
      current.events.push(...inferredSkillEvents(tool, input, runId, at, toolUseId))
      current.events.push({
        id: `codex-tool-${stableHash([toolUseId, tool]).slice(0, 16)}`,
        ts: at,
        runId,
        kind: cls.kind,
        stage: `${cls.kind}:${cls.name}`,
        tool,
        name: cls.name,
        toolUseId,
        input,
        ...mcp,
        ...file,
        ...(danger ? { danger } : {})
      })
      continue
    }

    const isOutput = itemType === 'custom_tool_call_output' || itemType === 'function_call_output' || itemType === 'tool_search_output'
    if (isOutput) {
      const toolUseId = stringAt(payload, 'call_id', 'callId', 'id')
      const output = summarize(payload.output ?? payload.result ?? payload.tools)
      current.events.push({
        id: `codex-result-${stableHash([toolUseId, output]).slice(0, 16)}`,
        ts: at,
        runId,
        kind: 'tool',
        stage: 'tool_result',
        toolUseId,
        text: output,
        output,
        isError: payload.error != null || payload.status === 'failed'
      })
    }
  }
  return { recognized: sawCodexLine && turns.length > 0, turns }
}

async function stableTranscript(
  path: string,
  runId: string,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string
): Promise<TranscriptRead> {
  let previous = -1
  for (let attempt = 0; attempt < 3; attempt++) {
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return { stable: true, observed: false, events: [], observable: { tools: false, hooks: false, usage: false } }
    }
    if (size === previous) {
      const content = await readFile(path, 'utf8')
      if (provider === 'codex') {
        const parsed = parseCodexRollout(content, runId)
        const direct = providerTurnId ? parsed.turns.find((turn) => turn.providerTurnId === providerTurnId) : undefined
        const matching = promptHash
          ? [...parsed.turns].reverse().find((turn) => createHash('sha256').update(turn.userText).digest('hex') === promptHash)
          : undefined
        const turn = direct ?? matching ?? parsed.turns.at(-1)
        return {
          stable: true,
          observed: parsed.recognized,
          events: turn?.events ?? [],
          observable: turn?.observable ?? { tools: false, hooks: false, usage: false }
        }
      }
      const turns = parseTranscriptToTurns(content, {
        runId,
        newId: () => `transcript-${randomUUID()}`,
        now: () => new Date().toISOString()
      })
      const matching = promptHash ? [...turns].reverse().find((turn) => createHash('sha256').update(turn.userText).digest('hex') === promptHash) : undefined
      const events = (matching ?? turns.at(-1))?.items ?? []
      return {
        stable: true,
        observed: turns.length > 0,
        events,
        observable: {
          tools: turns.length > 0,
          hooks: events.some((event) => event.kind === 'hook'),
          usage: events.some((event) => event.kind === 'harness' && event.stage === 'result')
        }
      }
    }
    previous = size
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return { stable: false, observed: true, events: [], observable: { tools: false, hooks: false, usage: false } }
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
      ? { lifecycle: `skill:${event.name ?? event.tool ?? 'unknown'}` }
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

export function mergeTurnTraceEvents(lifecycle: TraceEvent[], transcript: TraceEvent[]): TraceEvent[] {
  const transcriptToolKeys = new Set(transcript.map(toolEventKey).filter((key): key is string => !!key))
  const transcriptHasAssistant = transcript.some((event) => event.kind === 'model' && event.stage === 'text')
  const transcriptHasUsage = transcript.some((event) => event.kind === 'harness' && event.stage === 'result')
  const filteredLifecycle = lifecycle.filter((event) => {
    const key = toolEventKey(event)
    if (key && transcriptToolKeys.has(key)) return false
    if (transcriptHasAssistant && event.kind === 'model' && event.stage === 'text') return false
    if (transcriptHasUsage && event.kind === 'harness' && event.stage === 'result') return false
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
  payload: Record<string, unknown>
): Promise<OpenTurnState> {
  const root = sessionRoot(enablement.dataRoot, provider, sessionId)
  const session = await nextSessionState(enablement.dataRoot, root, provider, sessionId)
  const generation = session.lastGeneration + 1
  const turnIndex = session.lastTurnIndex + 1
  const prompt = promptOf(payload)
  const promptHash = prompt ? createHash('sha256').update(prompt).digest('hex') : undefined
  const captureDir = join(turnRoot(root, generation), 'captures')
  const repositories = enablement.config.capture.diff ? await discoverRepositories(enablement.workspaceRoot, enablement.config) : []
  const captures = await Promise.all(repositories.map(async (repository) => ({
    repository,
    capture: await beginGitTurnDiff(repository, 5_000, captureDir, [enablement.dataRoot])
  })))
  const open: OpenTurnState = {
    schemaVersion: 1,
    provider,
    sessionId,
    generation,
    turnIndex,
    status: 'open',
    startedAt: timestampOf(payload),
    startFingerprint: stableHash({ event, payload }),
    ...(enablement.config.capture.prompt && prompt ? { prompt } : {}),
    ...(promptHash ? { promptHash } : {}),
    ...(transcriptPathOf(payload) ? { transcriptPath: transcriptPathOf(payload) } : {}),
    ...(providerTurnIdOf(payload) ? { providerTurnId: providerTurnIdOf(payload) } : {}),
    captures
  }
  await writeJsonAtomic(openPath(root), open, { sync: false })
  await writeJsonAtomic(statePath(root), { ...session, lastGeneration: generation, lastTurnIndex: turnIndex }, { sync: false })
  return open
}

async function storeLifecycleEvent(enablement: Extract<RecorderEnablement, { enabled: true }>, open: OpenTurnState, event: string, payload: Record<string, unknown>): Promise<void> {
  const root = sessionRoot(enablement.dataRoot, open.provider, open.sessionId)
  const id = stableHash({ event, sessionId: open.sessionId, generation: open.generation, payload })
  const stored: StoredLifecycleEvent = {
    schemaVersion: 1,
    id,
    event,
    observedAt: new Date().toISOString(),
    traceEvents: lifecycleTraceEvents({
      provider: open.provider,
      event,
      payload,
      runId: `${open.provider}:${open.sessionId}:${open.generation}`,
      captureOutput: enablement.config.capture.toolOutput === 'summary'
    }),
    ...(transcriptPathOf(payload) ? { transcriptPath: transcriptPathOf(payload) } : {})
  }
  await writeJsonAtomic(join(turnRoot(root, open.generation), 'events', `${id}.json`), stored, { sync: false })
  const transcriptPath = transcriptPathOf(payload)
  if (transcriptPath && transcriptPath !== open.transcriptPath) {
    open.transcriptPath = transcriptPath
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
}

function terminalStatus(payload: Record<string, unknown>, fallback: AgentTurnRecord['status']): AgentTurnRecord['status'] {
  const status = stringAt(payload, 'status', 'outcome', 'reason')?.toLowerCase()
  if (status?.includes('cancel')) return 'cancelled'
  if (status?.includes('interrupt')) return 'interrupted'
  if (status?.includes('fail') || status?.includes('error') || payload.error != null) return 'failed'
  return fallback
}

async function finalizeOpenTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: OpenTurnState,
  payload: Record<string, unknown>,
  fallbackStatus: AgentTurnRecord['status'],
  options: { allowUnstableTranscript?: boolean } = {}
): Promise<RecorderHookResult> {
  const root = sessionRoot(enablement.dataRoot, open.provider, open.sessionId)
  const runId = `${open.provider}:${open.sessionId}:${open.generation}`
  const transcript = open.transcriptPath
    ? await stableTranscript(open.transcriptPath, runId, open.provider, open.promptHash, open.providerTurnId)
    : { stable: true, observed: false, events: [], observable: { tools: false, hooks: false, usage: false } }
  if (!transcript.stable && !options.allowUnstableTranscript) return { status: 'pending', reason: 'transcript is still changing' }
  const storedEvents = await readStoredEvents(join(turnRoot(root, open.generation), 'events'))
  const diffs = await Promise.all(open.captures.map(async ({ capture }) => finishGitTurnDiff(capture, 3_000)))
  const diffEvents: TraceEvent[] = diffs.map((turnDiff, index) => ({
    id: `diff-${open.generation}-${index}`,
    ts: turnDiff.afterAt,
    runId,
    kind: 'harness',
    stage: 'turn_diff',
    turnDiff
  }))
  const events = dedupeTraceEvents([...mergeTurnTraceEvents(storedEvents, transcript.events), ...diffEvents])
  const hasUsage = events.some((event) => event.kind === 'harness' && event.stage === 'result')
  const hasToolEvidence = events.some((event) =>
    event.stage !== 'tool_result' && ['tool', 'skill', 'agent'].includes(event.kind) && !!(event.tool || event.name)
  )
  const hasHookEvidence = events.some((event) => event.kind === 'hook')
  const evidence = aggregateTurnEvidence({
    userText: open.prompt,
    events,
    source: transcript.observed ? 'provider_transcript+lifecycle_hooks' : 'lifecycle_hooks',
    observable: {
      assistant: transcript.observed || events.some((event) => event.kind === 'model' && event.stage === 'text'),
      tools: hasToolEvidence || transcript.observable.tools,
      hooks: enablement.config.capture.hooks && (hasHookEvidence || transcript.observable.hooks),
      usage: hasUsage || transcript.observable.usage,
      diff: enablement.config.capture.diff
    }
  })
  if (!enablement.config.capture.prompt) evidence.user = disabled('prompt capture disabled by config')
  if (!enablement.config.capture.assistant) evidence.assistant = disabled('assistant capture disabled by config')
  if (!enablement.config.capture.hooks) evidence.hooks = disabled('hook capture disabled by config')
  const completedAt = open.closingAt ?? timestampOf(payload)
  const startedMs = Date.parse(open.startedAt)
  const completedMs = Date.parse(completedAt)
  const recordId = stableHash({
    workspace: enablement.config.workspaceId,
    provider: open.provider,
    sessionId: open.sessionId,
    generation: open.generation,
    startedAt: open.startedAt
  }).slice(0, 32)
  const draft: Omit<AgentTurnRecord, 'sequence'> = {
    schemaVersion: 1,
    recordKind: 'agent_turn',
    recordId,
    recorderVersion: RECORDER_VERSION,
    workspace: { id: enablement.config.workspaceId, root: enablement.workspaceRoot },
    provider: {
      id: open.provider,
      ...(evidence.usage.value?.model ? { model: evidence.usage.value.model } : {})
    },
    sessionId: open.sessionId,
    ...(open.providerTurnId ? { providerTurnId: open.providerTurnId } : {}),
    generation: open.generation,
    turnIndex: open.turnIndex,
    startedAt: open.startedAt,
    completedAt,
    durationMs: Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : 0,
    status: terminalStatus(payload, fallbackStatus),
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

function isSynthetic(payload: Record<string, unknown>): boolean {
  return payload.isMeta === true || payload.synthetic === true || stringAt(payload, 'source') === 'synthetic'
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

export async function handleRecorderHook(input: RecorderHookInput): Promise<RecorderHookResult> {
  const enablement = await resolveRecorderEnablement(input.workspace, input.env)
  if (!enablement.enabled) return { status: 'disabled', reason: enablement.reason }
  const sessionId = sessionIdOf(input.payload)
  if (!sessionId) {
    await recordError(enablement.dataRoot, `missing session id for ${input.event}`)
    return { status: 'ignored', reason: 'missing session id' }
  }
  if (isSynthetic(input.payload)) return { status: 'ignored', reason: 'synthetic/meta prompt' }
  try {
    const result = await withDirectoryLock(sessionLock(enablement.dataRoot, input.provider, sessionId), async () => {
      const root = sessionRoot(enablement.dataRoot, input.provider, sessionId)
      let open = await readJson<OpenTurnState>(openPath(root))
      const incomingProviderTurnId = providerTurnIdOf(input.payload)
      if (START_EVENTS.has(input.event)) {
        const providerTurnId = incomingProviderTurnId
        const startFingerprint = stableHash({ event: input.event, payload: input.payload })
        if (
          providerTurnId &&
          providerTurnId !== open?.providerTurnId &&
          await isCommittedProviderTurn(enablement.dataRoot, root, input.provider, sessionId, providerTurnId)
        ) return { status: 'duplicate' as const }
        if (open && (
          open.startFingerprint === startFingerprint ||
          (providerTurnId && open.providerTurnId === providerTurnId)
        )) return { status: 'duplicate' as const }
        if (open) {
          const fallback = open.status === 'closing' ? 'completed' : 'interrupted'
          open.status = 'closing'
          open.closingAt ??= timestampOf(input.payload)
          await writeJsonAtomic(openPath(root), open, { sync: false })
          await finalizeOpenTurn(enablement, open, input.payload, fallback, { allowUnstableTranscript: true })
        }
        open = await beginOpenTurn(enablement, input.provider, sessionId, input.event, input.payload)
        await storeLifecycleEvent(enablement, open, input.event, input.payload)
        return { status: 'started' as const }
      }
      if (!open) {
        if (END_EVENTS.has(input.event)) return { status: 'duplicate' as const }
        const orphanId = stableHash({ event: input.event, payload: input.payload })
        await writeJsonAtomic(join(root, 'orphans', `${orphanId}.json`), { event: input.event, observedAt: new Date().toISOString() }, { sync: false })
        await updateHealth(enablement.dataRoot, { increment: { orphanEvents: 1 } })
        return { status: 'orphan' as const }
      }
      if (incomingProviderTurnId && open.providerTurnId && incomingProviderTurnId !== open.providerTurnId) {
        if (await isCommittedProviderTurn(enablement.dataRoot, root, input.provider, sessionId, incomingProviderTurnId)) {
          return { status: 'duplicate' as const }
        }
        const orphanId = stableHash({ event: input.event, payload: input.payload })
        await writeJsonAtomic(join(root, 'orphans', `${orphanId}.json`), { event: input.event, observedAt: new Date().toISOString() }, { sync: false })
        await updateHealth(enablement.dataRoot, { increment: { orphanEvents: 1 } })
        return { status: 'orphan' as const }
      }
      await storeLifecycleEvent(enablement, open, input.event, input.payload)
      if (!END_EVENTS.has(input.event)) return { status: 'recorded' as const }
      open.status = 'closing'
      open.closingAt = timestampOf(input.payload)
      await writeJsonAtomic(openPath(root), open, { sync: false })
      return finalizeOpenTurn(enablement, open, input.payload, 'completed')
    })
    const pending = START_EVENTS.has(input.event) || END_EVENTS.has(input.event)
      ? await pendingHealth(enablement.dataRoot)
      : undefined
    if (pending) {
      await updateHealth(enablement.dataRoot, {
        lastSuccessAt: new Date().toISOString(),
        lastError: undefined,
        ...pending
      })
    }
    return result
  } catch (error) {
    await recordError(enablement.dataRoot, error)
    throw error
  }
}

async function runtimeSessions(dataRoot: string): Promise<Array<{ provider: ProviderId; sessionDir: string }>> {
  const out: Array<{ provider: ProviderId; sessionDir: string }> = []
  for (const provider of ['claude', 'codex', 'qoder', 'opencode'] as ProviderId[]) {
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
  let pendingCount = 0
  let oldestPendingAgeMs = 0
  const now = Date.now()
  for (const item of await runtimeSessions(dataRoot)) {
    const open = await readJson<OpenTurnState>(openPath(item.sessionDir))
    if (!open || open.status !== 'closing') continue
    pendingCount++
    const started = Date.parse(open.closingAt ?? open.startedAt)
    if (Number.isFinite(started)) oldestPendingAgeMs = Math.max(oldestPendingAgeMs, Math.max(0, now - started))
  }
  return { pendingCount, oldestPendingAgeMs }
}

export async function refreshRecorderPendingHealth(dataRoot: string): Promise<void> {
  await updateHealth(dataRoot, await pendingHealth(dataRoot))
}

export async function recoverRecorder(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<{ recovered: number; pending: number }> {
  const enablement = await resolveRecorderEnablement(workspace, env)
  if (!enablement.enabled) return { recovered: 0, pending: 0 }
  let recovered = 0
  let pending = 0
  for (const item of await runtimeSessions(enablement.dataRoot)) {
    const open = await readJson<OpenTurnState>(openPath(item.sessionDir))
    if (!open || open.status !== 'closing') continue
    const result = await withDirectoryLock(sessionLock(enablement.dataRoot, item.provider, open.sessionId), () =>
      finalizeOpenTurn(enablement, open, { timestamp: open.closingAt ?? new Date().toISOString() }, 'completed')
    )
    if (result.status === 'pending') pending++
    else recovered++
  }
  await updateHealth(enablement.dataRoot, {
    ...(await pendingHealth(enablement.dataRoot)),
    ...(recovered ? { increment: { recoveredRecords: recovered } } : {})
  })
  return { recovered, pending }
}

export async function recorderEnablement(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<RecorderEnablement> {
  return resolveRecorderEnablement(workspace, env)
}
