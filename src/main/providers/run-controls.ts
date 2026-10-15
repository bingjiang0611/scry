import type { AgentEffortOption, AgentPermissionOption } from '../../shared/runtime'

const EFFORT_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultra: 'Ultra'
}

export function effortOption(id: string, description?: string, isDefault = false): AgentEffortOption {
  return {
    id,
    label: EFFORT_LABELS[id] ?? id,
    ...(description ? { description } : {}),
    ...(isDefault ? { isDefault: true } : {})
  }
}

/**
 * 生成某个 Provider **真正支持**的审批档位。
 *
 * 没有原生等价语义的档位不得出现在列表里，也不得被静默映射到别的档位：
 * 用户选了什么，跑的就必须是什么。
 */
export function permissionOptions(
  supported: { autoAcceptEdits?: boolean; autoReview?: boolean } = {}
): AgentPermissionOption[] {
  return [
    {
      id: 'default',
      label: '默认审批',
      description: '危险操作会暂停并请求你的确认'
    },
    ...(supported.autoAcceptEdits
      ? [{
          id: 'auto_accept_edits' as const,
          label: '自动接受编辑',
          description: '文件编辑直接放行；命令执行等其他操作仍然请求确认'
        }]
      : []),
    ...(supported.autoReview
      ? [{
          id: 'auto_review' as const,
          label: '自动审查',
          description: '由 Provider 的原生审查器判断是否放行'
        }]
      : []),
    {
      id: 'full_access',
      label: '完全访问',
      description: '跳过审批并允许 Agent 直接执行操作'
    }
  ]
}

/**
 * Provider 不支持某个审批档位时的统一拒绝。宁可显式失败，也不静默换成更宽或
 * 更窄的权限跑完一轮。
 */
export function unsupportedPermissionMode(provider: string, mode: string, detail: string): Error {
  return new Error(`${provider} 不支持“${mode}”权限模式：${detail}`)
}
