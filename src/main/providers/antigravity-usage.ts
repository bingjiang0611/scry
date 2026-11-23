import type { TraceEvent } from '../../shared/trace'

export interface AcpPromptUsage {
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  thoughtTokens?: number
  totalTokens?: number
}

export interface AcpContextUsage {
  used?: number
  size?: number
}

export type AntigravityUsageCoverage = 'available' | 'partial' | 'unavailable'

export interface AntigravityResultUsageFields {
  tokensIn?: number
  tokensOut?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  costUsd?: undefined
  usageSource: 'antigravity_acp'
  billingProvider: 'antigravity'
  contextTokens?: number
  contextUsageSource?: 'antigravity_usage_update'
  contextUsageQuality?: 'exact'
  usageCoverage: AntigravityUsageCoverage
  usageCoverageReason?: string
  modelStatus: 'unobserved'
  modelOmissionReason: string
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function buildAntigravityUsageFields(args: {
  usage?: AcpPromptUsage | null
  contextUsage?: AcpContextUsage | null
  cancelled: boolean
  failed: boolean
  hasSubagentTool: boolean
}): AntigravityResultUsageFields {
  const raw = args.usage && typeof args.usage === 'object' ? args.usage : undefined
  const tokensIn = finiteNonNeg(raw?.inputTokens)
  const tokensOut = finiteNonNeg(raw?.outputTokens)
  const cacheReadTokens = finiteNonNeg(raw?.cachedReadTokens)
  const cacheCreationTokens = finiteNonNeg(raw?.cachedWriteTokens)
  const reasoningTokens = finiteNonNeg(raw?.thoughtTokens)
  const hasAnyTokens =
    tokensIn !== undefined ||
    tokensOut !== undefined ||
    cacheReadTokens !== undefined ||
    cacheCreationTokens !== undefined ||
    reasoningTokens !== undefined

  let usageCoverage: AntigravityUsageCoverage = 'available'
  let usageCoverageReason: string | undefined
  if (!hasAnyTokens) {
    usageCoverage = 'unavailable'
    usageCoverageReason = 'Antigravity ACP PromptResponse 未返回 usage 字段'
  } else if (args.hasSubagentTool) {
    usageCoverage = 'partial'
    usageCoverageReason = '本轮包含 invoke_subagent 子 Agent 调用，Antigravity ACP 不单列子 Agent 用量'
  } else if (args.cancelled) {
    usageCoverage = 'partial'
    usageCoverageReason = '本轮已取消，Antigravity 返回的用量可能不完整'
  } else if (args.failed) {
    usageCoverage = 'partial'
    usageCoverageReason = '本轮执行失败，Antigravity 返回的用量可能不完整'
  }

  const contextTokens = finiteNonNeg(args.contextUsage?.used)

  return {
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    costUsd: undefined,
    usageSource: 'antigravity_acp',
    billingProvider: 'antigravity',
    ...(contextTokens !== undefined ? {
      contextTokens,
      contextUsageSource: 'antigravity_usage_update' as const,
      contextUsageQuality: 'exact' as const
    } : {}),
    usageCoverage,
    ...(usageCoverageReason ? { usageCoverageReason } : {}),
    modelStatus: 'unobserved',
    modelOmissionReason: 'Antigravity ACP PromptResponse 不上报实际应答模型'
  }
}

export function buildAntigravityResultEvent(args: {
  runId: string
  durationMs: number
  isError: boolean
  stopReason?: string
  cancelRequestedBeforeEndTurn?: boolean
  effectivePermissionMode?: string
  userAllowRules?: readonly string[]
  userAllowNotice?: string
  usage?: AcpPromptUsage | null
  contextUsage?: AcpContextUsage | null
  cancelled: boolean
  failed: boolean
  hasSubagentTool: boolean
  nonJsonLineCount: number
  ts?: string
}): TraceEvent {
  const u = buildAntigravityUsageFields({
    usage: args.usage,
    contextUsage: args.contextUsage,
    cancelled: args.cancelled,
    failed: args.failed,
    hasSubagentTool: args.hasSubagentTool
  })
  return {
    id: `${args.runId}:result`,
    runId: args.runId,
    ts: args.ts ?? new Date().toISOString(),
    kind: 'harness',
    stage: 'result',
    isError: args.isError,
    durationMs: Math.max(0, Math.round(args.durationMs)),
    ...(u.tokensIn !== undefined ? { tokensIn: u.tokensIn } : {}),
    ...(u.tokensOut !== undefined ? { tokensOut: u.tokensOut } : {}),
    ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
    ...(u.cacheCreationTokens !== undefined ? { cacheCreationTokens: u.cacheCreationTokens } : {}),
    ...(u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {}),
    usageSource: u.usageSource,
    billingProvider: u.billingProvider,
    ...(u.contextTokens !== undefined ? {
      contextTokens: u.contextTokens,
      contextUsageSource: u.contextUsageSource,
      contextUsageQuality: u.contextUsageQuality
    } : {}),
    runtimeMetadata: {
      source: 'antigravity_acp',
      ...(args.stopReason ? { stopReason: args.stopReason } : {}),
      ...(args.cancelRequestedBeforeEndTurn ? { cancelRequestedBeforeEndTurn: true } : {}),
      ...(args.effectivePermissionMode ? { effectivePermissionMode: args.effectivePermissionMode } : {}),
      ...(args.userAllowRules && args.userAllowRules.length > 0 ? { userAllowRules: [...args.userAllowRules] } : {}),
      ...(args.userAllowNotice ? { userAllowNotice: args.userAllowNotice } : {}),
      ...(args.contextUsage?.size !== undefined ? { contextWindow: args.contextUsage.size } : {}),
      usageCoverage: u.usageCoverage,
      ...(u.usageCoverageReason ? { usageCoverageReason: u.usageCoverageReason } : {}),
      modelStatus: u.modelStatus,
      modelOmissionReason: u.modelOmissionReason,
      ...(args.nonJsonLineCount > 0 ? { nonJsonStdoutLines: args.nonJsonLineCount } : {})
    }
  }
}
