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

export function permissionOptions(includeAutoReview = true): AgentPermissionOption[] {
  return [
    {
      id: 'default',
      label: '默认审批',
      description: '危险操作会暂停并请求你的确认'
    },
    ...(includeAutoReview
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
