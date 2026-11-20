import { fileOpOf, type TraceEvent } from '../../shared/trace'
import type { ProviderCommand } from '../../shared/provider'
import type { AcpContextUsage } from './antigravity-usage'

interface ToolCallState {
  id: string
  name: string
  title?: string
  emittedStart: boolean
  emittedEnd: boolean
}

const SUBAGENT_TOOL_NAMES = new Set(['invoke_subagent', 'start_subagent'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (isRecord(content)) {
    if (typeof content.text === 'string') return content.text
    if (isRecord(content.content) && typeof content.content.text === 'string') return content.content.text
  }
  if (Array.isArray(content)) {
    return content.map(extractTextFromContent).filter(Boolean).join('\n')
  }
  return ''
}

function inferToolName(update: Record<string, unknown>): string {
  const rawInput = isRecord(update.rawInput) ? update.rawInput : undefined
  if (typeof update.name === 'string' && update.name.trim()) return update.name.trim()
  if (typeof rawInput?.name === 'string' && rawInput.name.trim()) return rawInput.name.trim()
  if (typeof update.title === 'string' && update.title.trim()) {
    const m = update.title.trim().match(/^Run\s+([A-Za-z0-9_.:-]+)$/i)
    if (m) return m[1]
    return update.title.trim()
  }
  if (typeof update.kind === 'string' && update.kind.trim()) return update.kind.trim()
  return 'tool'
}

function inferFileOp(
  toolName: string,
  kind: unknown,
  rawInput: unknown,
  locations: unknown
): { fileOp?: 'read' | 'write' | 'edit'; filePath?: string } {
  const inputRecord = isRecord(rawInput) ? rawInput : undefined
  const byName = fileOpOf(toolName, inputRecord)
  if (byName.fileOp && byName.filePath) return byName
  const locPath = Array.isArray(locations) && isRecord(locations[0]) && typeof locations[0].path === 'string'
    ? locations[0].path
    : undefined
  const path = typeof inputRecord?.path === 'string'
    ? inputRecord.path
    : typeof inputRecord?.file_path === 'string'
      ? inputRecord.file_path
      : typeof inputRecord?.Path === 'string'
        ? inputRecord.Path
        : locPath
  if (!path) return {}
  if (kind === 'read') return { fileOp: 'read', filePath: path }
  if (kind === 'edit') return { fileOp: 'edit', filePath: path }
  return {}
}

export class AntigravityEventTranslator {
  private seq = 0
  private readonly tools = new Map<string, ToolCallState>()
  private _hasSubagentTool = false
  private _contextUsage: AcpContextUsage | null = null
  private _availableCommands: ProviderCommand[] = []
  private _sessionTitle: string | undefined
  /** Drop `session/load` history replay notifications so old turns never pollute the active trace. */
  suppressReplay = false

  constructor(
    private readonly runId: string,
    private readonly emit: (event: TraceEvent) => void
  ) {}

  get hasSubagentTool(): boolean {
    return this._hasSubagentTool
  }

  get contextUsage(): AcpContextUsage | null {
    return this._contextUsage
  }

  get availableCommands(): ProviderCommand[] {
    return this._availableCommands
  }

  get sessionTitle(): string | undefined {
    return this._sessionTitle
  }

  private nextId(suffix: string): string {
    return `${this.runId}:agy:${++this.seq}:${suffix}`
  }

  /** Ensure a logical tool_use exists even when `request_permission` arrives before `tool_call`. */
  ensureToolCall(toolCall: Record<string, unknown> | undefined): void {
    if (this.suppressReplay || !toolCall) return
    const toolCallId = typeof toolCall.toolCallId === 'string' && toolCall.toolCallId
      ? toolCall.toolCallId
      : undefined
    if (!toolCallId || toolCallId.startsWith('interaction_')) return
    this.handleToolStart(toolCallId, toolCall)
  }

  handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || !isRecord(params)) return
    const update = isRecord(params.update) ? params.update : undefined
    if (!update) return
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''

    if (kind === 'available_commands_update') {
      if (Array.isArray(update.availableCommands)) {
        this._availableCommands = update.availableCommands
          .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.name === 'string' && item.name.trim().length > 0)
          .map((item) => ({
            name: (item.name as string).trim(),
            description: typeof item.description === 'string' ? item.description : '',
            source: 'builtin' as const
          }))
      }
      return
    }

    if (kind === 'session_info_update') {
      if (typeof update.title === 'string' && update.title.trim()) {
        this._sessionTitle = update.title.trim()
      }
      return
    }

    if (this.suppressReplay) return

    if (kind === 'agent_message_chunk') {
      const text = extractTextFromContent(update.content)
      if (!text) return
      this.emit({
        id: this.nextId('text'),
        runId: this.runId,
        ts: new Date().toISOString(),
        kind: 'model',
        stage: 'text_delta',
        text
      })
      return
    }

    if (kind === 'agent_thought_chunk') {
      const text = extractTextFromContent(update.content)
      if (!text) return
      this.emit({
        id: this.nextId('thought'),
        runId: this.runId,
        ts: new Date().toISOString(),
        kind: 'model',
        stage: 'thinking',
        text
      })
      return
    }

    if (kind === 'usage_update') {
      const used = typeof update.used === 'number' && Number.isFinite(update.used) ? update.used : undefined
      const size = typeof update.size === 'number' && Number.isFinite(update.size) ? update.size : undefined
      if (used !== undefined || size !== undefined) {
        this._contextUsage = { used: used ?? this._contextUsage?.used, size: size ?? this._contextUsage?.size }
      }
      return
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const toolCallId = typeof update.toolCallId === 'string' && update.toolCallId
        ? update.toolCallId
        : undefined
      if (!toolCallId) return
      this.handleToolStart(toolCallId, update)
      const status = typeof update.status === 'string' ? update.status.toLowerCase() : ''
      if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'error') {
        this.handleToolEnd(toolCallId, status, update)
      }
      return
    }

    // Unknown `sessionUpdate` types are ignored here; raw JSON already landed in `recordNative`.
  }

  private handleToolStart(toolCallId: string, data: Record<string, unknown>): void {
    const existing = this.tools.get(toolCallId)
    if (existing?.emittedStart) return
    const name = inferToolName(data)
    if (SUBAGENT_TOOL_NAMES.has(name.toLowerCase()) ||
        (typeof data.title === 'string' && /\b(?:invoke_subagent|start_subagent)\b/i.test(data.title))) {
      this._hasSubagentTool = true
    }
    const state: ToolCallState = {
      id: toolCallId,
      name,
      title: typeof data.title === 'string' ? data.title : undefined,
      emittedStart: true,
      emittedEnd: existing?.emittedEnd ?? false
    }
    this.tools.set(toolCallId, state)
    const fileInfo = inferFileOp(name, data.kind, data.rawInput, data.locations)
    this.emit({
      id: this.nextId('tool_use'),
      runId: this.runId,
      ts: new Date().toISOString(),
      kind: 'tool',
      stage: 'tool_use',
      toolUseId: toolCallId,
      tool: name,
      name: state.title ?? name,
      ...(isRecord(data.rawInput) ? { input: data.rawInput } : {}),
      ...(fileInfo.fileOp ? { fileOp: fileInfo.fileOp, filePath: fileInfo.filePath } : {})
    })
  }

  private handleToolEnd(toolCallId: string, status: string, data: Record<string, unknown>): void {
    const state = this.tools.get(toolCallId)
    if (!state || state.emittedEnd) return
    state.emittedEnd = true
    const text = extractTextFromContent(data.content ?? data.rawOutput)
    const isError = status === 'failed' || status === 'error'
    this.emit({
      id: this.nextId('tool_result'),
      runId: this.runId,
      ts: new Date().toISOString(),
      kind: 'tool',
      stage: 'tool_result',
      toolUseId: toolCallId,
      tool: state.name,
      isError,
      ...(text ? { text } : {})
    })
  }
}
