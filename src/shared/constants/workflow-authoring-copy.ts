export const workflowAuthoringCopy = {
  invalidContext: '受限规划必须使用默认权限的独立查询，不能恢复会话或启用历史工具',
  hostToolsDisabled: '受限规划不允许调用宿主工具',
  outputTooLarge: '结构化规划输出超过 4 MiB，未执行程序',
  unavailable: '所选 Provider 未声明结构化、禁用宿主工具的工作流规划能力',
  invalidRunContext: '工作流规划必须使用新的默认权限上下文，不得携带历史、附件、会话恢复或副本执行权限',
  invalidPurpose: '工作流规划用途只能由 Main 的工作流入口指定',
  identityChanged: '编排 Provider 的接续身份已变化，未发送；请重新配置新任务',
  qoderCliMissing: 'Qoder CLI 未找到',
  qoderCompleted: 'Qoder 受限规划已完成',
  qoderFailed: 'Qoder 受限规划失败',
  qoderInterrupted: 'Qoder 受限规划已中断',
  missingCandidate: '规划未返回已持久化的结构化候选；不使用助手文本替代',
  providerIncomplete: (status: string) => `编排 Provider 未完成：${status}`
} as const
