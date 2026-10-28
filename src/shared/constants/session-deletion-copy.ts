export const sessionDeletionCopy = {
  retained: ['workspace .scry/ canonical turn evidence', 'Provider-native session transcript/history'],
  missingAuthorization: '没有已持久化的统一对话删除授权',
  targetShared: '删除目标未归属该操作或仍被其他会话引用',
  cancel: '取消',
  deleteCopies: '删除 Scry 会话副本',
  confirmOne: '删除这个历史会话？',
  detail: '将删除 Scry 的 catalog、archive、附件、SQLite 和 usage 记录。工作区 .scry/ canonical evidence 与 Provider 原生 transcript/history 会保留。',
  partialFailure: '会话未完整删除，catalog 已保留供重试',
  partialDetails: (failures: readonly { store: string; error: string }[]) =>
    failures.map(failure => `${failure.store}: ${failure.error}`).join('\n'),
  deleteAll: (count: number) => `删除全部 ${count} 个`,
  confirmAll: (count: number) => `永久删除全部 ${count} 个已存档会话？`,
  failedAll: (count: number) => `${count} 个已存档会话未删除，catalog 已保留供重试`,
  failedDetails: (failures: readonly { preview: string; reason: string }[]) =>
    failures.map(failure => `${failure.preview || '(无预览)'}: ${failure.reason}`).join('\n')
} as const
