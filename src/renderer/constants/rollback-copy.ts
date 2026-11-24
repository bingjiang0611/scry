// D5 倒回的全部用户可见文案。倒回会覆盖工作树，所以文案只承诺它真的会做的事：
// 恢复宿主记下的检查点；未提交的改动是否保留取决于当时的检查点，不在这里替它打包票。
export const ROLLBACK_COPY = {
  action: '倒回到检查点',
  label: (runId: string) => `把这次运行的工作树倒回到检查点（run ${runId}）`,
  confirmTitle: '倒回会重写工作树',
  confirmBody: '从宿主记下这次运行的检查点恢复；之后在同一工作树里的改动会被覆盖。',
  confirmAction: '确认倒回',
  cancelAction: '取消',
  working: '正在倒回',
  done: '已倒回检查点',
  refused: (reason: string) => `宿主拒绝倒回：${reason}`,
  unknown: '结果未知：请先核对宿主，重复提交可能导致第二次重写',
  noCheckpoint: '这次运行没有可用的检查点',
  noRun: '没有可倒回的运行',
  unavailable: '宿主不支持倒回'
} as const
