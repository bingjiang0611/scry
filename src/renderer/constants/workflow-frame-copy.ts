export const WORKFLOW_FRAME_COPY = {
  title: '控制记录', open: '查看记录',
  openNode: (nodeId: string) => `查看 ${nodeId} 的控制记录`,
  close: '关闭', back: '返回上一条', refresh: '刷新记录',
  loading: '正在读取控制记录…',
  readError: (reason: string) => `无法读取控制记录：${reason}`,
  source: '来源：主进程控制帧',
  scope: '记录状态不代表进程已退出。',
  unavailable: { root_missing: '工作流记录不可用', frame_missing: '控制记录不可用' },
  root: '此记录没有父级', legacy: '旧记录未保存父级关系',
  parent: '查看父级', origin: '查看复用来源', output: '查看记录结果',
  cycle: '此关系指回已查看的记录',
  limit: '本次路径已达 32 条记录。请返回后选择其他关系。',
  labels: { node: '节点', frame: '记录 ID', program: '程序修订', generation: '代次', epoch: '执行 Epoch', cursor: '游标', version: '存储版本', observed: '读取时间' },
  phase: { entered: '已进入', selected: '已记录条件选择', completed: '已保存结果', failed: '已记录失败',
    blocked: '已阻塞', unknown: '结果未知', stopped: '已记录停止', skipped_by_condition: '未被条件选择' }
} as const
