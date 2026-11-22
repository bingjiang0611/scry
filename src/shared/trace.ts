import type { ProviderId } from './provider.js'
import type { AgentInputAttachment, AgentQuestionRequest, AgentStopState, RuntimeProvider, RuntimeFailureStage, RunTerminationReason, AgentIntervention, AgentSteerCapability, AgentSteerEvidence } from './runtime.js'
import type { CreditUsageEvidence } from './credit-usage.js'
import type { CostSource, CostConfidence, CostUnit, ModelUsageRow } from './trace-usage.js'
import type { TurnDiffSnapshot } from './turn-diff.js'
import type { BillingProvider } from './billing.js'
import type { BackgroundWork } from './background-work.js'

export type {
  CostSource,
  CostConfidence,
  CostUnit,
  ModelUsageRow,
  DbStats,
  UsageAnalyticsRangeDays,
  QoderCreditEvidence,
  UsageAnalyticsAggregate,
  UsageAnalyticsDayRow,
  UsageAnalyticsDailyProviderRow,
  UsageAnalyticsBreakdownRow,
  UsageAnalytics,
  UsageStats
} from './trace-usage.js'
export {
  type DiffFileChange,
  type DiffFile,
  type TurnDiffStatus,
  type TurnDiffReason,
  type WorkspaceDiffResult,
  TURN_DIFF_STAGE,
  SESSION_DIFF_STAGE,
  TURN_DIFF_PREVIEW_STAGE,
  SESSION_DIFF_PREVIEW_STAGE,
  isDiffSnapshotStage,
  isDiffPreviewStage,
  type TurnDiffBaselineOrigin,
  type WorktreeBaselineReason,
  WORKTREE_BASELINE_REASONS,
  type TurnDiffPatchStatus,
  type TurnDiffPatchReason,
  type TurnDiffFallbackReason,
  type TurnDiffCollection,
  type TurnDiffSnapshot,
  type WorkspaceOverlapEvidence,
  normalizeTurnDiffSnapshot,
  normalizeWorkspaceOverlap
} from './turn-diff.js'

// 统一 trace 事件模型 —— 所有 Provider 共享 kind/baggage/stage 设计，
// 让 SDK stream 和未来 codex adapter 都归一化到同一格式（一份数据多处用）。

export type TraceKind = 'tool' | 'skill' | 'agent' | 'human' | 'model' | 'harness' | 'hook'
export type FileOp = 'read' | 'write' | 'edit'

// P3 审计：危险工具调用的标记（观测，不阻塞）。danger=高危(删/提权/push/远程脚本)，warn=可疑(跨项目写/MCP写)。
export type DangerLevel = 'danger' | 'warn'
export interface DangerVerdict {
  level: DangerLevel
  reason: string
}

export interface HookConfiguredCommand {
  command: string
  source: 'user' | 'project' | 'local' | 'plugin'
  sourcePath: string
  matcher?: string
  pluginId?: string
  timeoutSeconds?: number
}

export interface McpCallRef {
  server: string
  action: string
  tool: string
}

// B1：进行中 run 的快照（main 缓冲、renderer 重挂时拉取恢复，避免 reload/HMR 丢失在途 trace）。
// 与 renderer 的 Turn 结构一致（结构化类型，可互赋）。
export interface ActiveRun {
  runId: string
  /** Stable owner for managed-conversation attention, independent of Provider bindings. */
  conversationId?: string
  /**
   * Attention owner when it is not this conversation: a side chat has no sidebar row of its
   * own, so its unread result and questions belong to the row of the session it came from.
   */
  attentionKey?: string
  providerId?: ProviderId
  agentProfileId?: string
  cwd?: string
  externalSessionId?: string
  userText: string
  attachments?: AgentInputAttachment[]
  pendingQuestions?: AgentQuestionRequest[]
  items: TraceEvent[]
  /** Latest bounded legacy observation; global summaries must not rescan the trace. */
  llmPerformance?: import('./llm-performance.js').LlmPerformance
  done: boolean
  /** Provider transport settled. Independent of the local finalization below. */
  providerSettled?: boolean
  /**
   * Local finalization (turn diff, archive, managed settlement) is still open after the
   * Provider settled. Such a run still owns its conversation and its recording fences, so
   * admission and deletion keep waiting for it, while stop control must not call into an
   * ended Provider.
   */
  localFinalizing?: boolean
  /** 已请求停止时的真实停止进度；缺失表示没有人请求过停止，不表示已终止。 */
  stopState?: AgentStopState
  sessionId?: string
  error?: string
  errorHint?: string
}

