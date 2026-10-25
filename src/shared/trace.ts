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
  type TurnDiffPatchStatus,
  type TurnDiffPatchReason,
  type TurnDiffFallbackReason,
  type TurnDiffCollection,
  type TurnDiffSnapshot,
  normalizeTurnDiffSnapshot
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
  providerSettled?: boolean
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

/**
 * Hook 生命周期投递 stage。Provider 只把 hook 事件投递给外部 hook 进程（Codex 终端会话就是这样），
 * 不暴露被执行脚本的 command / exit code / outcome 时，recorder 只能证明「该 hook 事件确实触发过」。
 * 这类事件不得与 `hook_started` / `hook_response`（带脚本身份的真实 hook 运行）混为一谈。
 */
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
  agentId?: string // 该事件属于哪个 subagent；主会话事件为 undefined
  name?: string // skill / agent 名
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
  // 一个 shell tool_use 可能串行执行多个 mcporter call。首个调用保留在上方兼容字段，
  // 完整列表供调用统计/MCP 明细使用；runtime tool 本身仍只有一个 lifecycle。
  mcpCalls?: McpCallRef[]
  fileOp?: FileOp
  filePath?: string
  text?: string
  thinking?: string
  input?: unknown
  messageId?: string // SDK assistant message.id = llm_request 级（一个 run 内多条）；result 事件无
  durationMs?: number
  durationApiMs?: number // 仅 result：SDK 权威 API 耗时
  // 一次成功完成的主 Agent 模型请求：本机计时（请求开始→消息结束，含首 token 等待）。只用于速度观测，不是计费用量。
  // firstTokenMs：请求开始→模型开始输出第一个内容块（含思考）；Provider 没有可对齐的首块信号时缺省。
  llmCall?: { outputTokens: number; durationMs: number; firstTokenMs?: number; model?: string }
  llmPerformance?: import('./llm-performance.js').LlmPerformance
  costUsd?: number
  costSource?: CostSource
  costConfidence?: CostConfidence
  costUnit?: CostUnit
  tokensIn?: number // result：从 modelUsage 聚合（顶层 usage 会少算，见 probe）
  tokensOut?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
  reasoningTokens?: number
  contextTokens?: number // result / context_usage：Provider 当前上下文占用；cache 口径由 adapter 吸收
  contextModel?: string // contextTokens 所属模型；多模型会话不得按数组顺序猜窗口
  contextProvider?: string // contextTokens 所属 upstream provider；与 contextModel 共同绑定窗口
  contextUsageSource?: string // 上下文证据来源，如 qoder_control / pi_rpc_assistant_usage
  contextUsageQuality?: 'exact' | 'inferred' // 推导窗口必须显式呈现，不能冒充精确证据
  modelUsage?: ModelUsageRow[] // result：per-model 明细；context_usage：仅模型身份与窗口，不参与累计
  isError?: boolean
  output?: string // 工具结果文本（tool_result），渲染时合并进对应 tool_use
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
  /** Pi RPC tool result explicitly ended execution; this is not proof of Goal completion. */
  toolTermination?: { tool: string; message: string }
  /** Pi acknowledged its extension handler without an observed model turn; not an agent_settled result. */
  providerCommand?: { name: string; source: 'extension'; modelTurn: 'unobserved' }
  runtimeMetadata?: Record<string, unknown>
  backgroundWork?: BackgroundWork
  intervention?: AgentIntervention
  steerCapability?: AgentSteerCapability
  steer?: AgentSteerEvidence
  compaction?: ContextCompaction
}

/** Also reads older Pi archives that retained the raw lifecycle instead of a canonical completion. */
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

// 工具名 → kind 分类
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
  // Codex app-server 会把 shell 包装后的命令保存成
  // `/bin/zsh -lc \"mcporter call ...\"`。先还原仅用于包裹命令的转义引号，
  // 否则 `\"mcporter` 前没有空白，无法识别为 MCP 调用。
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

// MCP 工具识别：
// 1. Claude SDK 原生 MCP tool_use：mcp__<server>__<action>
// 2. 本地 MCP bridge：Bash 里执行 mcporter call <server>.<action>
export function parseMcp(
  toolName: string,
  input?: Record<string, unknown>
): ParsedMcp {
  const direct = parseDirectMcpTool(toolName)
  if (direct.isMcp) return direct
  if (toolName === 'Bash' && typeof input?.command === 'string') return parseMcporterCommand(input.command)
  return { isMcp: false }
}

// 旧会话归档只保存了首个 MCP 的兼容字段，但仍保留原始 shell command。
// 读取时从 command 重新补齐完整调用列表，保证 Claude/Codex/Qoder/OpenCode 的
// 实时流、历史回放和 turn recorder 使用同一套逻辑调用语义。
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

// mcporter 可能在 shell exit=0 时返回业务失败 JSON。只检查完整 JSON 或逐行 JSON 的
// 顶层状态字段，避免把任意工具输出正文里的 “error” 单词误判成失败。
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
      // 非完整 JSON 行不是权威失败证据。
    }
  }
  return false
}

// 文件足迹：Claude/Qoder/Codex 使用 file_path；Pi 原生工具使用 path 和小写工具名。
// Glob/Grep 是 pattern/path 不算「读写」，Bash/MCP 的文件操作此处统计不到（已知盲区，UI 标注）。
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

// Credential/config display helper only; captured output is now stored verbatim.
// Do not use this helper in evidence sinks: masking there irreversibly changes Provider text.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic API key
  /\bsk-[A-Za-z0-9]{20,}/g, // OpenAI 等 sk- key
  /\bghp_[A-Za-z0-9]{36}\b/g, // GitHub PAT
  /\bgho_[A-Za-z0-9]{36}\b/g, // GitHub OAuth
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
  /\bnpm_[A-Za-z0-9]{30,}/g, // npm token
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, // Authorization: Bearer
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g // JWT
]

export function maskSecrets(s: string | undefined): string | undefined {
  if (!s) return s
  let out = s
  out = out.replace(
    /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|aws_secret_access_key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]*)/gi,
    '$1«REDACTED»'
  )
  out = out.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '«REDACTED PRIVATE KEY»')
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/gi, '$1«REDACTED»$2')
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«REDACTED»')
  return out
}
