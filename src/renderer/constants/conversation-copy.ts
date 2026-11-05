/**
 * 会话视图自己的用户可见文案。
 *
 * 单独成文件是因为共享字典 `constants/copy.ts` 已经贴着 20 KB 上限：会话相关的文案继续
 * 堆在里面会把它顶出去。语义上仍然是同一份字典的一部分，视图只 import 这里。
 */
export const CONVERSATION_COPY = {
  handoffScope: '缺失文字按预算补齐，其余可检索。只发送当前图片，不重放历史图片。原生命令和 Steer 暂不支持。',
  // 同时最多两个可见实时流：只能请用户关掉另一个**视图**。运行本身不会被中断，
  // 写成「关闭/停止会话」会让人以为要去打断正在跑的任务。
  forkUnsupported: '侧聊不属于来源会话的原生上下文，因此不提供从轮次创建原生分支；请在来源会话里操作。',
  // C1a 的降级文案：缺口条数只有在真的丢过事件时才报。
  traceDegraded: (skipped: number): string => skipped > 0 ? `实时视图已降级 · 缺 ${skipped} 条` : '实时视图已降级',
  liveStreamLimited: '同时只能实时显示两个视图的运行输出。请先关闭另一个正在查看运行的视图；两个运行本身都不会被中断。',
  // 发送回执的结果文案：只描述权威记录证明了什么。
  pendingSettledAccepted: '已确认发送；待核对内容已清理。',
  pendingCheckFailed: (reason: string): string => `核对发送状态失败：${reason}`,
  pendingDuplicate: '已找到原发送记录，没有再次发送。',
  pendingDispatchUnknown: '发送结果尚未确认。原文与图片已保留，不会自动重发。',
  pendingNotSent: '已确认没有发送：宿主在投递前拒绝了本次请求。原文与图片已保留，可显式重发。',
  // 历史 Pi Agent（如内置 `pi:rotom`）本身不是已登记的 Agent Profile，不能直接发送。
  piProfileNotRegistered: (agentLabel: string): string =>
    `无法发送：${agentLabel} 没有已登记的 Pi Agent Profile。请在 Agent 菜单里把同一个启动器添加为 Pi Profile；当前对话和草稿已保留。`,
  // 旧捕获迁移的来源是当时记录的启动器身份，不能改写成已登记 Profile（宿主按记录身份匹配）。
  // 新增 Profile 也不会把那段历史变成该 Profile 的记录，所以只给出真正可行的下一步。
  legacyPiSourceNotMigratable: (agentLabel: string): string =>
    `无法迁移：这段 Pi 会话记录的历史启动器身份 ${agentLabel} 不是已登记的 Agent Profile，不能作为迁移来源；新增 Profile 也不会改写已有记录。请在已登记的 Pi Profile 下新建对话；当前对话和草稿已保留。`
} as const
