// D1 宿主队列的全部用户可见文案。这里的每一条都在说「宿主现在会怎么处理」，
// 不描述本窗口的乐观队列：挂起的条目不会自己发出去，这必须写在用户看得见的地方。
export const HOST_QUEUE_COPY = {
  title: '宿主队列',
  hint: '宿主按这个顺序发送；挂起的条目要确认后才会发出',
  listLabel: (count: number) => `宿主队列，共 ${count} 条`,
  position: (index: number) => `第 ${index} 位`,
  held: '已挂起，不会自动发送',
  release: '放行这一条',
  releaseLabel: (position: number) => `放行宿主队列第 ${position} 位`,
  releasing: '正在放行',
  releaseRefused: (reason: string) => `宿主拒绝放行：${reason}`,
  fromAgent: '由 Agent 排队',
  empty: '宿主队列为空',
  loading: '正在读取宿主队列',
  unavailable: (reason: string) => `读不到宿主队列：${reason}`,
  unknownSession: '宿主没有这个会话的记录，队列未知',
  unknownHint: '这不代表没有排队；宿主确认后会显示真实顺序',
  noPrompt: '（这条没有提示词预览）',
  rowLabel: (position: number, held: boolean) =>
    held ? `宿主队列第 ${position} 位，已挂起` : `宿主队列第 ${position} 位`
} as const
