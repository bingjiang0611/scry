import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sanitizeApprovalWarning,
  type AgentPermissionMode,
  type AgentPermissionOption,
  type AgentQuestionOption,
  type AgentQuestionRequest,
  type AgentQuestionResponse
} from '../../shared/runtime'
import { antigravityGeminiRoot } from './antigravity-mcp-paths'

/**
 * Native Antigravity permission catalog (P7 D2, D9, §5.5).
 * Strictly exposes only the 3 natively supported modes; `auto_review` is never fabricated.
 */
export const ANTIGRAVITY_PERMISSION_OPTIONS: readonly AgentPermissionOption[] = [
  {
    id: 'default',
    label: '默认审批',
    description: '由 Antigravity 对文件写入和命令执行逐次询问；全局整体提权将拒绝启动，用户级具体命令放行规则会在记录与界面标明。每轮结束时后台子 Agent 与 /goal 会随进程终止。'
  },
  {
    id: 'auto_accept_edits',
    label: '自动放行文件编辑',
    description: '映射为 Antigravity 原生 accept-edits 模式，自动放行文件写入，仍询问命令执行'
  },
  {
    id: 'full_access',
    label: '完全访问',
    description: '让 Antigravity 不经询问执行工具（等同 agy acp --dangerously-skip-permissions）。这是本机用户权限，不是沙箱；Antigravity 自己的 deny 规则仍生效；提问仍需你回答。仓库里的 Hook、插件与 MCP 仍须通过指纹检查。'
  }
]

export const SUPPORTED_ANTIGRAVITY_PERMISSION_MODES: ReadonlySet<AgentPermissionMode> = new Set([
  'default',
  'auto_accept_edits',
  'full_access'
])

export function assertAntigravityPermissionMode(mode: AgentPermissionMode): void {
  if (!SUPPORTED_ANTIGRAVITY_PERMISSION_MODES.has(mode)) {
    throw new Error(`unsupportedPermissionMode: Antigravity 不支持权限档位 "${mode}"（仅支持 default / auto_accept_edits / full_access）`)
  }
}

export function antigravityNativeModeFor(mode: AgentPermissionMode): 'default' | 'accept-edits' | null {
  if (mode === 'default') return 'default'
  if (mode === 'auto_accept_edits') return 'accept-edits'
  if (mode === 'full_access') return null // passed via CLI flag --dangerously-skip-permissions
  assertAntigravityPermissionMode(mode)
  return null
}

type PermissionRank = 0 | 1 | 2 | 3

const MODE_RANK: Record<AgentPermissionMode, PermissionRank> = {
  default: 0,
  auto_accept_edits: 1,
  auto_review: 2,
  full_access: 3
}

export interface UserSettingsPermissionCheck {
  settingsPath: string
  /** Broad/global elevation rank (e.g. `toolPermission` or wildcard-all allow rule). */
  broadRank: PermissionRank
  broadLabel: string
  /** Back-compat alias equal to `broadRank`. */
  effectiveRank: PermissionRank
  effectiveLabel: string
  /** Specific command/tool `permissions.allow` rules that do NOT block startup (D11). */
  allowRules: string[]
  elevatedBy?: string
}

export interface EffectiveAntigravityPermissions extends UserSettingsPermissionCheck {
  /** Higher of requested mode and broad global setting, annotated `+ 用户规则` when specific rules apply (S8/D11). */
  effectivePermissionMode: string
  userAllowNotice?: string
}

function isWildcardAllowRule(rule: string): boolean {
  const normalized = rule.trim().toLowerCase()
  return normalized === '*' ||
    normalized === 'all' ||
    normalized === 'command(*)' ||
    normalized === 'tool(*)' ||
    normalized === 'shell(*)' ||
    normalized === 'bash(*)' ||
    normalized === 'write(*)'
}

function classifyToolPermissionSetting(raw: unknown): { rank: PermissionRank; label: string; detail?: string } {
  if (typeof raw !== 'string') return { rank: 0, label: 'default' }
  const v = raw.trim().toLowerCase()
  if (!v || v === 'default' || v === 'ask' || v === 'prompt' || v === 'plan') {
    return { rank: 0, label: 'default' }
  }
  if (v === 'accept-edits' || v === 'accept_edits' || v === 'acceptedits') {
    return { rank: 1, label: 'auto_accept_edits', detail: `toolPermission=${raw}` }
  }
  if (v === 'auto') {
    return { rank: 2, label: 'auto', detail: `toolPermission=${raw}` }
  }
  if (v === 'yolo' || v === 'bypass' || v === 'allow' || v === 'allow_all' || v === 'dangerously-skip-permissions') {
    return { rank: 3, label: 'full_access', detail: `toolPermission=${raw}` }
  }
  // Conservative: unrecognized non-default toolPermission value is treated as elevated.
  return { rank: 2, label: `custom(${raw})`, detail: `toolPermission=${raw}` }
}

