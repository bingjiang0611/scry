import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { ParsedMcp, TraceEvent } from '../../shared/trace'
import type { ProviderRunRequest } from './types'

let counter = 0

export const newEvent = (
  runId: string,
  fields: Omit<TraceEvent, 'id' | 'runId' | 'ts'>,
  ts = new Date().toISOString()
): TraceEvent => ({
  id: `opencode-${Date.now().toString(36)}-${(counter++).toString(36)}`,
  runId,
  ts,
  ...fields
})

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

interface OpenCodeEventState {
  starts: Set<string>
  results: Set<string>
  compactions: Set<string>
  hookResults: Set<string>
  mcpByToolUseId: Map<string, ParsedMcp>
  toolStartedAt: Map<string, number>
  streamedTextByMessageId: Map<string, string>
  clearedTextMessageIds: Set<string>
  partTypesById: Map<string, string>
  messages: Map<string, Record<string, unknown>>
}

const eventStates = new WeakMap<ProviderRunRequest, OpenCodeEventState>()

export const eventState = (request: ProviderRunRequest): OpenCodeEventState => {
  const existing = eventStates.get(request)
  if (existing) return existing
  const created = {
    starts: new Set<string>(),
    results: new Set<string>(),
    compactions: new Set<string>(),
    hookResults: new Set<string>(),
    mcpByToolUseId: new Map<string, ParsedMcp>(),
    toolStartedAt: new Map<string, number>(),
    streamedTextByMessageId: new Map<string, string>(),
    clearedTextMessageIds: new Set<string>(),
    partTypesById: new Map<string, string>(),
    messages: new Map<string, Record<string, unknown>>()
  }
  eventStates.set(request, created)
  return created
}

export const canonicalExistingPath = async (path: string): Promise<string | undefined> => {
  if (!isAbsolute(path)) return undefined
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

export const pathInside = (root: string, candidate: string): boolean => {
  const suffix = relative(root, candidate)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}


export function openCodeResultTiming(info: Record<string, unknown>): { ts: string; durationMs: number } | undefined {
  const time = record(info.time)
  const created = typeof time.created === 'number' ? time.created : NaN
  const completed = typeof time.completed === 'number' ? time.completed : NaN
  if (!Number.isFinite(created) || !Number.isFinite(completed) || completed < created) return undefined
  try {
    return { ts: new Date(completed).toISOString(), durationMs: completed - created }
  } catch {
    return undefined
  }
}

export function openCodeMessageRole(info: Record<string, unknown>): string | undefined {
  if (typeof info.role === 'string') return info.role
  return typeof info.type === 'string' ? info.type : undefined
}

export function openCodeMessageId(info: Record<string, unknown>): string | undefined {
  return typeof info.id === 'string' && info.id ? info.id : undefined
}

export function openCodeMessageParentId(info: Record<string, unknown>): string | undefined {
  return typeof info.parentID === 'string' && info.parentID ? info.parentID : undefined
}

export function openCodeCompletedAt(info: Record<string, unknown>): number | undefined {
  const completed = record(info.time).completed
  return typeof completed === 'number' && Number.isFinite(completed) ? completed : undefined
}

export function rememberOpenCodeMessage(state: OpenCodeEventState, info: Record<string, unknown>): void {
  const id = openCodeMessageId(info)
  if (!id) return
  const existing = state.messages.get(id)
  if (existing && openCodeCompletedAt(existing) != null && openCodeCompletedAt(info) == null) return
  state.messages.set(id, info)
}

/** SSE 事件的类型名；取不到就记为 unknown，不猜。 */
export function openCodeEventType(raw: unknown): string {
  const type = record(raw).type
  return typeof type === 'string' && type ? type : 'unknown'
}

/**
 * Text a persisted OpenCode message actually carries. Only real text parts count:
 * synthetic/ignored parts are not input, and attachment parts are not text.
 */
export function openCodeUserText(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined
  const text = parts
    .map(record)
    .filter((part) => part.type === 'text' && part.ignored !== true && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('')
  return text
}
