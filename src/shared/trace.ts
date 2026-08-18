import type {
  AgentInputAttachment,
  AgentIntervention,
  AgentQuestionRequest,
  RunTerminationReason,
  RuntimeFailureStage,
  RuntimeProvider
} from './runtime.js'
import type { ProviderId } from './provider.js'
import type { BillingProvider } from './billing.js'

// 统一 trace 事件模型 —— 所有 Provider 共享 kind/baggage/stage 设计，
// 让 SDK stream 和未来 codex adapter 都归一化到同一格式（一份数据多处用）。

export type TraceKind = 'tool' | 'skill' | 'agent' | 'human' | 'model' | 'harness' | 'hook'
export type FileOp = 'read' | 'write' | 'edit'
export type CostSource =
  | 'sdk_estimate'
  | 'gateway_reported'
  | 'provider_reported'
  | 'provider_bill'
  | 'official_telemetry'
  | 'analytics_report'
  | 'price_table'
  | 'user_override'
export type CostConfidence = 'exact' | 'provider_reported' | 'estimated' | 'inferred'
export type CostUnit = 'usd' | 'credits' | 'token' | 'custom'

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
  cwd?: string
  externalSessionId?: string
  userText: string
  attachments?: AgentInputAttachment[]
  pendingQuestions?: AgentQuestionRequest[]
  items: TraceEvent[]
  done: boolean
  providerSettled?: boolean
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
  status: 'connected' | 'failed' | 'needs-auth' | 'needs-client-registration' | 'pending' | 'disabled'
  serverName?: string
  serverVersion?: string
  tools?: number
}

// P2 Diagnostics（RFC §8.6）：排查 app 自己 + claude 环境。
export interface Diagnostics {
  claudeVersion?: string // 驱动会话的 claude 二进制版本（来自最近一次会话 init）
  sdkVersion: string // scry 声明的 SDK 依赖版本
  settingSources: string // app 当前给 query() 的 settingSources（默认不加载文件系统设置）
}

// P2 Files & Diff（RFC §8.4）：最终 git diff 的每文件增删（绝对路径），与工具足迹对照。
export interface DiffFile {
  path: string
  added: number
  deleted: number
  binary?: boolean
  patch?: string
  patchStatus?: TurnDiffPatchStatus
  patchReason?: TurnDiffPatchReason
}

export type TurnDiffStatus = 'captured' | 'unavailable' | 'timeout' | 'failed'
export type TurnDiffReason = 'not_git' | 'no_head' | 'deadline' | 'git_error'

// Diff 快照的四个 harness stage。`*_preview` 是运行中的临时快照（同一 Git capture 的非消费式重算），
// 终态 `turn_diff` / `session_diff` 一到达就在展示上取代它，且不写入会话 archive。
export const TURN_DIFF_STAGE = 'turn_diff'
export const SESSION_DIFF_STAGE = 'session_diff'
export const TURN_DIFF_PREVIEW_STAGE = 'turn_diff_preview'
export const SESSION_DIFF_PREVIEW_STAGE = 'session_diff_preview'

export function isDiffSnapshotStage(stage: string): boolean {
  return (
    stage === TURN_DIFF_STAGE ||
    stage === SESSION_DIFF_STAGE ||
    stage === TURN_DIFF_PREVIEW_STAGE ||
    stage === SESSION_DIFF_PREVIEW_STAGE
  )
}

export function isDiffPreviewStage(stage: string): boolean {
  return stage === TURN_DIFF_PREVIEW_STAGE || stage === SESSION_DIFF_PREVIEW_STAGE
}

/**
 * Hook 生命周期投递 stage。Provider 只把 hook 事件投递给外部 hook 进程（Codex 终端会话就是这样），
 * 不暴露被执行脚本的 command / exit code / outcome 时，recorder 只能证明「该 hook 事件确实触发过」。
 * 这类事件不得与 `hook_started` / `hook_response`（带脚本身份的真实 hook 运行）混为一谈。
 */
