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

function inferredSkillEvents(toolName: string, input: Record<string, unknown>, runId: string, at: string): TraceEvent[] {
  const candidates: string[] = []
  if (toolName === 'Read' && typeof input.file_path === 'string') candidates.push(input.file_path)
  if (toolName === 'Bash' && typeof input.command === 'string') candidates.push(...input.command.split(/\s+/))
  const names = new Set<string>()
  for (const candidate of candidates) {
    const match = /(?:^|\/)(?:\.claude|\.codex|\.agents)?\/?skills\/([^/\s]+)(?:\/SKILL\.md)?/.exec(candidate)
    if (match?.[1]) names.add(match[1])
  }
  return [...names].map((name) => ({
    id: `skill-${stableHash(`${name}\0${at}`).slice(0, 16)}`,
    ts: at,
    runId,
    kind: 'skill' as const,
    stage: `skill:${name}`,
    tool: 'Skill',
    name,
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
      out.push(...inferredSkillEvents(toolName, input, args.runId, at))
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

async function stableTranscript(path: string, runId: string, promptHash?: string): Promise<TranscriptRead> {
  let previous = -1
  for (let attempt = 0; attempt < 3; attempt++) {
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return { stable: true, observed: false, events: [] }
    }
    if (size === previous) {
      const content = await readFile(path, 'utf8')
      const turns = parseTranscriptToTurns(content, {
        runId,
        newId: () => `transcript-${randomUUID()}`,
        now: () => new Date().toISOString()
      })
      const matching = promptHash ? [...turns].reverse().find((turn) => createHash('sha256').update(turn.userText).digest('hex') === promptHash) : undefined
      return { stable: true, observed: true, events: (matching ?? turns.at(-1))?.items ?? [] }
    }
    previous = size
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return { stable: false, observed: true, events: [] }
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
    const key = stableHash({ kind: event.kind, stage: event.stage, toolUseId: event.toolUseId, hookId: event.hookId, tool: event.tool, text: event.text, ts: event.ts })
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
    ...(stringAt(payload, 'turn_id', 'turnId') ? { providerTurnId: stringAt(payload, 'turn_id', 'turnId') } : {}),
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
  const transcript = open.transcriptPath ? await stableTranscript(open.transcriptPath, runId, open.promptHash) : { stable: true, observed: false, events: [] }
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
  const evidence = aggregateTurnEvidence({
    userText: open.prompt,
    events,
    source: transcript.observed ? 'provider_transcript+lifecycle_hooks' : 'lifecycle_hooks',
    observable: {
      assistant: transcript.observed || events.some((event) => event.kind === 'model' && event.stage === 'text'),
      tools: true,
      hooks: enablement.config.capture.hooks && transcript.observed,
      usage: hasUsage,
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
  await writeJsonAtomic(statePath(root), { ...session, lastCommittedRecordId: committed.record.recordId }, { sync: false })
  await rm(openPath(root), { force: true })
  await clearRuntimeTurn(enablement.dataRoot, turnRoot(root, open.generation))
  return { status: committed.status, record: committed.record }
}

function isSynthetic(payload: Record<string, unknown>): boolean {
  return payload.isMeta === true || payload.synthetic === true || stringAt(payload, 'source') === 'synthetic'
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
      if (START_EVENTS.has(input.event)) {
        const prompt = promptOf(input.payload)
        const promptHash = prompt ? createHash('sha256').update(prompt).digest('hex') : undefined
        const providerTurnId = stringAt(input.payload, 'turn_id', 'turnId')
        const startFingerprint = stableHash({ event: input.event, payload: input.payload })
        if (open && (
          open.startFingerprint === startFingerprint ||
          (providerTurnId && open.providerTurnId === providerTurnId) ||
          (open.status === 'open' && open.promptHash && open.promptHash === promptHash)
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
