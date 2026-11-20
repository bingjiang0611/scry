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
    description: '由 Antigravity 对文件写入和命令执行逐次询问；若用户全局 settings.json 抬高了权限，将拒绝启动'
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
  effectiveRank: PermissionRank
  effectiveLabel: string
  elevatedBy?: string
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
 * Inspect `~/.gemini/antigravity-cli/settings.json` (P7 D3).
 * Empirical A0 testing proved user-level `toolPermission` / `permissions.allow` bypass ACP approvals;
 * fail closed if the file grants higher effective permissions than the requested mode (or remote cap).
 */
export function inspectUserSettingsPermissionElevation(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): UserSettingsPermissionCheck {
  const settingsPath = join(antigravityGeminiRoot(homeDir, env), 'antigravity-cli', 'settings.json')
  if (!existsSync(settingsPath)) {
    return { settingsPath, effectiveRank: 0, effectiveLabel: 'default' }
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

  let effectiveRank: PermissionRank = 0
  let effectiveLabel = 'default'
  const reasons: string[] = []

  if (parsed.toolPermission !== undefined) {
    const tp = classifyToolPermissionSetting(parsed.toolPermission)
    if (tp.rank > effectiveRank) {
      effectiveRank = tp.rank
      effectiveLabel = tp.label
    }
    if (tp.detail) reasons.push(tp.detail)
  }

  const perms = parsed.permissions
  if (perms && typeof perms === 'object' && !Array.isArray(perms)) {
    const allow = (perms as Record<string, unknown>).allow
    if (Array.isArray(allow) && allow.length > 0) {
      if (effectiveRank < 2) {
        effectiveRank = 2
        effectiveLabel = 'permissions.allow'
      }
      reasons.push(`permissions.allow (${allow.length} rules)`)
    }
  }

  return {
    settingsPath,
    effectiveRank,
    effectiveLabel,
    ...(reasons.length ? { elevatedBy: reasons.join(', ') } : {})
  }
}

export function assertUserSettingsWithinRequestedMode(
  requested: AgentPermissionMode,
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): UserSettingsPermissionCheck {
  assertAntigravityPermissionMode(requested)
  const check = inspectUserSettingsPermissionElevation(homeDir, env)
  if (check.effectiveRank > MODE_RANK[requested]) {
    throw new Error(
      `已拒绝启动 Antigravity：用户配置 ${check.settingsPath} 中的权限设置（${check.elevatedBy ?? check.effectiveLabel}）高于当前所选或远程上限档位 "${requested}"。请调整该文件或切换到匹配的权限档位后重试。`
    )
  }
  return check
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
    .slice(0, 4) // `isQuestionPrompt` validates at most 4 options per prompt
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
