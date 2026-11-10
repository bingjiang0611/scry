import type { WorkflowAgentStatus, WorkflowRun, WorkflowRunStatus, WorkflowStatusSource } from '../workflow-runs'

export const WORKFLOW_RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  launching: '启动中',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  unknown: '状态未知'
}

// Where the status came from is part of the claim; it is shown as the chip's tooltip.
export const WORKFLOW_STATUS_EVIDENCE: Record<WorkflowStatusSource, string> = {
  tool_use: '只观测到 Workflow 工具调用，尚未收到后台任务事件',
  launch_error: '来自失败的 Workflow tool_result',
  task_started: '来自 Claude Code 的 task_started / task_progress 事件',
  task_updated: '来自 Claude Code 的 task_updated 状态变更',
  task_notification: '来自 Claude Code 的 task_notification 终态',
  missing_terminal: '所属轮次已结束，但 Claude Code 未上报该 workflow 的终态；不据此推断成功或失败'
}

export const WORKFLOW_AGENT_STATUS_LABEL: Record<WorkflowAgentStatus, string> = {
  queued: '排队',
  running: '运行中',
  done: '完成',
  cached: '复用结果',
  failed: '失败',
  skipped: '已跳过',
  blocked: '被拦截',
  unsettled: '终态未上报'
}

export const WORKFLOW_COPY = {
  surfaceLabel: 'Claude Code Workflow',
  title: 'Workflow',
  emptyTitle: '本会话尚未观测到 Workflow',
  emptyBody: 'Claude Code 调用 Workflow 工具（例如提示词里包含 ultracode，或运行 /deep-research）后，脚本、阶段与 agent 进度会按真实事件显示在这里。其他 Provider 没有这项能力。',
  runPickerLabel: '选择 workflow 运行',
  runOption: (run: WorkflowRun, position: number) =>
    `#${position} ${run.name ?? run.scriptRef ?? '未命名'} · ${WORKFLOW_RUN_STATUS_LABEL[run.status]}`,
  scriptTitle: '编排脚本',
  scriptSource: {
    tool_input: '来自 Workflow 工具调用入参（原文）',
    task_started: '来自 task_started 事件携带的脚本'
  },
  scriptTruncated: '脚本过长，仅保留前 60,000 个字符',
  scriptUnavailable: (ref: string | undefined) => ref
    ? `本次调用只传了「${ref}」，Claude Code 没有下发脚本正文。内置或保存的 workflow 可能不提供脚本。`
    : 'Claude Code 没有下发脚本正文，无法显示。',
  activePhaseLine: '该阶段有 agent 正在运行（按 phase 标题字面匹配脚本行）',
  mainSession: '主会话',
  mainSessionAction: '调用 Workflow 工具，写出编排脚本',
  mainSessionCall: '调用 Workflow 工具，运行已有的 workflow',
  mainSessionUnobserved: '已加载的历史里没有对应的 Workflow 工具调用',
  runtime: 'workflow runtime',
  runtimeAgents: (count: number) => `已观测 ${count} 个 agent`,
  handback: '回到主会话',
  handbackWaiting: '运行结束后，结果会以任务通知回到主会话',
  handbackUnknown: 'Claude Code 未上报终态，无法确认结果是否回到主会话',
  phaseEmpty: '尚未观测到 agent',
  phaseUndeclared: '该阶段只在 agent 行里出现，没有独立的阶段声明',
  phaseAgents: (settled: number, total: number) => `${settled}/${total} 已结束`,
  phaseMore: (count: number) => `另有 ${count} 个已结束的 agent 未逐个列出`,
  progressUnavailable: 'Claude Code 没有为这次运行下发阶段与 agent 明细（workflow_progress）。下方只显示任务级状态与用量，不代表没有 agent 运行。',
  progressPending: '尚未收到后台任务事件。',
  partial: '较早的进度事件不在已加载的历史中，阶段与 agent 数量可能不完整。',
  rowsOmitted: (count: number) => `有 ${count} 行进度因体积或数量上限被省略，阶段与 agent 数量不完整。`,
  rowsUnrecognized: (count: number) => `有 ${count} 行进度数据当前版本无法识别，已忽略。`,
  usageLimitWait: (time: string) => `已达到用量上限，Claude Code 报告 ${time} 后重置。`,
  evidenceNote: '阶段与 agent 明细来自 Claude Code 任务事件里的 workflow_progress 字段。该字段未写入公开 SDK 类型，CLI 升级后可能变化或缺失。',
  usageTokens: 'tokens',
  usageTools: '工具调用',
  usageDuration: '耗时',
  usageNote: '任务级用量由 Claude Code 上报，是估算值，不是账单。',
  logTitle: '运行日志',
  logEmpty: '尚无日志',
  logDropped: (count: number) => `更早的 ${count} 条已省略`,
  detailTitle: 'Agent 详情',
  detailClose: '关闭 agent 详情',
  detailPrompt: '提示词预览',
  detailResult: '结果预览',
  detailError: '错误',
  detailLastTool: '最近工具',
  detailAttempt: (attempt: number, reason: string | undefined) => `第 ${attempt} 次尝试${reason ? `（上次：${reason}）` : ''}`,
  detailEndedWithRun: '该行由运行结束统一收尾，不是 agent 自己完成',
  detailFallbackModel: (model: string) => `已切换到备用模型 ${model}`,
  facts: { task: 'task', run: 'run', script: '脚本文件', transcripts: 'agent transcripts' }
} as const
