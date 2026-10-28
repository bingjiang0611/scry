export const appRunRecordingRecoveryCopy = {
  tracePending: (count: number) => `Scry trace 仍有 ${count} 轮待恢复`,
  traceNextAction: '保留 Scry userData/trace-turn-progress，修复 archive 写入后重试',
  managedPending: (count: number) => `Scry 精确记录仍有 ${count} 轮待恢复`,
  managedNextAction: '保留当前工作区与 Scry Test 数据目录，先运行 scry doctor 并修复 pending canonical journal'
} as const