/**
 * Inspect `~/.gemini/antigravity-cli/settings.json` using the **sanitized** launch env (B1, D3, D11).
 * - Broad elevation (`toolPermission` or wildcard allow rules) wider than requested mode refuses startup.
 * - Specific `permissions.allow` command rules allow startup normally, and are surfaced honestly as
 *   `agy 用户级规则会自动放行：…` with effective permission `<mode> + 用户规则`.
 */
export function inspectUserSettingsPermissionElevation(
  homeDir: string,
  sanitizedEnv: NodeJS.ProcessEnv = {}
): UserSettingsPermissionCheck {
  const settingsPath = join(antigravityGeminiRoot(homeDir, sanitizedEnv), 'antigravity-cli', 'settings.json')
  if (!existsSync(settingsPath)) {
    return { settingsPath, broadRank: 0, broadLabel: 'default', effectiveRank: 0, effectiveLabel: 'default', allowRules: [] }
  }
  let parsed: Record<string, unknown>
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('root must be a JSON object')
    }
    parsed = raw as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `无法解析 Antigravity 用户配置 ${settingsPath}（fail closed）：${error instanceof Error ? error.message : String(error)}`
    )
  }

  let broadRank: PermissionRank = 0
  let broadLabel = 'default'
  const reasons: string[] = []
  const allowRules: string[] = []

  if (parsed.toolPermission !== undefined) {
    const tp = classifyToolPermissionSetting(parsed.toolPermission)
    if (tp.rank > broadRank) {
      broadRank = tp.rank
      broadLabel = tp.label
    }
    if (tp.detail) reasons.push(tp.detail)
  }

  const perms = parsed.permissions
  if (perms && typeof perms === 'object' && !Array.isArray(perms)) {
    const allow = (perms as Record<string, unknown>).allow
    if (Array.isArray(allow)) {
      const wildcardRules: string[] = []
      for (const entry of allow) {
        if (typeof entry !== 'string') continue
        const trimmed = entry.trim()
        if (!trimmed) continue
        if (isWildcardAllowRule(trimmed)) wildcardRules.push(trimmed)
        else allowRules.push(trimmed)
      }
      if (wildcardRules.length > 0) {
        if (broadRank < 3) {
          broadRank = 3
          broadLabel = 'full_access'
        }
        reasons.push(`permissions.allow wildcard (${wildcardRules.join(', ')})`)
      }
    }
  }

  return {
    settingsPath,
    broadRank,
    broadLabel,
    effectiveRank: broadRank,
    effectiveLabel: broadLabel,
    allowRules,
    ...(reasons.length ? { elevatedBy: reasons.join(', ') } : {})
  }
}

export function formatUserAllowNotice(allowRules: readonly string[]): string | undefined {
  if (allowRules.length === 0) return undefined
  const preview = allowRules.slice(0, 6).join('、')
  const suffix = allowRules.length > 6 ? ` 等 ${allowRules.length} 条` : ''
  return `agy 用户级规则会自动放行：${preview}${suffix}`
}

export function assertUserSettingsWithinRequestedMode(
  requested: AgentPermissionMode,
  homeDir: string,
  sanitizedEnv: NodeJS.ProcessEnv = {}
): EffectiveAntigravityPermissions {
  assertAntigravityPermissionMode(requested)
  const check = inspectUserSettingsPermissionElevation(homeDir, sanitizedEnv)
  const requestedRank = MODE_RANK[requested]
  if (check.broadRank > requestedRank) {
    throw new Error(
      `已拒绝启动 Antigravity：用户配置 ${check.settingsPath} 中的整体权限设置（${check.elevatedBy ?? check.broadLabel}）高于当前所选或远程上限档位 "${requested}"。请调整该文件或切换到匹配的权限档位后重试。`
    )
  }
  // S8: take the higher of requested mode and broad setting; D11: annotate specific user allow rules.
  const baseMode = check.broadRank > requestedRank ? check.broadLabel : requested
  const effectivePermissionMode = check.allowRules.length > 0 ? `${baseMode} + 用户规则` : baseMode
  const userAllowNotice = formatUserAllowNotice(check.allowRules)
  return {
    ...check,
    effectivePermissionMode,
    ...(userAllowNotice ? { userAllowNotice } : {})
  }
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind?: string
}

