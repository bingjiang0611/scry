import { createHash, randomUUID } from 'node:crypto'
import { open as openFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { classifyTool, fileOpOf, parseMcp, type TraceEvent } from '../../shared/trace.js'
import { disabled, partial, type AgentTurnRecord } from '../../shared/turn-record.js'
import { classifyDanger } from '../../main/danger.js'
import { parseTranscriptToTurns } from '../../main/normalize.js'
import { aggregateTurnEvidence } from './aggregate.js'
import { turnChangeHints } from './change-journal.js'
import { discoverRepositories, resolveRecorderEnablement, type RecorderEnablement } from './config.js'
import { beginGitTurnDiff, finishGitTurnDiff } from './git.js'
import { listFiles, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'
import { recoverManagedRecorderTurns } from './managed.js'
import {
  SESSION_LOCK_WAIT_MS,
  recorderOpenPath as openPath,
  recorderPendingHealth,
  recorderSessionLock as sessionLock,
  recorderSessionRoot as sessionRoot,
  recorderStatePath as statePath,
  recorderTurnRoot as turnRoot,
  type RecorderOpenTurnState as OpenTurnState,
  type RecorderSessionState as SessionState
} from './runtime-state.js'
import {
  RECORDER_VERSION,
  clearRuntimeTurn,
  commitRecord,
  listRecords,
  recordError,
  stableHash,
  updateHealth
} from './store.js'

export interface RecorderHookInput {
  provider: ProviderId
  event: string
  workspace: string
  payload: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  managed?: boolean
}

export interface RecorderHookResult {
  status: 'disabled' | 'ignored' | 'started' | 'recorded' | 'committed' | 'duplicate' | 'pending' | 'orphan'
  reason?: string
  record?: AgentTurnRecord
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
  complete?: boolean
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
const TRANSCRIPT_REWIND_BYTES = 4 * 1024 * 1024
const MAX_TRANSCRIPT_READ_BYTES = 32 * 1024 * 1024

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
  startedAt?: string
  completedAt?: string
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
  if (name === 'spawn_agent') {
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
  return /CreateProcess[\s\S]*Rejected|rejected:[\s\S]*(?:not permitted|permission|denied)/i.test(output ?? '')
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
  let usageFinished = false
  let lastAssistant: string | undefined
  let injectedSkill: string | undefined
  let logicalIdsByOuterCall = new Map<string, string[]>()
  let toolById = new Map<string, string>()
  let asyncOuterCallByCell = new Map<string, string>()
  let transportCellByOuterCall = new Map<string, string>()
  let lastAt: string | undefined

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
      usageObserved = false
      usageFinished = false
      lastAssistant = undefined
      injectedSkill = undefined
      logicalIdsByOuterCall = new Map()
      toolById = new Map()
      asyncOuterCallByCell = new Map()
      transportCellByOuterCall = new Map()
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
      current.completedAt = at
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
      lastAssistant = textContent(payload.content) ?? lastAssistant
      continue
    }
    if (itemType === 'agent_message') {
      lastAssistant = stringAt(payload, 'message', 'text') ?? textContent(payload.content) ?? lastAssistant
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
      const childSize = (await stat(childPath)).size
      const childTranscript = await readTranscriptWindow(childPath, childSize)
      parsed = parseCodexRollout(childTranscript.content, runId)
      complete = complete && !childTranscript.truncated
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

async function transcriptStartOffset(path: string): Promise<number | undefined> {
  try {
    return Math.max(0, (await stat(path)).size - TRANSCRIPT_REWIND_BYTES)
  } catch {
    return undefined
  }
}

async function readTranscriptWindow(
  path: string,
  endOffset: number,
  preferredStartOffset = 0
): Promise<{ content: string; truncated: boolean }> {
  const boundedEnd = Math.max(0, endOffset)
  const preferredStart = Math.max(0, Math.min(preferredStartOffset, boundedEnd))
  const start = Math.max(preferredStart, boundedEnd - MAX_TRANSCRIPT_READ_BYTES)
  const length = boundedEnd - start
  if (length === 0) return { content: '', truncated: false }
  const handle = await openFile(path, 'r')
  const buffer = Buffer.allocUnsafe(length)
  let bytesRead = 0
  try {
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
  } finally {
    await handle.close()
  }
  let content = buffer.subarray(0, bytesRead).toString('utf8')
  let truncated = start > preferredStart
  if (start > 0) {
    const firstNewline = content.indexOf('\n')
    if (firstNewline >= 0) content = content.slice(firstNewline + 1)
    else {
      content = ''
      truncated = true
    }
  }
  return { content, truncated }
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
}): Promise<TranscriptRead> {
  const snapshot = await readTranscriptWindow(args.path, args.endOffset, args.startOffset)
  if (args.provider === 'codex') {
    const parsed = parseCodexRollout(snapshot.content, args.runId)
    const direct = args.providerTurnId ? parsed.turns.find((turn) => turn.providerTurnId === args.providerTurnId) : undefined
    const matching = args.promptHash
      ? [...parsed.turns].reverse().find((turn) => {
          const candidates = [turn.userText, turn.userText.replace(/^\/[A-Za-z0-9_-]+\s*/, '')]
          return candidates.some((candidate) => createHash('sha256').update(candidate).digest('hex') === args.promptHash)
        })
      : undefined
    const turn = direct ?? matching ?? parsed.turns.at(-1)
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
      stable: args.stable,
      observed: parsed.recognized,
      complete: args.stable && !snapshot.truncated && enriched.complete,
      toolStreamComplete: args.stable && !snapshot.truncated && !!turn && turn.pendingToolCalls.size === 0,
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
  const matching = args.promptHash
    ? [...turns].reverse().find((turn) => createHash('sha256').update(turn.userText).digest('hex') === args.promptHash)
    : undefined
  const turn = matching ?? turns.at(-1)
  const events = turn?.items ?? []
  return {
    stable: args.stable,
    observed: turns.length > 0,
    complete: args.stable && !snapshot.truncated,
    ...(turn?.userText ? { userText: turn.userText } : {}),
    events,
    observable: {
      tools: turns.length > 0,
      skills: turns.length > 0,
      mcps: turns.length > 0,
      hooks: events.some((event) => event.kind === 'hook'),
      usage: events.some((event) => event.kind === 'harness' && event.stage === 'result'),
      files: events.some((event) => !!event.filePath && !!event.fileOp),
      errors: turns.length > 0
    }
  }
}

async function stableTranscript(
  path: string,
  runId: string,
  provider: ProviderId,
  promptHash?: string,
  providerTurnId?: string,
  startOffset?: number
): Promise<TranscriptRead> {
  let previous = -1
  let latestSize = -1
  for (let attempt = 0; attempt < 3; attempt++) {
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return {
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
    }
    latestSize = size
    if (size === previous) {
      return parseTranscriptSnapshot({ path, endOffset: size, startOffset, stable: true, runId, provider, promptHash, providerTurnId })
    }
    previous = size
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return parseTranscriptSnapshot({
    path,
    endOffset: Math.max(0, latestSize),
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
  const filteredLifecycle = lifecycle.filter((event) => {
    if (transcriptCallsAuthoritative && isLogicalCallEvent(event)) return false
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
  payload: Record<string, unknown>,
  managedByScry = false
): Promise<OpenTurnState> {
  const root = sessionRoot(enablement.dataRoot, provider, sessionId)
  const session = await nextSessionState(enablement.dataRoot, root, provider, sessionId)
  const generation = session.lastGeneration + 1
  const turnIndex = session.lastTurnIndex + 1
  const prompt = promptOf(payload)
  const promptHash = prompt ? createHash('sha256').update(prompt).digest('hex') : undefined
  const transcriptPath = transcriptPathOf(payload)
  const transcriptOffset = transcriptPath ? await transcriptStartOffset(transcriptPath) : undefined
  const captureDir = join(turnRoot(root, generation), 'captures')
  const repositories = !managedByScry && enablement.config.capture.diff
    ? await discoverRepositories(enablement.workspaceRoot, enablement.config)
    : []
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
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(transcriptOffset != null ? { transcriptStartOffset: transcriptOffset } : {}),
    ...(providerTurnIdOf(payload) ? { providerTurnId: providerTurnIdOf(payload) } : {}),
    ...(managedByScry ? { managedByScry: true } : {}),
    captures
  }
  await writeJsonAtomic(openPath(root), open, { sync: false })
  await writeJsonAtomic(statePath(root), { ...session, lastGeneration: generation, lastTurnIndex: turnIndex }, { sync: false })
  return open
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
    open.transcriptStartOffset = await transcriptStartOffset(transcriptPath)
    await writeJsonAtomic(openPath(root), open, { sync: false })
  } else if (transcriptPath && open.transcriptStartOffset == null) {
    open.transcriptStartOffset = await transcriptStartOffset(transcriptPath)
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
  const storedEvents = await readStoredEvents(join(turnRoot(root, open.generation), 'events'))
  const mergedEvents = mergeTurnTraceEvents(storedEvents, transcript.events, transcript.toolStreamComplete === true)
  const diffs = await Promise.all(open.captures.map(async ({ repository, capture }) =>
    finishGitTurnDiff(capture, undefined, turnChangeHints(repository, mergedEvents))
  ))
  const diffEvents: TraceEvent[] = diffs.map((turnDiff, index) => ({
    id: `diff-${open.generation}-${index}`,
    ts: turnDiff.afterAt,
    runId,
    kind: 'harness',
    stage: 'turn_diff',
    turnDiff
  }))
  const events = dedupeTraceEvents([...mergedEvents, ...diffEvents])
  const hasUsage = events.some((event) => event.kind === 'harness' && event.stage === 'result')
  const hasToolEvidence = events.some((event) =>
    event.stage !== 'tool_result' && ['tool', 'skill', 'agent'].includes(event.kind) && !!(event.tool || event.name)
  )
  const hasHookEvidence = events.some((event) => event.kind === 'hook')
  const evidence = aggregateTurnEvidence({
    userText: transcript.userText ?? open.prompt,
    events,
    source: transcript.observed ? 'provider_transcript+lifecycle_hooks' : 'lifecycle_hooks',
    observable: {
      assistant: transcript.observed || events.some((event) => event.kind === 'model' && event.stage === 'text'),
      tools: hasToolEvidence || transcript.observable.tools,
      skills: events.some((event) => event.kind === 'skill') || transcript.observable.skills,
      mcps: events.some((event) => event.kind === 'tool' && event.isMcp) || transcript.observable.mcps,
      hooks: enablement.config.capture.hooks && (hasHookEvidence || transcript.observable.hooks),
      usage: hasUsage || transcript.observable.usage,
      files: events.some((event) => !!event.filePath && !!event.fileOp) || transcript.observable.files,
      errors: hasToolEvidence || transcript.observable.errors,
      diff: enablement.config.capture.diff
    }
  })
  if (transcript.complete === false) {
    const source = evidence.tools.source
    const reason = 'transcript snapshot was incomplete or one or more child agent transcripts were unavailable'
    if (evidence.tools.value) evidence.tools = partial(evidence.tools.value, source, reason)
    if (evidence.skills.value) evidence.skills = partial(evidence.skills.value, source, reason)
    if (evidence.mcps.value) evidence.mcps = partial(evidence.mcps.value, source, reason)
    if (evidence.files.value) evidence.files = partial(evidence.files.value, source, reason)
    if (evidence.errors.value) evidence.errors = partial(evidence.errors.value, source, reason)
    if (evidence.usage.value) evidence.usage = partial(evidence.usage.value, source, reason)
    if (evidence.hooks.value) evidence.hooks = partial(evidence.hooks.value, source, reason)
    if (evidence.dangerousOperations.value) {
      evidence.dangerousOperations = partial(evidence.dangerousOperations.value, source, reason)
    }
    if (evidence.modelTiming?.value && evidence.modelTiming.value.method !== 'provider_api') {
      evidence.modelTiming = partial(evidence.modelTiming.value, evidence.modelTiming.source, reason)
    }
  }
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
            open.status = 'closing'
            open.closingAt ??= timestampOf(input.payload)
            await writeJsonAtomic(openPath(root), open, { sync: false })
            await finalizeOpenTurn(enablement, open, input.payload, fallback, { allowUnstableTranscript: true })
          }
        }
        open = await beginOpenTurn(enablement, input.provider, sessionId, input.event, input.payload, input.managed === true)
        if (!open.managedByScry) await storeLifecycleEvent(enablement, open, input.event, input.payload)
        return { status: 'started' as const }
      }
      if (!open) {
        if (END_EVENTS.has(input.event)) return { status: 'duplicate' as const }
        if (input.managed) return { status: 'ignored' as const, reason: 'managed turn has no open identity' }
        const orphanId = stableHash({ event: input.event, payload: input.payload })
        await writeJsonAtomic(join(root, 'orphans', `${orphanId}.json`), { event: input.event, observedAt: new Date().toISOString() }, { sync: false })
        await updateHealth(enablement.dataRoot, { increment: { orphanEvents: 1 } })
        return { status: 'orphan' as const }
      }
      if (open.managedByScry) {
        if (!END_EVENTS.has(input.event)) return { status: 'recorded' as const }
        open.status = 'closing'
        open.closingAt = timestampOf(input.payload)
        await writeJsonAtomic(openPath(root), open, { sync: false })
        return { status: 'pending' as const, reason: 'managed turn awaits canonical Scry evidence' }
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
      return finalizeOpenTurn(enablement, open, input.payload, 'completed', { allowUnstableTranscript: true })
    }, { waitMs: SESSION_LOCK_WAIT_MS })
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
  return recorderPendingHealth(dataRoot)
}

export async function refreshRecorderPendingHealth(dataRoot: string): Promise<void> {
  await updateHealth(dataRoot, await pendingHealth(dataRoot))
}

export async function recoverRecorder(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<{ recovered: number; pending: number }> {
  const enablement = await resolveRecorderEnablement(workspace, env)
  if (!enablement.enabled) return { recovered: 0, pending: 0 }
  let recovered = 0
  let pending = 0
  let managedPresent = false
  for (const item of await runtimeSessions(enablement.dataRoot)) {
    const open = await readJson<OpenTurnState>(openPath(item.sessionDir))
    if (!open) continue
    if (open.managedByScry) {
      managedPresent = true
      continue
    }
    if (open.status !== 'closing') continue
    const result = await withDirectoryLock(
      sessionLock(enablement.dataRoot, item.provider, open.sessionId),
      () => finalizeOpenTurn(
        enablement,
        open,
        { timestamp: open.closingAt ?? new Date().toISOString() },
        'completed',
        { allowUnstableTranscript: true }
      ),
      { waitMs: SESSION_LOCK_WAIT_MS }
    )
    if (result.status === 'pending') pending++
    else recovered++
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
  return { recovered, pending }
}

export async function recorderEnablement(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<RecorderEnablement> {
  return resolveRecorderEnablement(workspace, env)
}
