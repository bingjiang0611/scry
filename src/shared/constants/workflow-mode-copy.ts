/**
 * User-facing copy for the conversation-scoped workflow mode. Kept in its own
 * module so the large shared copy dictionaries stay under the authored size cap.
 *
 * Both recognition modes use one routing call per new message, gated by the
 * conversation's durable disclosure. Manual only accepts explicit workflow intent.
 */
export const WORKFLOW_MODE_COPY = {
  label: '工作流模式',
  messageLabel: '本次发送',
  messageHint: '仅本次，不更改会话模式；显式命令优先。工作流先打开配置，不会自动执行。',
  messageValues: {
    default: '沿用会话模式',
    direct: '本次直接回答',
    workflow: '本次工作流'
  },
  values: {
    off: '关闭（不识别，默认）',
    manual: '手动（识别明确请求，每条消息一次路由）',
    auto: '自动（每条新消息一次路由调用）'
  },
  updated: (mode: 'off' | 'manual' | 'auto') => `工作流模式已切换为：${WORKFLOW_MODE_COPY.values[mode]}`,
  /** Stored verbatim with the grant so later copy edits cannot widen it. */
  consentScope: '每次新消息会把该消息、当前工作区路径和编排角色发送给你选择的编排 Provider，并产生一次额外的路由调用；费用按该 Provider 的现行价格计算。',
  consentRequired: '工作流识别需要先确认数据范围与额外调用费用',
  confirmMode: (mode: 'manual' | 'auto') => mode === 'manual' ? '确认启用手动识别' : '确认启用自动',
  cancel: '取消',
  granted: (scope: string) => `已授权识别：${scope}`,
  manualLimit: '每条新消息由编排模型识别明确的工作流请求；普通任务仍走普通路径，不因复杂就升级',
  unchanged: '工作流模式未变化',
  invalid: '工作流模式无效：仅支持 off、manual、auto'
} as const