// 斜杠命令：来自各 Provider 的命令目录；可包含原生命令或 Scry 映射的 Skill 别名，供 composer 的 / 命令面板。
export interface SlashCmd {
  name: string
  description: string
  argumentHint?: string
}

// MCP 真实状态：来自当前 runtime 的 init/live 信息；Claude SDK 下和终端 /mcp 一致（含 needs-auth）。
export interface McpLiveStatus {
  name: string
  status: 'connected' | 'cached' | 'disconnected' | 'failed' | 'needs-auth' | 'needs-client-registration' | 'pending' | 'disabled'
  serverName?: string
  serverVersion?: string
  tools?: number
  toolNames?: string[]
}

export const HOOK_DELIVERY_STAGE = 'hook_delivery'

export type CompactionTrigger = 'auto' | 'manual'

export interface ContextCompaction {
  trigger?: CompactionTrigger
  preTokens?: number
  postTokens?: number
  providerEventId?: string
}

export interface TraceEvent {
  /** One run-scoped metering snapshot, separate from result USD/token counters. */
  creditUsage?: CreditUsageEvidence
  inputContent?: import('./tool-content.js').ToolContent
  outputContent?: import('./tool-content.js').ToolContent
  /** Durable assistant/reasoning body with a bounded inline preview. */
  modelContent?: import('./tool-content.js').ToolContent
  id: string
  ts: string
  runId: string // 一次 query() = 一个 run（模式 A 下 app 自造 baggage）
  kind: TraceKind
  stage: string // 如 tool:Bash / skill:xxx / agent:xxx / prompt / text / thinking / result
  tool?: string
  toolUseId?: string
  parentToolUseId?: string | null
  agentId?: string
  name?: string
  hookId?: string
  hookEvent?: string
  hookName?: string
  hookCommand?: string
  hookConfiguredCommands?: HookConfiguredCommand[]
  hookOutcome?: string
  hookExitCode?: number
  isMcp?: boolean
  mcpServer?: string
  mcpAction?: string
  mcpTool?: string
  mcpCalls?: McpCallRef[]
  fileOp?: FileOp
  filePath?: string
  text?: string
  thinking?: string
  input?: unknown
  messageId?: string // SDK assistant message.id = llm_request 级（一个 run 内多条）；result 事件无
  durationMs?: number
  durationApiMs?: number
  llmCall?: { outputTokens: number; durationMs: number; firstTokenMs?: number; model?: string }
  llmPerformance?: import('./llm-performance.js').LlmPerformance
  costUsd?: number
  costSource?: CostSource
  costConfidence?: CostConfidence
  costUnit?: CostUnit
  tokensIn?: number
  tokensOut?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
  reasoningTokens?: number
  contextTokens?: number
  contextModel?: string
  contextProvider?: string
  contextUsageSource?: string
  contextUsageQuality?: 'exact' | 'inferred'
  modelUsage?: ModelUsageRow[]
  isError?: boolean
  output?: string
  danger?: DangerVerdict // P3 审计：危险工具标记（normalize 时分类，观测不阻塞）
  turnDiff?: TurnDiffSnapshot // 每轮开始/结束 Git 工作树快照的净变化；Provider 无关，旧历史可缺失
  providerId?: ProviderId
  runtimeProvider?: RuntimeProvider
  billingProvider?: BillingProvider
  upstreamProvider?: string
  accountLabel?: string
  usageSource?: string
  runtimeFailureStage?: RuntimeFailureStage
  terminationReason?: RunTerminationReason
  providerStopReason?: string
  toolTermination?: { tool: string; message: string }
  providerCommand?: { name: string; source: 'extension'; modelTurn: 'unobserved' }
  runtimeMetadata?: Record<string, unknown>
  backgroundWork?: BackgroundWork
  intervention?: AgentIntervention
  steerCapability?: AgentSteerCapability
  steer?: AgentSteerEvidence
  compaction?: ContextCompaction
}