export interface AcpPermissionRequestParams {
  sessionId?: string
  toolCall?: {
    toolCallId?: string
    title?: string
    kind?: string
    rawInput?: unknown
    locations?: Array<{ path?: string; line?: number }>
  }
  options?: AcpPermissionOption[]
  _meta?: Record<string, unknown>
}

export function isAntigravityInteractionQuestion(params: AcpPermissionRequestParams): boolean {
  const toolCallId = params.toolCall?.toolCallId
  return typeof toolCallId === 'string' && toolCallId.startsWith('interaction_')
}

/**
 * Convert ACP `session/request_permission` into Scry `AgentQuestionRequest`.
 * Preserves EVERY option from `agy` verbatim (`name` + `kind`), never deduplicating by `kind` (P7 §3).
 */
export function buildAntigravityQuestionRequest(args: {
  runId: string
  questionId: string
  params: AcpPermissionRequestParams
}): { request: AgentQuestionRequest; optionIdByAnswer: Map<string, string> } {
  const isQuestion = isAntigravityInteractionQuestion(args.params)
  const toolCall = args.params.toolCall ?? {}
  const title = typeof toolCall.title === 'string' && toolCall.title.trim()
    ? toolCall.title.trim()
    : isQuestion ? 'Antigravity 提问' : 'Antigravity 权限请求'
  const rawOptions = Array.isArray(args.params.options) ? args.params.options : []
  const usedLabels = new Set<string>()
  const optionIdByAnswer = new Map<string, string>()

  const options: AgentQuestionOption[] = rawOptions
    .filter((opt): opt is AcpPermissionOption => Boolean(opt && typeof opt.optionId === 'string' && opt.optionId))
    .map((opt, index) => {
      const baseLabel = (typeof opt.name === 'string' && opt.name.trim() ? opt.name.trim() : opt.optionId).slice(0, 220)
      let label = baseLabel
      if (usedLabels.has(label)) label = `${baseLabel} (${opt.kind ?? index + 1})`
      let suffix = 2
      while (usedLabels.has(label)) label = `${baseLabel} #${suffix++}`
      usedLabels.add(label)
      optionIdByAnswer.set(opt.optionId, opt.optionId)
      optionIdByAnswer.set(label, opt.optionId)
      return {
        label,
        description: opt.kind ? `Antigravity 选项（${opt.kind}）` : 'Antigravity 选项',
        answerValue: opt.optionId
      }
    })

  const warningRaw = args.params._meta?.['agy.security.warning']
  const warning = sanitizeApprovalWarning(warningRaw)

  let questionText = title
  if (!isQuestion && toolCall.rawInput !== undefined) {
    const preview = typeof toolCall.rawInput === 'string'
      ? toolCall.rawInput
      : JSON.stringify(toolCall.rawInput)
    if (preview && preview !== '{}' && preview.length <= 1400) {
      questionText = `${title}\n${preview}`
    }
  }
  if (questionText.length > 1950) questionText = `${questionText.slice(0, 1947)}...`

  return {
    request: {
      runId: args.runId,
      questionId: args.questionId,
      providerId: 'antigravity',
      questionKind: isQuestion ? 'clarification' : 'permission',
      source: isQuestion ? 'antigravity_interaction' : 'antigravity_acp_permission',
      questions: [{
        header: isQuestion ? 'Antigravity 提问' : 'Antigravity 审批',
        question: questionText,
        multiSelect: false,
        allowCustomAnswer: false,
        ...(warning ? { warning } : {}),
        options
      }]
    },
    optionIdByAnswer
  }
}

export function resolveAntigravityPermissionOutcome(
  request: AgentQuestionRequest,
  response: AgentQuestionResponse | undefined,
  optionIdByAnswer: ReadonlyMap<string, string>
): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  if (!response || response.behavior !== 'answered') {
    return { outcome: { outcome: 'cancelled' } }
  }
  const questionText = request.questions[0]?.question ?? ''
  const rawAnswer = response.answers[questionText]
  const optionId = typeof rawAnswer === 'string' ? optionIdByAnswer.get(rawAnswer) : undefined
  if (!optionId) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId } }
}