export const HOOK_DELIVERY_STAGE = 'hook_delivery'

/**
 * 会话净 diff 的基线来源：`session_start` = 会话第一轮开始前捕获的原始基线；
 * `resumed` = 该基线在本进程内不存在（恢复/选择会话/重启后）而当场重锚，
 * 净 diff 只覆盖「自重锚以来」，UI 必须照实说明，不得冒充整段会话。
 */
export type TurnDiffBaselineOrigin = 'session_start' | 'resumed'
export type TurnDiffPatchStatus = 'captured' | 'truncated' | 'binary' | 'unavailable'
export type TurnDiffPatchReason = 'deadline' | 'git_error' | 'budget'
export type TurnDiffFallbackReason = 'forced' | 'discovery_failed' | 'candidate_limit' | 'git_semantics' | 'targeted_failed'

export interface TurnDiffCollection {
  strategy: 'targeted' | 'full_fallback'
  evidence: 'git_status' | 'git_status+structured' | 'fallback'
  candidatePathCount: number
  discoveryMs: number
  targetedMs?: number
  fallbackMs?: number
  fallbackReason?: TurnDiffFallbackReason
}

export interface TurnDiffSnapshot {
  version: 1
  status: TurnDiffStatus
  reason?: TurnDiffReason
  files: DiffFile[]
  repoRoot?: string
  scope?: string
  beforeAt: string
  afterAt: string
  captureMs: number
  cleanup: 'ok' | 'failed'
  collection?: TurnDiffCollection
  /** 仅 session_diff / session_diff_preview 携带：净 diff 的基线是会话首轮前还是恢复后重锚。 */
  baseline?: TurnDiffBaselineOrigin
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

export function normalizeTurnDiffSnapshot(value: unknown): TurnDiffSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) return undefined
  if (!['captured', 'unavailable', 'timeout', 'failed'].includes(String(raw.status))) return undefined
  if (!Array.isArray(raw.files) || typeof raw.beforeAt !== 'string' || typeof raw.afterAt !== 'string') return undefined
  const captureMs = nonNegativeInteger(raw.captureMs)
  if (captureMs == null || (raw.cleanup !== 'ok' && raw.cleanup !== 'failed')) return undefined
  const files = raw.files.flatMap((entry): DiffFile[] => {
    if (!entry || typeof entry !== 'object') return []
    const file = entry as Record<string, unknown>
    const added = nonNegativeInteger(file.added)
    const deleted = nonNegativeInteger(file.deleted)
    if (typeof file.path !== 'string' || !file.path || added == null || deleted == null) return []
    const binary = file.binary === true
    const patch = typeof file.patch === 'string' && file.patch.length > 0 && file.patch.length <= 1_100_000 ? file.patch : undefined
    const patchStatus = ['captured', 'truncated', 'binary', 'unavailable'].includes(String(file.patchStatus))
      ? (file.patchStatus as TurnDiffPatchStatus)
      : undefined
    const patchReason = ['deadline', 'git_error', 'budget'].includes(String(file.patchReason))
      ? (file.patchReason as TurnDiffPatchReason)
      : undefined
    const patchFields =
      (patchStatus === 'captured' || patchStatus === 'truncated') && patch
        ? { patch, patchStatus }
        : patchStatus === 'binary' && binary
          ? { patchStatus }
          : patchStatus === 'unavailable' && patchReason
            ? { patchStatus, patchReason }
            : {}
    return [{ path: file.path, added, deleted, ...(binary ? { binary: true } : {}), ...patchFields }]
  })
  const reason = ['not_git', 'no_head', 'deadline', 'git_error'].includes(String(raw.reason))
    ? (raw.reason as TurnDiffReason)
    : undefined
  const collectionRaw = raw.collection && typeof raw.collection === 'object'
    ? raw.collection as Record<string, unknown>
    : undefined
  const candidatePathCount = nonNegativeInteger(collectionRaw?.candidatePathCount)
  const discoveryMs = nonNegativeInteger(collectionRaw?.discoveryMs)
  const targetedMs = nonNegativeInteger(collectionRaw?.targetedMs)
  const fallbackMs = nonNegativeInteger(collectionRaw?.fallbackMs)
  const fallbackReason = ['forced', 'discovery_failed', 'candidate_limit', 'git_semantics', 'targeted_failed']
    .includes(String(collectionRaw?.fallbackReason))
    ? collectionRaw?.fallbackReason as TurnDiffFallbackReason
    : undefined
  const collectionShapeValid =
    (collectionRaw?.strategy === 'targeted' &&
      (collectionRaw.evidence === 'git_status' || collectionRaw.evidence === 'git_status+structured') &&
      fallbackReason == null) ||
    (collectionRaw?.strategy === 'full_fallback' &&
      collectionRaw.evidence === 'fallback' &&
      fallbackReason != null)
  const collection =
    collectionRaw &&
    collectionShapeValid &&
    candidatePathCount != null &&
    discoveryMs != null
      ? {
          strategy: collectionRaw.strategy as TurnDiffCollection['strategy'],
          evidence: collectionRaw.evidence as TurnDiffCollection['evidence'],
          candidatePathCount,
          discoveryMs,
          ...(targetedMs != null ? { targetedMs } : {}),
          ...(fallbackMs != null ? { fallbackMs } : {}),
          ...(fallbackReason ? { fallbackReason } : {})
        }
      : undefined
  const baseline = raw.baseline === 'session_start' || raw.baseline === 'resumed'
    ? (raw.baseline as TurnDiffBaselineOrigin)
    : undefined
  return {
    version: 1,
    status: raw.status as TurnDiffStatus,
    ...(reason ? { reason } : {}),
    files,
    ...(typeof raw.repoRoot === 'string' ? { repoRoot: raw.repoRoot } : {}),
    ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
    beforeAt: raw.beforeAt,
    afterAt: raw.afterAt,
    captureMs,
    cleanup: raw.cleanup,
    ...(collection ? { collection } : {}),
    ...(baseline ? { baseline } : {})
  }
}

