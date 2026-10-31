import { homedir } from 'node:os'
import { classifyTool, fileOpOf, mcpPayloadFailed, parseMcp } from '../../shared/trace'
import { normalizeOpenCodeTool } from './opencode-errors'
import type { OpenCodeHookTraceRecord } from './opencode-server'
import {
  canonicalExistingPath,
  eventState,
  newEvent,
  pathInside,
  record,
  rememberOpenCodeMessage
} from './opencode-records'
import type { ProviderRunRequest } from './types'

export async function openCodeSkillScope(
  cwd: string,
  location: string,
  homeDir = homedir()
): Promise<'project' | 'user' | 'unknown'> {
  const [canonicalCwd, canonicalLocation, canonicalHome] = await Promise.all([
    canonicalExistingPath(cwd),
    canonicalExistingPath(location),
    canonicalExistingPath(homeDir)
  ])
  if (!canonicalLocation) return 'unknown'
  if (canonicalCwd && pathInside(canonicalCwd, canonicalLocation)) return 'project'
  if (canonicalHome && pathInside(canonicalHome, canonicalLocation)) return 'user'
  return 'unknown'
}

export function emitOpenCodeHookEvents(
  request: ProviderRunRequest,
  records: OpenCodeHookTraceRecord[],
  sessionId: string,
  tracePath: string
): void {
  const state = eventState(request)
  const pending = new Map<string, OpenCodeHookTraceRecord>()
  const invalid = new Set<string>()
  const completed = new Set<string>()
  const pairs = new Map<string, { start: OpenCodeHookTraceRecord; response: OpenCodeHookTraceRecord }>()
  for (const record of records) {
    if (record.sessionId !== sessionId) continue
    const key = `${record.sessionId}\0${record.callId}\0${record.tool}`
    if (invalid.has(key) || state.hookResults.has(key)) continue
    if (completed.has(key)) {
      completed.delete(key)
      pairs.delete(key)
      invalid.add(key)
      continue
    }
    if (record.stage === 'hook_started') {
      if (!pending.has(key)) pending.set(key, record)
      else {
        pending.delete(key)
        invalid.add(key)
      }
      continue
    }
    const start = pending.get(key)
    if (!start) {
      invalid.add(key)
      continue
    }
    pending.delete(key)
    completed.add(key)
    pairs.set(key, { start, response: record })
  }
  for (const { start, response } of pairs.values()) {
    const key = `${start.sessionId}\0${start.callId}\0${start.tool}`
    if (invalid.has(key) || state.hookResults.has(key)) continue
    state.hookResults.add(key)
    const hookId = `opencode:${start.sessionId}:${start.callId}`
    request.emit(newEvent(request.runId, {
      kind: 'hook',
      stage: 'hook_started',
      tool: start.tool,
      name: 'ToolExecute',
      hookId,
      hookName: `OpenCode:${start.tool}`,
      hookEvent: 'ToolExecute',
      hookOutcome: 'started',
      toolUseId: start.callId,
      runtimeMetadata: {
        source: 'opencode_native_plugin_hook',
        sourceTracePath: tracePath,
        sourceRecordSha256: start.recordSha256,
        sourceRecordHashBasis: 'jsonl_utf8_with_lf',
        nativeHookEvent: 'tool.execute.before'
      }
    }, start.timestamp))
    request.emit(newEvent(request.runId, {
      kind: 'hook',
      stage: 'hook_response',
      tool: response.tool,
      name: 'ToolExecute',
      hookId,
      hookName: `OpenCode:${response.tool}`,
      hookEvent: 'ToolExecute',
      hookOutcome: 'success',
      toolUseId: response.callId,
      runtimeMetadata: {
        source: 'opencode_native_plugin_hook',
        sourceTracePath: tracePath,
        sourceRecordSha256: response.recordSha256,
        sourceRecordHashBasis: 'jsonl_utf8_with_lf',
        nativeHookEvent: 'tool.execute.after'
      }
    }, response.timestamp))
  }
}

