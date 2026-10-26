import { type TraceEvent, classifyTool, fileOpOf, parseMcp } from '../../shared/trace.js'
import { type ParsedTranscriptTurn, stringAt, nestedRecord, timestampOf, epochSecondsAt, terminalStatus, inferredSkillEvents, summarize } from './recorder-contracts.js'
import { classifyDanger } from '../../main/danger.js'
import { stableHash } from './store.js'
import { appendCodexPatchResult, finalizeCodexTurns, callInput, codexHookEvent, explicitSkillEvent, indexedToolOutputs, normalizedCodexCalls, outputFailed, outputText, rejectedBeforeExecution, runningCellId, skillInjection, textContent } from './recorder-codex-calls.js'
import { CodexUsageDeltaFilter } from '../../shared/usage-dedupe.js'

export function parseCodexRollout(content: string, runId: string): { recognized: boolean; turns: ParsedTranscriptTurn[] } {
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
      appendCodexPatchResult(current, payload, runId, at, logicalIdsByOuterCall, toolById)
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
  return {
    recognized: sawCodexLine && turns.length > 0,
    turns: finalizeCodexTurns(turns, current, injectedSkill)
  }
}
