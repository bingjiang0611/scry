import type { AgentPermissionMode } from '../../shared/runtime'
import type { McpLiveStatus } from '../../shared/trace'
import type { ProviderRunRequest, ProviderRunResult } from './types'
import { record, usageNumber } from './codex-trace'
import { unsupportedPermissionMode } from './run-controls'

/**
 * Codex wire shapes and the small projections over them. The adapter and the run loop both need
 * these, so they live apart from either.
 */

export const CODEX_TOOL_ITEM_TYPES = ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'fileChange']


export interface CodexThreadResponse {
  thread: { id: string }
  model?: string
  modelProvider?: string
  serviceTier?: string | null
}


export interface CodexTurnResponse {
  turn: {
    id: string
    startedAt?: number | null
  }
}


export interface ThreadTokenUsage {
  total?: TokenUsage
  last?: TokenUsage
  modelContextWindow?: number
}



export interface TokenUsage {
  totalTokens?: number
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
}


export const tokenUsage = (value: unknown): TokenUsage => {
  const usage = record(value)
  return {
    totalTokens: usageNumber(usage.totalTokens),
    inputTokens: usageNumber(usage.inputTokens),
    cachedInputTokens: usageNumber(usage.cachedInputTokens),
    cacheWriteInputTokens: usageNumber(usage.cacheWriteInputTokens),
    outputTokens: usageNumber(usage.outputTokens),
    reasoningOutputTokens: usageNumber(usage.reasoningOutputTokens)
  }
}


export const subtractUsage = (current: TokenUsage, baseline: TokenUsage): TokenUsage => {
  const difference = (value: number | undefined, start: number | undefined): number | undefined => {
    if (value == null) return undefined
    if (start == null) return value
    // A session reset should not turn into a negative turn. In that case the current value is the best evidence.
    return value >= start ? value - start : value
  }
  return {
    totalTokens: difference(current.totalTokens, baseline.totalTokens),
    inputTokens: difference(current.inputTokens, baseline.inputTokens),
    cachedInputTokens: difference(current.cachedInputTokens, baseline.cachedInputTokens),
    cacheWriteInputTokens: difference(current.cacheWriteInputTokens, baseline.cacheWriteInputTokens),
    outputTokens: difference(current.outputTokens, baseline.outputTokens),
    reasoningOutputTokens: difference(current.reasoningOutputTokens, baseline.reasoningOutputTokens)
  }
}


export const hasPositiveUsage = (usage: TokenUsage): boolean =>
  Object.values(usage).some((value) => value != null && value > 0)


export const addUsage = (current: TokenUsage | undefined, delta: TokenUsage): TokenUsage => {
  const add = (left: number | undefined, right: number | undefined): number | undefined =>
    left == null && right == null ? undefined : (left ?? 0) + (right ?? 0)
  return {
    totalTokens: add(current?.totalTokens, delta.totalTokens),
    inputTokens: add(current?.inputTokens, delta.inputTokens),
    cachedInputTokens: add(current?.cachedInputTokens, delta.cachedInputTokens),
    cacheWriteInputTokens: add(current?.cacheWriteInputTokens, delta.cacheWriteInputTokens),
    outputTokens: add(current?.outputTokens, delta.outputTokens),
    reasoningOutputTokens: add(current?.reasoningOutputTokens, delta.reasoningOutputTokens)
  }
}


export const epochMilliseconds = (value: unknown): number | undefined => {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : undefined
  if (numeric == null || !Number.isFinite(numeric) || numeric < 0) return undefined
  return numeric < 100_000_000_000 ? numeric * 1_000 : numeric
}


export function canonicalTurnStatus(
  nativeStatus: unknown,
  stopped: boolean
): NonNullable<ProviderRunResult['status']> {
  if (nativeStatus === 'completed') return 'completed'
  if (nativeStatus === 'failed') return 'failed'
  if (nativeStatus === 'cancelled' || nativeStatus === 'canceled') return 'cancelled'
  if (nativeStatus === 'interrupted') return 'interrupted'
  if (stopped) return 'interrupted'
  return 'failed'
}


export function codexAccess(mode: AgentPermissionMode | undefined): {
  approvalPolicy: 'never' | 'on-request'
  approvalsReviewer?: 'user' | 'auto_review'
  sandbox: 'workspace-write' | 'danger-full-access'
} {
  if (mode === 'auto_accept_edits') {
    // Codex 的 workspace-write 沙箱本就让工作区内编辑免审批，与 default 完全同义；
    // 再提供一个同义档位只会让用户以为选到了不同的权限，所以显式拒绝而不是静默等同。
    throw unsupportedPermissionMode('Codex', '自动接受编辑', 'workspace-write 沙箱下的默认审批已经等价，Codex 没有独立的编辑放行档位')
  }
  if (mode === 'full_access') {
    return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
  }
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: mode === 'auto_review' ? 'auto_review' : 'user',
    sandbox: 'workspace-write'
  }
}


export const codexInput = (prompt: string, attachments: ProviderRunRequest['attachments']): unknown[] => {
  const input: unknown[] = []
  if (prompt) input.push({ type: 'text', text: prompt, text_elements: [] })
  for (const attachment of attachments) {
    if (attachment.path) input.push({ type: 'localImage', path: attachment.path })
    else input.push({ type: 'image', url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` })
  }
  return input
}


export const explicitSkillMention = (prompt: string): { name: string; text: string } | undefined => {
  const match = /^\s*[$/]([A-Za-z0-9_.:-]+)(?=\s|$)/.exec(prompt)
  return match ? { name: match[1], text: prompt.slice(match[0].length).trimStart() } : undefined
}


export function codexMcpStatus(value: unknown): McpLiveStatus[] {
  const data = Array.isArray(record(value).data) ? record(value).data as unknown[] : []
  return data.map((raw) => {
    const item = record(raw)
    const serverInfo = record(item.serverInfo)
    const tools = record(item.tools)
    return {
      name: String(item.name ?? ''),
      status: item.authStatus === 'notLoggedIn'
        ? 'needs-auth'
        : item.error
          ? 'failed'
          : item.serverInfo
            ? 'connected'
            : 'pending',
      serverName: typeof serverInfo.name === 'string' ? serverInfo.name : undefined,
      serverVersion: typeof serverInfo.version === 'string' ? serverInfo.version : undefined,
      tools: Object.keys(tools).length,
      toolNames: Object.keys(tools)
    }
  })
}