export function emitOpenCodeEvent(request: ProviderRunRequest, raw: unknown, sessionId: string): void {
  const event = record(raw)
  const payload = record(event.properties ?? event.data)
  if (payload.sessionID !== sessionId) return
  const type = String(event.type ?? '')
  if (type === 'message.updated') {
    rememberOpenCodeMessage(eventState(request), record(payload.info))
    return
  }
  if (type === 'message.removed') {
    const messageId = String(payload.messageID ?? '')
    if (messageId) {
      const state = eventState(request)
      state.messages.delete(messageId)
      state.streamedTextByMessageId.delete(messageId)
      state.clearedTextMessageIds.add(messageId)
      request.emit(newEvent(request.runId, {
        kind: 'model',
        stage: 'text',
        text: '',
        messageId,
        runtimeMetadata: { source: 'opencode_message_removed', replacesStreamedText: true }
      }))
    }
    return
  }
  if (type === 'message.part.removed') {
    const messageId = String(payload.messageID ?? record(payload.part).messageID ?? '')
    if (messageId) {
      const state = eventState(request)
      state.streamedTextByMessageId.delete(messageId)
      state.clearedTextMessageIds.add(messageId)
      request.emit(newEvent(request.runId, {
        kind: 'model',
        stage: 'text',
        text: '',
        messageId,
        runtimeMetadata: { source: 'opencode_message_part_removed', replacesStreamedText: true }
      }))
    }
    return
  }
  if (type === 'session.next.compaction.ended') {
    const providerEventId = String(payload.messageID ?? event.id ?? '')
    if (!providerEventId || eventState(request).compactions.has(providerEventId)) return
    eventState(request).compactions.add(providerEventId)
    const trigger: 'auto' | 'manual' | undefined =
      payload.reason === 'auto' ? 'auto' : payload.reason === 'manual' ? 'manual' : undefined
    const compaction = { ...(trigger ? { trigger } : {}), providerEventId }
    const timestamp = typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)
      ? new Date(payload.timestamp).toISOString()
      : undefined
    request.emit(newEvent(request.runId, {
      kind: 'harness',
      stage: 'context_compaction',
      compaction,
      input: compaction,
      runtimeMetadata: { source: 'opencode_compaction_ended' }
    }, timestamp))
    return
  }
  const cachedPartType = type === 'message.part.delta' && typeof payload.partID === 'string'
    ? eventState(request).partTypesById.get(payload.partID)
    : undefined
  if (type === 'session.next.text.delta' || (type === 'message.part.delta' && payload.field === 'text' && cachedPartType !== 'reasoning')) {
    const messageId = typeof payload.assistantMessageID === 'string'
      ? payload.assistantMessageID
      : typeof payload.messageID === 'string'
        ? payload.messageID
        : undefined
    if (messageId) {
      const state = eventState(request)
      const streamed = state.streamedTextByMessageId.get(messageId) ?? ''
      const text = `${streamed}${String(payload.delta ?? '')}`
      state.streamedTextByMessageId.set(messageId, text)
      if (state.clearedTextMessageIds.has(messageId)) {
        request.emit(newEvent(request.runId, {
          kind: 'model',
          stage: 'text',
          text,
          messageId,
          runtimeMetadata: { source: 'opencode_retry_text', replacesStreamedText: true, genuineStreamDelta: String(payload.delta ?? '') }
        }))
        return
      }
    }
    request.emit(newEvent(request.runId, {
      kind: 'model',
      stage: 'text_delta',
      text: String(payload.delta ?? ''),
      messageId
    }))
    return
  }
  if (type === 'session.next.reasoning.delta' || (type === 'message.part.delta' && (payload.field === 'reasoning' || (payload.field === 'text' && cachedPartType === 'reasoning')))) {
    request.emit(newEvent(request.runId, { kind: 'model', stage: 'thinking', thinking: String(payload.delta ?? '') }))
    return
  }
  const part = type === 'message.part.updated' ? record(payload.part) : payload
  if (type === 'message.part.updated' && typeof part.id === 'string' && typeof part.type === 'string') {
    eventState(request).partTypesById.set(part.id, part.type)
  }
  const toolState = record(part.state)
  const toolTime = record(toolState.time)
  const isPartTool = type === 'message.part.updated' && part.type === 'tool'
  const toolUseId = String(part.callID ?? '')
  const messageId = typeof part.messageID === 'string'
    ? part.messageID
    : typeof payload.assistantMessageID === 'string'
      ? payload.assistantMessageID
      : undefined
  const state = eventState(request)
  const eventTimestamp = typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)
    ? payload.timestamp
    : undefined
  const toolStateStart = typeof toolTime.start === 'number' && Number.isFinite(toolTime.start)
    ? toolTime.start
    : undefined
  const nativeStart = toolStateStart ?? state.toolStartedAt.get(toolUseId) ?? eventTimestamp
  const nativeEnd = typeof toolTime.end === 'number' && Number.isFinite(toolTime.end)
    ? toolTime.end
    : eventTimestamp
  const status = String(toolState.status ?? '')
  const isToolStart = type === 'session.next.tool.called' || (isPartTool && ['running', 'completed', 'error'].includes(status))
  if (isToolStart && toolUseId && !eventState(request).starts.has(toolUseId)) {
    eventState(request).starts.add(toolUseId)
    if (nativeStart != null) state.toolStartedAt.set(toolUseId, nativeStart)
    const normalized = normalizeOpenCodeTool(String(part.tool ?? ''), isPartTool ? toolState.input : part.input)
    const { toolName, input } = normalized
    const classified = classifyTool(toolName, input)
    const mcp = parseMcp(toolName, input)
    if (mcp.isMcp) eventState(request).mcpByToolUseId.set(toolUseId, mcp)
    request.emit(newEvent(request.runId, {
      kind: classified.kind,
      stage: `${classified.kind}:${classified.name}`,
      tool: toolName,
      name: classified.name,
      toolUseId,
      messageId,
      input,
      ...mcp,
      ...fileOpOf(toolName, input)
    }, nativeStart == null ? undefined : new Date(nativeStart).toISOString()))
  }
  const isToolResult = type === 'session.next.tool.success' || type === 'session.next.tool.failed' || (isPartTool && ['completed', 'error'].includes(status))
  if (isToolResult && toolUseId && !eventState(request).results.has(toolUseId)) {
    eventState(request).results.add(toolUseId)
    const failed = type.endsWith('failed') || status === 'error'
    const value = isPartTool ? (failed ? toolState.error : toolState.output) : (part.result ?? part.content ?? part.error ?? null)
    const output = typeof value === 'string' ? value : JSON.stringify(value)
    const mcp = eventState(request).mcpByToolUseId.get(toolUseId)
    eventState(request).mcpByToolUseId.delete(toolUseId)
    const normalized = normalizeOpenCodeTool(String(part.tool ?? ''), isPartTool ? toolState.input : part.input)
    request.emit(newEvent(request.runId, {
      kind: 'tool',
      stage: 'tool_result',
      tool: normalized.toolName,
      toolUseId,
      messageId,
      durationMs: nativeStart != null && nativeEnd != null && nativeEnd >= nativeStart
        ? nativeEnd - nativeStart
        : undefined,
      output,
      ...(mcp ?? {}),
      isError: failed || (mcp?.isMcp === true && mcpPayloadFailed(output))
    }, nativeEnd == null ? undefined : new Date(nativeEnd).toISOString()))
    state.toolStartedAt.delete(toolUseId)
  }
}