export function contextCompactionOf(event: TraceEvent): ContextCompaction | null {
  if (event.kind !== 'harness') return null
  if (event.stage === 'context_compaction') return event.compaction ?? {}
  if (event.stage !== 'compaction_end') return null
  const raw = event.runtimeMetadata
  if (raw?.aborted !== false || raw.errorMessage || !raw.result || typeof raw.result !== 'object') return null
  const result = raw.result as Record<string, unknown>
  const trigger = raw.reason === 'manual' ? 'manual'
    : raw.reason === 'threshold' || raw.reason === 'overflow' ? 'auto' : undefined
  return {
    ...(trigger ? { trigger } : {}),
    ...(typeof result.tokensBefore === 'number' && Number.isFinite(result.tokensBefore) && result.tokensBefore >= 0
      ? { preTokens: result.tokensBefore } : {})
  }
}

export interface ContextUsageEvidence {
  used: number
  window: number
  model: string
  provider?: string
  source?: string
  quality?: 'exact' | 'inferred'
}

export function contextUsageEvidence(event: Pick<TraceEvent, 'contextTokens' | 'contextModel' | 'contextProvider' | 'contextUsageSource' | 'contextUsageQuality' | 'modelUsage'>): ContextUsageEvidence | null {
  if (event.contextTokens == null || !Number.isFinite(event.contextTokens) || event.contextTokens < 0) return null
  const candidates = (event.modelUsage ?? []).filter((row) =>
    row.contextWindow != null && Number.isFinite(row.contextWindow) && row.contextWindow > 0
  )
  const modelMatches = event.contextModel
    ? candidates.filter((candidate) => candidate.model === event.contextModel)
    : []
  const row = event.contextModel
    ? event.contextProvider
      ? modelMatches.find((candidate) => candidate.upstreamProvider === event.contextProvider)
      : modelMatches.length === 1
        ? modelMatches[0]
        : undefined
    : event.modelUsage?.length === 1 && candidates.length === 1
      ? candidates[0]
      : undefined
  if (!row?.contextWindow) return null
  return {
    used: event.contextTokens,
    window: row.contextWindow,
    model: row.model,
    ...(event.contextProvider ?? row.upstreamProvider ? { provider: event.contextProvider ?? row.upstreamProvider } : {}),
    ...(event.contextUsageSource ? { source: event.contextUsageSource } : {}),
    ...(event.contextUsageQuality ? { quality: event.contextUsageQuality } : {})
  }
}

export function classifyTool(
  toolName: string,
  input?: Record<string, unknown>
): { kind: TraceKind; name: string } {
  if (toolName === 'Skill') {
    const name = (input?.skill ?? input?.skill_name) as string | undefined
    return { kind: 'skill', name: name ?? toolName }
  }
  if (toolName === 'Task' || toolName === 'Agent') {
    const name = (input?.subagent_type ?? input?.description) as string | undefined
    return { kind: 'agent', name: name ?? toolName }
  }
  return { kind: 'tool', name: toolName }
}

export interface ParsedMcp {
  isMcp: boolean
  mcpServer?: string
  mcpAction?: string
  mcpTool?: string
  mcpCalls?: McpCallRef[]
}

function parsedMcp(calls: McpCallRef[]): ParsedMcp {
  const first = calls[0]
  if (!first) return { isMcp: false }
  return {
    isMcp: true,
    mcpServer: first.server,
    mcpAction: first.action,
    mcpTool: first.tool,
    mcpCalls: calls
  }
}

function parseDirectMcpTool(toolName: string): ParsedMcp {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    const server = parts[1]
    const action = parts.slice(2).join('__')
    if (server && action) return parsedMcp([{ server, action, tool: toolName }])
  }
  return { isMcp: false }
}

function matchesFor(
  source: string,
  pattern: RegExp
): Array<{ index: number; call: McpCallRef }> {
  return [...source.matchAll(pattern)].flatMap((match) => {
    const server = match[1]
    const action = match[2]
    return server && action
      ? [{ index: match.index ?? 0, call: { server, action, tool: `mcporter:${server}.${action}` } }]
      : []
  })
}

