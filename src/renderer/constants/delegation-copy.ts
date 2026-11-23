import type { DelegatedTaskStatus } from '../../shared/delegation'

export const DELEGATION_COPY = {
  sidebarChildBadge: '由 Agent 启动',
  waitingSubtasks: (count: number) => `等待 ${count} 个子任务`,
  childReadOnlyNotice: '此子会话由 Agent 委派启动，为只读会话，不能在此发送消息；可查看轨迹、回答审批或停止运行。',
  openChildSession: '打开子会话',
  approveDelegate: '批准委派',
  declineDelegate: '拒绝委派',
  approveCancel: '批准取消',
  declineCancel: '拒绝取消',
  stopAllSubtasks: (count: number) => `停止全部子任务（${count}）`,
  stopRunWithChildren: (count: number) => `停止运行（含 ${count} 个子任务）`,
  confirmDelegateTitle: '确认委派子任务',
  confirmCancelTitle: '确认取消子任务',
  injectionRiskNotice: '子任务输出仅作为数据返回，不会直接替你审批；父 Agent 收到结果后仍以其自身权限档位继续行动。',
  summaryUnavailable: '摘要不可用',
  permissionSource: {
    inherited: '继承',
    requested: '显式请求'
  },
  qualityLabel: {
    exact: '精确',
    estimated: '估算',
    inferred: '推断',
    unavailable: '不可用',
    disabled: '已禁用'
  },
  statusLabel: {
    awaiting_confirmation: '等待确认',
    declined: '已拒绝',
    queued: '排队中',
    starting: '启动中',
    running: '运行中',
    waiting_interaction: '等待交互',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
    unavailable: '不可用'
  } satisfies Record<DelegatedTaskStatus, string>,
  switches: {
    projectTitle: '允许 Agent 委派子任务',
    projectDescription: '仅对当前项目生效；每次委派与取消仍需在 Scry 中由你确认。子任务结果回到父 Agent 后，父 Agent 仍以父权限档位行动。',
    fullAccessTitle: '允许子任务完全访问',
    fullAccessDescription: '仅对当前会话生效；开启后子任务才可继承或请求该 Provider 的完全访问权限，委派本身仍需每次确认。',
    remoteReadOnlyNotice: '这两个开关仅可在本机 App 中修改；远程端仅展示当前状态。',
    enableAction: '开启开关',
    disableAction: '关闭开关',
    enabledState: '已开启',
    disabledState: '已关闭'
  },
  usage: {
    heading: '含子任务用量（按单位与质量并列）',
    tokens: 'Token',
    usd: '美元',
    credits: 'Credits',
    unavailableChildren: (count: number) => `${count} 个子任务的用量不可用`,
    empty: '暂无子任务用量数据（不可用）'
  }
} as const
