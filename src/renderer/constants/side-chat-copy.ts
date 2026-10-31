/** Side-chat surface copy. Kept out of components so every string is reviewable here. */
export const SIDE_CHAT_COPY = {
  surfaceLabel: '侧边会话',
  surfaceSubtitle: '带入主会话快照，独立提问或修改代码。',
  sharedWorkspace: '共用工作区',
  surfaceClose: '关闭侧聊',
  snapshotLine: (ordinal: number): string => `主会话快照 · 截至第 ${ordinal} 轮`,
  snapshotDetail: '查看来源快照',
  snapshotCapturedAt: (value: string): string => `冻结于 ${value}`,
  snapshotMessageCount: (count: number): string => `${count} 条消息`,
  snapshotLoadError: '快照正文不可用',
  snapshotMissingBody: '正文缺失',
  snapshotApiUnavailable: '当前版本不支持读取侧聊快照正文',
  snapshotEmpty: '本页没有正文',
  snapshotRoleUser: '来源用户',
  snapshotRoleAssistant: '来源助手',
  snapshotSourceTurn: (ordinal: number): string => `源第 ${ordinal} 轮`,
  snapshotContinued: '正文在下一页继续',
  snapshotPageRange: (from: number, to: number, total: number): string => `第 ${from}–${to} 条 / 共 ${total} 条`,
  snapshotOlderPage: '上一页',
  snapshotNewerPage: '下一页',
  snapshotClose: '关闭快照',
  snapshotInlineNotice: '正文按页读取；是否进入模型要看当时的交接回执，此处不做推断。',
  snapshotCoverage: (inline: number, retrievable: number): string =>
    `完整带入 ${inline} 条，仅可检索 ${retrievable} 条`,
  // 空侧聊：它是刚创建的新对话，来源只是冻结快照，不能显示成“等待归档的旧会话”。
  emptyTitle: '换个角度，继续探索',
  emptyDetail: '这是刚创建的侧边会话：已带入来源主会话最近已完成的消息，发送第一条问题后才会开始它自己的记录。',
  rename: '重命名侧聊',
  renamePlaceholder: '输入侧聊名称',
  pendingBlocksSend: '请先核对原发送状态',
  pendingCheck: '核对状态',
  pendingResend: '重新发送',
  pendingStates: {
    unresolved: '发送结果待核对。原文与图片已保留，不会自动重发。',
    notSent: '已确认未发送。可按原内容重新发送。'
  },
  // 原文回执：这里显示的是提交那一份，跟随手编辑的新草稿无关。
  pendingInspect: '查看原文与图片',
  pendingInspectTitle: '这次发送的原文与图片',
  pendingInspectClose: '关闭原文回执',
  pendingInspectTextLabel: '提交的原文',
  pendingInspectImagesLabel: '提交的图片',
  pendingInspectNoText: '这次发送没有文字，只带了图片。',
  pendingInspectReadonly: '只读回执：原文与图片是你提交的那一份，不随后面编辑的草稿改变，也不会自动重发。',
  // 首条消息未确认时不冒充“刚创建、还没发过”的新会话。
  pendingFirstSendTitle: '首条消息的发送结果还没有确认',
  pendingFirstSendDetail: '原文与图片在这条发送的回执里；核对之前不会自动重发，也不会另开一条新记录。',
  providerControls: '切换只影响下一条消息；发送时仍会重校验模型与权限',
  catalogReading: '正在读取该 Provider 的模型与权限',
  catalogNotRead: '尚未读取该 Provider 的模型与权限；更改运行控制时读取',
  catalogUnavailable: '该 Provider 的模型与权限能力暂不可用；发送前仍会重新校验',
  workspaceFixed: '侧聊与来源共用同一工作区，不能从侧聊切换到其他目录',
  providerReading: '正在读取已安装的 Provider；读取完成前不会发送',
  providerUnknown: '(未记录)',
  providerUnavailable: (id: string): string =>
    `请求的 Provider ${id} 当前不可用，因此不会发送；侧聊不会自动改用其他 Provider。请安装它，或在 Agent 菜单中选择另一个 Provider。`,
  workspaceReadonly: (name: string): string => `共用工作区 · ${name}`,
  diffUnavailable: '本轮没有可用的差异证据',
  diffScope: (title: string): string => `${title} · 本轮差异`,
  // 入口与创建：点击只是读取快照并创建一个持久子会话，不发送任何消息。
  entryDescription: '带入主会话快照，独立提问或修改代码。',
  entryAction: '创建侧边会话',
  entryUnavailableNoSource: '当前没有可用的主会话来源；先打开一个主会话。',
  entryUnavailableNoTurn: '主会话还没有可用快照',
  entryUnavailableNested: '侧边会话不能再创建侧边会话；请在它的来源主会话里创建。',
  entryUnavailableApi: '当前版本不支持创建侧边会话。',
  historyLabel: '历史侧边会话',
  historyTitle: '历史侧边会话',
  historyEmpty: '这个主会话还没有侧边会话。',
  historyLoadOlder: '更早的侧边会话',
  historyLoadNewer: '较新的侧边会话',
  historyPageRange: (first: number, last: number, total: number): string => `第 ${first}–${last} 个 / 共 ${total} 个`,
  historyTotal: (total: number): string => `共 ${total} 个侧边会话`,
  historyLoadFailed: (reason: string): string => `读取侧边会话历史失败：${reason}`,
  historyOpenFailed: (reason: string): string => `打开这个侧边会话失败：${reason}`,
  // 创建状态：每一步只描述已经发生的事实，未知不写成失败或成功。
  creating: '正在保存快照…',
  created: '已创建侧边会话。创建不会发送消息。',
  createRefused: (reason: string): string => `没有创建侧边会话：${reason}`,
  // 失败原因只保留可以操作的部分：IPC 拒绝会先带上通道名，那不是给用户的说明。
  reasonOf: (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error)
    const reason = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim()
    return reason || SIDE_CHAT_COPY.unknownReason
  },
  unknownReason: '未知原因；没有确认任何结果。',
  createUnknown: '创建结果尚未确认。可以只读核对同一个创建命令，不会重复创建。',
  createDurableUnavailable: '本地存储不可用，创建命令无法保存，因此没有创建。',
  createCheck: '核对创建结果',
  createLedgerFull: '本地还有未确认的创建命令，先核对它们再创建新的侧边会话。',
  layoutUnsaved: '布局未保存到本地；本次打开状态在重启后可能丢失。',
  createNotFoundUnknown: '没有查到这条创建命令；这不代表没有创建。可稍后在历史里确认。',
  createRecovered: '已找回这次创建的侧边会话。',
  previewBlocked: (reason: string): string => `创建后首次发送会被拒绝：${reason}`,
  creationScopeChanged: '主会话已切换，本次创建结果没有写入当前布局；它仍属于原来的主会话。',
  // 页签与状态
  tabStatusAttention: '需处理',
  tabStatusRunning: '运行中',
  tabStatusPermission: '需权限',
  tabUnavailable: '这个侧边会话暂时读不到记录；页签保持打开。',
  tabDeleted: '这个侧边会话已被删除，页签已关闭。',
  // 快照与工作区
  snapshotBoundary: (ordinal: number): string => `主会话快照 · 截至第 ${ordinal} 轮`,
  snapshotExcludedRunning: '不含正在生成的最后一轮',
  snapshotCoverageInline: (inline: number, retrievable: number, total: number): string =>
    `完整带入 ${inline} / ${total} 条${retrievable > 0 ? `，仅可检索 ${retrievable} 条` : ''}`,
  sharedWorkspaceNote: '对话隔离，文件共用',
  childDiffLabel: (title: string): string => `${title} · 侧聊自己的本轮差异`,
  childDiffHint: '这里是侧聊自己的差异；主会话选中的轮次不会被替换。',
  // 侧栏父行计数：只报真实记录算得出的数量。
  parentCount: (total: number): string => `${total} 侧聊`,
  parentRunning: (running: number): string => `${running} 运行中`,
  parentNeedsAttention: (needs: number): string => `${needs} 需处理`,
  orphanGroup: '来源不在当前项目列表中的侧边会话',
  orphanGroupHint: (parentTitle: string): string => `原主会话：${parentTitle}；当前列表读不到它，这不代表已删除`,
  // 分页替换，不是增量展开：每页最多 6 个来源分组、每组最多 20 行。
  orphanPagePrevious: '上一页',
  orphanPageNext: '下一页',
  orphanRowRange: ({ first, last, total }: { first: number; last: number; total: number }): string =>
    `第 ${first}–${last} 个 / 共 ${total} 个`,
  orphanGroupRange: ({ first, last, total }: { first: number; last: number; total: number }): string =>
    `第 ${first}–${last} 个来源 / 共 ${total} 个`,
  activityChild: (parentTitle: string): string => `侧聊 · ${parentTitle}`
}