function parseMcporterCommand(command: string): ParsedMcp {
  const normalized = command.replace(/\\(["'`])/g, '$1')
  const direct = matchesFor(
    normalized,
    /(?:^|[\s;&|"'`])(?:[^\s"';&|]*\/)?mcporter\s+call\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_.:-]+)/g
  )
  const variable = /\bmcporter\b/.test(normalized)
    ? matchesFor(
        normalized,
        /(?:^|[\s;&|"'`])["']?\$[A-Za-z_][A-Za-z0-9_]*["']?\s+call\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_.:-]+)/g
      )
    : []
  return parsedMcp([...direct, ...variable].sort((a, b) => a.index - b.index).map((match) => match.call))
}

const QODER_MCP_WRAPPER = 'mcp_call'

function parseWrappedMcp(input?: Record<string, unknown>): ParsedMcp {
  const wrappedTool = input?.toolName
  return typeof wrappedTool === 'string' ? parseDirectMcpTool(wrappedTool) : { isMcp: false }
}

export function parseMcp(
  toolName: string,
  input?: Record<string, unknown>
): ParsedMcp {
  const direct = parseDirectMcpTool(toolName)
  if (direct.isMcp) return direct
  if (toolName === 'Bash' && typeof input?.command === 'string') return parseMcporterCommand(input.command)
  if (toolName === QODER_MCP_WRAPPER) return parseWrappedMcp(input)
  return { isMcp: false }
}

export interface ToolInvocation {
  tool: string
  input?: Record<string, unknown>
  mcp: ParsedMcp
}

export function toolInvocation(toolName: string, input?: Record<string, unknown>): ToolInvocation {
  const mcp = parseMcp(toolName, input)
  if (toolName !== QODER_MCP_WRAPPER || !mcp.isMcp) return { tool: toolName, input, mcp }
  const args = input?.arguments
  return {
    tool: mcp.mcpTool ?? toolName,
    input: args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : input,
    mcp
  }
}

export function mcpCallsForEvent(
  event: Pick<TraceEvent, 'isMcp' | 'tool' | 'input' | 'mcpCalls' | 'mcpServer' | 'mcpAction' | 'mcpTool'>
): McpCallRef[] {
  if (event.mcpCalls?.length) return event.mcpCalls
  const parsed = parseMcp(
    event.tool ?? '',
    event.input && typeof event.input === 'object' && !Array.isArray(event.input)
      ? event.input as Record<string, unknown>
      : undefined
  )
  if (parsed.mcpCalls?.length) return parsed.mcpCalls
  if (!event.isMcp) return []
  return [{
    server: event.mcpServer ?? '?',
    action: event.mcpAction ?? ((event.tool ?? '').split('__').slice(2).join('__') || event.mcpTool || event.tool || ''),
    tool: event.mcpTool ?? event.tool ?? ''
  }]
}

function payloadObjectFailed(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  if (payload.success === false || payload.ok === false) return true
  if (typeof payload.status === 'string' && /^(?:error|failed|failure)$/i.test(payload.status)) return true
  return payload.error != null && payload.error !== false && payload.error !== ''
}

function payloadEnvelopeFailed(value: unknown): boolean {
  if (payloadObjectFailed(value)) return true
  if (!Array.isArray(value)) return false
  return value.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const envelope = item as Record<string, unknown>
    if (envelope.type !== 'text' || typeof envelope.text !== 'string') return false
    try {
      return payloadObjectFailed(JSON.parse(envelope.text))
    } catch {
      return false
    }
  })
}

export function mcpPayloadFailed(output: unknown): boolean {
  if (payloadEnvelopeFailed(output)) return true
  if (typeof output !== 'string') return false
  const text = output.trim()
  if (!text) return false
  const candidates = [text, ...text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)]
  for (const candidate of candidates) {
    const jsonObject = candidate.startsWith('{') && candidate.endsWith('}')
    const jsonArray = candidate.startsWith('[') && candidate.endsWith(']')
    if (!jsonObject && !jsonArray) continue
    try {
      if (payloadEnvelopeFailed(JSON.parse(candidate))) return true
    } catch {
    }
  }
  return false
}

const FILE_OP_TOOLS: Record<string, FileOp> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit'
}

export function fileOpOf(
  toolName: string,
  input?: Record<string, unknown>
): { fileOp?: FileOp; filePath?: string } {
  const op = FILE_OP_TOOLS[toolName.toLowerCase()]
  if (!op) return {}
  const rawPath = input?.file_path ?? input?.path
  const fp = typeof rawPath === 'string' ? rawPath : undefined
  if (!fp) return {}
  return { fileOp: op, filePath: fp }
}

export { maskSecrets } from './secret-mask.js'