// P0：result 的 per-model 用量明细（SDK result.modelUsage 展开，落 model_usage 子表）。
export interface ModelUsageRow {
  model: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
  reasoningTokens?: number
  costUsd?: number
  costSource?: CostSource
  costConfidence?: CostConfidence
  costUnit?: CostUnit
  contextWindow?: number
  billingProvider?: BillingProvider
  upstreamProvider?: string
  accountLabel?: string
  usageSource?: string
}

// B2/P0/P2：sqlite 跨会话分析结果（从 spans/model_usage 聚合），跨 main/preload/renderer 共用。
export interface DbStats {
  status?: 'ready' | 'unavailable' | 'query_error'
  totals: { cost: number | null; tin: number | null; tout: number | null; turns: number; toolCalls?: number; dangerEvents?: number }
  topTools: { tool: string; n: number; mcp: number }[]
  byCwd: { cwd: string; cost: number | null; turns: number }[]
  byModel: { model: string; tin: number | null; tout: number | null; cost: number | null }[]
  // P2 Analytics：工具耗时（墙钟推算）+ 成功率。avgMs 来自 tool_use→tool_result 墙钟差，errors=失败次数。
  toolStats: { tool: string; n: number; avgMs: number; errors: number }[]
  // P3 跨会话危险审计趋势：哪些危险操作最频繁（从 spans.danger_* 聚合）。
  dangerTrend: { reason: string; level: string; n: number }[]
  // Analytics v7：字段可选以兼容 dev/HMR 中旧 preload；main 的当前实现始终返回完整形状。
  tokenDaily?: {
    day: string
    input: number | null
    output: number | null
    cacheRead: number | null
    cacheWrite: number | null
    turns: number
    inputKnownTurns: number
    outputKnownTurns: number
    cacheReadKnownTurns: number
    cacheWriteKnownTurns: number
  }[]
  dangerDaily?: { day: string; danger: number; warn: number }[]
  comparison?: {
    current: { tokens: number | null; tokenKnownTurns: number; turns: number; toolCalls: number; danger: number }
    previous: { tokens: number | null; tokenKnownTurns: number; turns: number; toolCalls: number; danger: number }
    change: { tokensPct: number | null; turnsPct: number | null; toolCallsPct: number | null; dangerPct: number | null }
  }
  cacheReuse?: {
    providerId: ProviderId
    turns: number
    inputTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    inputKnownTurns: number
    cacheReadKnownTurns: number
    cacheWriteKnownTurns: number
    comparableTurns: number
    reuseRate: number | null
    denominator: 'separate_input' | 'input_includes_cache' | 'upstream_dependent' | 'unknown'
  }[]
  mcpLatency?: { server: string; calls: number; p50Ms: number | null; p95Ms: number | null; errors: number }[]
  providerCoverage?: {
    providerId: ProviderId
    turns: number
    inputKnownTurns: number
    outputKnownTurns: number
    cacheReadKnownTurns: number
    cacheWriteKnownTurns: number
    dangerCoverage: 'classified' | 'unsupported'
  }[]
  interventions?: {
    requested: number
    total: number
    answered: number
    cancelled: number
    questions: number
    clarification: number
    permission: number
    waitMs: number
  }
}

export interface UsageStats {
  status: 'ready' | 'partial' | 'unavailable' | 'query_error'
  cost: number | null
  tin: number | null
  tout: number | null
  turns: number
  invalidLines: number
  sourceBytes?: number
  error?: string
}

export type CompactionTrigger = 'auto' | 'manual'

export interface ContextCompaction {
  trigger?: CompactionTrigger
  preTokens?: number
  postTokens?: number
  providerEventId?: string
}

export interface TraceEvent {
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
  contextTokens?: number // 仅 result：最后一次模型调用的完整 prompt（顶层 usage 的 input+cache_read+cache_creation）= 当前上下文占用，÷contextWindow 得 Context%
  modelUsage?: ModelUsageRow[] // 仅 result：per-model 明细
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
  runtimeMetadata?: Record<string, unknown>
  intervention?: AgentIntervention
  compaction?: ContextCompaction
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

// 文件足迹：只有结构化文件工具带 file_path。
// Glob/Grep 是 pattern/path 不算「读写」，Bash/MCP 的文件操作此处统计不到（已知盲区，UI 标注）。
const FILE_OP_TOOLS: Record<string, FileOp> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit'
}

export function fileOpOf(
  toolName: string,
  input?: Record<string, unknown>
): { fileOp?: FileOp; filePath?: string } {
  const op = FILE_OP_TOOLS[toolName]
  if (!op) return {}
  const fp = input?.file_path as string | undefined
  if (!fp) return {}
  return { fileOp: op, filePath: fp }
}

// 落库前脱敏（RFC §11）：本地 .db 会被 Time Machine 备份/被其他工具直接读，UI 折叠挡不住。
// 锚 token 形状、不用裸前缀——裸前缀误伤正常串，而"只存 mask 后版本"过度匹配=真值永久丢。
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic API key
  /\bsk-[A-Za-z0-9]{20,}/g, // OpenAI 等 sk- key
  /\bghp_[A-Za-z0-9]{36}\b/g, // GitHub PAT
  /\bgho_[A-Za-z0-9]{36}\b/g, // GitHub OAuth
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, // Authorization: Bearer
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g // JWT
]

export function maskSecrets(s: string | undefined): string | undefined {
  if (!s) return s
  let out = s
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«REDACTED»')
  return out
}
