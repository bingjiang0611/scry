export const PI_PICKER_COPY = {
  nativePi: '原生 Pi',
  detail: (detected: boolean, version?: string) =>
    `${detected ? '系统检测' : '自定义 Profile'} · ${version ?? '版本未知'}`,
  removeTitle: '从 Scry 移除；不会删除启动器文件',
  removeLabel: (name: string) => `移除 Pi Profile：${name}`
} as const

export const TURN_FLOW_COPY = {
  showEarlier: (count: number) => `显示更早的 ${count} 条活动`,
  showEarlierLabel: (count: number) => `显示本轮更早的 ${count} 条活动`,
  showFullResponse: (count: number) => `显示完整回复（还有 ${count} 个字符）`,
  showFullResponseLabel: (count: number) => `显示本轮完整模型回复；当前隐藏 ${count} 个字符`
} as const

export const TURN_DIFF_REVIEW_COPY = {
  turnTitle: '本轮改动',
  sessionTitle: '本会话净改动',
  preview: '运行中预览',
  sessionRange: (resumed: boolean, preview: boolean) =>
    `${resumed ? '自恢复以来 → 当前' : '第一轮前基线 → 当前'}${preview ? ' · 运行中预览' : ''}`,
  turnLabel: '本轮改动 Review',
  sessionLabel: '本会话净改动 Review',
  closeTitle: '关闭 Review（Esc）',
  closeLabel: '关闭 Review'
} as const

export const ANALYTICS_COPY = {
  title: '用量',
  totalLabel: '原始 Token 成本',
  composition: '成本构成',
  compositionChart: '各 Provider 的已知成本占比',
  byProvider: '按 Provider',
  overview: '用量概览',
  tokens: 'Token 用量',
  processedTokens: '已处理 Token',
  cacheRead: '缓存输入',
  input: '已观测输入',
  output: '输出',
  cacheWrite: '缓存写入',
  details: '明细',
  model: '模型',
  day: '日期',
  detailDimension: '明细维度',
  costUsd: '成本（USD）',
  share: '占比',
  token: 'Token',
  unattributed: '未归因',
  back: '返回对话',
  rangeLabel: '分析时间范围',
  range: (days: number) => `${days} 天`,
  period: (from: string, to: string) => `${from} 至 ${to}`,
  periodDisplay: (from: string, to: string) => `${from} – ${to}`,
  refresh: '刷新分析数据',
  loading: '正在读取本机用量账本…',
  creditsPending: '正在计算 Credit；当前只显示用量账本记录',
  unavailable: '用量分析暂不可用',
  databaseUnavailable: 'SQLite 尚未初始化，Scry 其他功能不受影响。',
  retry: '重试',
  noCost: '当前范围没有已知成本',
  noDetails: '当前范围没有可展示的明细',
  cost: '成本',
  tokenToggle: 'TOKEN',
  dailyCost: '每日成本',
  dailyTokens: '每日 Token',
  costTrend: '每日成本趋势',
  tokenTrend: '每日 Token 趋势',
  metric: '趋势指标',
  legend: 'Provider 图例',
  noCostChart: '该时间范围没有可绘制的成本数据。',
  noTokenChart: '该时间范围没有可绘制的 Token 数据。',
  noDailyRecord: '当日无记录',
  creditAmount: (value: number | null) => {
    if (value == null) return 'Credit 不可用'
    if (value > 0 && value < 0.01) return '<0.01 Credits'
    return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} Credits`
  },
  chartInstructions: '聚焦图表后，可使用左右方向键逐日查看证据，Home / End 跳到首尾，Esc 收起详情。无记录日沿基线连接以保持走势连续，但不代表实际值为零。',
  providerEvidence: (cost: string, tokens: string, tokenEvidence: string) => `${cost}；${tokens} Token；${tokenEvidence}`,
  totalEvidence: (evidence: string, turns: number) => `${evidence}；${turns.toLocaleString()} 轮；不代表实际账单。部分覆盖只表示已知下界。`,
  tokenCoverage: (known: number, total: number) => `${known}/${total} 条明细已上报`,
  outputEvidence: (known: number, total: number, reasoning: string) => `${known}/${total} 条明细已上报；推理 ${reasoning}`
} as const

export const MODAL_COPY = {
  close: '关闭',
  closeRename: '关闭重命名',
  closeRemoteDirectory: '关闭远程目录选择',
  closeSettings: '关闭设置',
  closeSkills: '关闭 Skills',
  closeMcp: '关闭 MCP',
  closeCapabilities: '关闭能力面板',
  cancelDelete: '取消删除',
  closePromptEditor: '关闭提示词编辑器',
  closeLlmPerformance: '关闭 LLM 性能'
} as const

export const IMAGE_PREVIEW_COPY = {
  close: '关闭图片预览',
  stage: '图片内容，可滚动查看',
  zoomGroup: '图片缩放（相对于适应窗口）',
  zoomOut: '缩小图片',
  zoomIn: '放大图片',
  resetZoom: (percent: number) => `${percent}%，重置为适应窗口`,
  dimensions: (width: number, height: number) => `${width} × ${height}`
} as const

export const BACKGROUND_WORK_COPY = {
  regionLabel: '后台任务',
  provider: { pi: 'Pi', qoder: 'Qoder' },
  waiting: '等待结果',
  unknown: '状态未知',
  stopping: '请求停止中…',
  stopRequested: '已请求停止',
  stopUnconfirmed: '停止待确认',
  stopUnavailable: '单任务停止不可用',
  stopRejected: '停止请求被拒绝',
  stopUnknownMessage: '停止结果未确认，不会自动重复请求。',
  stop: '停止任务',
  stopLabel: (taskId: string) => `停止任务 ${taskId}`,
  details: '详情',
  detailsLabel: (name: string) => `${name} 任务详情`,
  taskId: '任务 ID',
  receipt: '回执时间',
  age: (value: string) => `已观测 ${value}`,
  ageTitle: '自收到启动回执起计时，非精确进程运行时间',
  empty: '等待后续结果',
  quiet: '长时间无新进展；文件可能已写入，重试前请先核验。'
} as const

export const OVERVIEW_SESSION_COPY = {
  heading: '会话',
  context: '上下文占用',
  contextUnavailable: '暂无上下文数据',
  id: 'ID',
  compact: 'Compact',
  scopeLabel: '查看压缩统计范围',
  scope: '仅统计当前已加载记录中确认完成的压缩；不代表原生会话的全部历史',
  expandId: '展开完整 sessionId',
  collapseId: '收起完整 sessionId',
  copy: '复制完整 sessionId',
  copied: '已复制完整 sessionId',
  copyFailed: '复制未完成，请展开 ID 后手动选择',
  missingId: '尚未捕获'
} as const

export const WORKSPACE_EDITOR_COPY = {
  actions: '文件操作',
  expandSource: '展开源码',
  collapseSource: '收起源码',
  reload: '重新载入',
  confirmReload: '放弃当前修改并从磁盘重新载入吗？',
  readOnly: '只读预览',
  unsaved: '未保存',
  saved: '已保存',
  status: (state: string, kib: number) => `${state} · ${kib} KiB`,
  saving: '保存中…',
  save: '保存 ⌘S'
} as const

export const OVERVIEW_CACHE_COPY = {
  label: (cumulative: boolean, partial: boolean) => `缓存命中率${cumulative ? ' · 累计' : ''}${partial ? ' · 部分' : ''}`,
  unavailable: '没有完整的输入与缓存 Token 证据，无法计算命中率',
  coverage: (known: number, total: number, cumulative: boolean) =>
    `缓存读取 Token ÷ 可缓存输入 Token；${known}/${total} 轮可计算${cumulative ? '；包含未结束轮次已上报请求的累计值，非最终值' : ''}`
} as const

export const OVERVIEW_COST_COPY = {
  label: '成本',
  unavailable: '当前 Provider 未上报成本',
  coverage: (known: number, total: number) => `${known}/${total} 轮上报了成本`
} as const

export const OVERVIEW_TOOL_ERROR_COPY = {
  heading: '调用证据',
  openInChat: '定位到对话',
  input: '输入',
  output: '输出',
  message: '报错信息',
  notReported: 'Provider 未上报',
  noDetail: '工具未返回错误详情',
  /** 正文超出内联预算，只留存档引用；不能说成 Provider 未上报。 */
  archived: (bytes: number) => `完整输出已存档 · ${bytes.toLocaleString()} bytes`
} as const

export const SESSION_DRAFT_LABEL = '草稿'

export { SIDEBAR_SESSION_COPY, SIDEBAR_PROJECT_COPY } from './sidebar-copy'

export const SIDEBAR_ACTIVITY_COPY = {
  navigation: '侧栏视图',
  projects: '项目',
  activity: '动态',
  scope: '本机任务：需要回复、进行中、待查看的新结果和明确完成的任务；其他会话请在项目中查看',
  attention: '需要回复',
  working: '进行中',
  updates: '待查看',
  completed: '已完成',
  empty: '暂无匹配的任务，其他会话请在「项目」中查看',
  overflow: (count: number) => `另有 ${count} 条，请搜索定位`
} as const

export { REMOTE_ACCESS_COPY, REMOTE_ATTACHMENTS_COPY, REMOTE_SESSION_COPY } from './remote-copy'

export const SLASH_COMMAND_COPY = {
  heading: (host: string | undefined, loading: boolean) => {
    const source = host ? `${host} 上的命令` : 'Commands'
    return loading ? `${source} · 读取中…` : source
  },
  refresh: '刷新',
  retry: '重试',
  refreshTitle: (host?: string) => host ? `重新读取 ${host} 的命令清单` : '重新拉取命令清单',
  empty: '命令清单为空——当前 Provider 未返回命令；可刷新或查看诊断',
  noMatches: '无匹配命令'
} as const

export const ARCHIVED_SESSIONS_COPY = {
  localTitle: '本机已存档会话',
  deleteAllLocal: '删除全部本机会话',
  localEmpty: '没有本机已存档会话'
} as const

export const QUESTIONNAIRE_COPY = {
  pending: (count: number) => `还有 ${count} 题待回答`,
  review: '可修改任意答案，确认后提交',
  submitAll: '提交全部答案',
  selectToContinue: '选择后即可继续',
  ready: '已选择，可继续',
  cancel: '取消',
  submitting: '正在提交…',
  submit: '提交并继续'
} as const

export const CONVERSATION_COPY = {
  handoffScope: '缺失文字按预算补齐，其余可检索。只发送当前图片，不重放历史图片。原生命令和 Steer 暂不支持。'
} as const

// 排队消息块的全部用户可见文案。Steer 的状态文案与证据语义绑定：
// pending/unknown 不是「稍后再试」，而是「已经交出去，不能撤销」。
export const QUEUE_COPY = {
  title: '等待运行',
  hint: '当前任务结束后依次发送',
  listLabel: (count: number) => `排队中的消息，共 ${count} 条`,
  imagesOnly: (count: number) => `${count} 张图片`,
  attachmentsTitle: (names: string[]) => names.join('\n'),
  steer: 'Steer',
  steerPending: '提交中',
  steerRetry: '重试 Steer',
  steerLabel: (label: string, index: number) => `${label}：队列第 ${index} 条消息`,
  steerTitle: '不中断模型，将这条消息补充给当前任务',
  steerTitleEnded: '当前任务已结束，Steer 仅可发送给运行中的任务',
  steerTitleWaiting: '正在等待运行时 Steer 能力证据',
  steerTitlePending: 'Steer 正在提交；完成前不能重复提交或移除',
  steerTitleUnknown: (reason?: string) => `结果未知：${reason ?? '请先核对 Provider 回执'}；不能重发或移除`,
  steerTitleRejected: (reason?: string) => `Provider 明确拒绝：${reason ?? '未提供原因'}；点击重试`,
  steerTitleNoAttachments: '当前运行不支持 Steer 图片附件',
  steerUnavailable: (reason: string) => `Steer 不可用：${reason}`,
  reasonRejected: 'Provider 已拒绝',
  reasonUnavailable: 'Steer 不可用',
  reasonUnknown: '结果未知；暂不重发或自动出队',
  remove: '移除排队消息',
  removeLabel: (index: number) => `移除队列第 ${index} 条消息`,
  removeTitlePending: 'Steer 正在提交，不能移除',
  removeTitleUnknown: '结果未知的 Steer 不能移除',
  edit: '编辑这条消息',
  editLabel: (index: number) => `编辑队列第 ${index} 条消息`,
  editTitle: '把这条消息放回输入框修改；发送后移到队尾',
  editTitleStarting: '队首消息正在启动，完成前不能编辑',
  editTitlePending: 'Steer 正在提交，不能编辑',
  editTitleUnknown: '结果未知的 Steer 不能编辑，先核对 Provider 回执',
  editTitleDraft: '输入框里已有内容：先发送或清空，再编辑队列消息',
  // 「移到队尾」和「自动发送会跳过这条」都是行为变化，必须写在用的地方。
  editingHint: (index: number) => `编辑队列第 ${index} 条 · 发送后移到队尾 · 自动发送会先跳过这条`,
  cancelEdit: '取消编辑',
  editClaimed: '这条消息正在提交，完成前不能编辑',
  editMissing: '这条消息已不在队列，已作为新消息排到队尾',
  editedMoved: '编辑后已移到队尾'
} as const

export const LOADING_COPY = {
  sessionOpenFailed: (detail: string) => `无法打开对话：${detail}`,
  sessionHistory: '正在读取会话历史…',
  sessionHistoryDetail: '会话已切换；内容将在本机证据读取完成后显示。',
  skillsUnavailable: '未取得 Skill 清单，可点刷新重试',
  mcpUnavailable: '未取得 MCP 配置，可点刷新重试',
  skills: '正在读取 Skill…',
  skillsSourceEmpty: '当前来源没有 Skill',
  skillsEmpty: (scope: string) => `未发现${scope}`,
  skillsNoMatch: (scope: string) => `${scope}中没有匹配结果`,
  mcp: '正在读取 MCP 配置…',
  mcpSourceEmpty: '当前来源没有 MCP',
  mcpEmpty: '未发现 MCP 配置',
  refresh: '刷新',
  detecting: '检测中…',
  reading: '读取中…',
  readingConfig: '读取配置中…',
  piSnapshot: '正在刷新 Pi MCP 快照…',
  detectingMcp: '正在检测全部 MCP…',
  refreshing: '刷新中…',
  tools: '正在读取工具明细…',
  remoteProjects: (host: string) => `正在读取 ${host} 的项目…`,
  directoryCount: (shown: number, total: number) => `${shown} / ${total} 个文件夹`,
  directoryUnread: '尚未读取目录',
  skillScope: { project: '项目 Skill', user: '用户 Skill', provider: 'Provider Skill' },
  skillsResults: (count: number) => `${count} 个结果`,
  skillsVisible: (shown: number, total: number) => `显示 ${shown} / ${total}`,
  mcpNoConfigEvidence: '没有配置证据不等于运行正常，也不等于连接失败。',
  mcpSummary: (configured: number, connected: number, runtime: number, tests: number) => `${configured} 配置 · ${runtime > 0 ? connected + ' 已连接 / ' + runtime + ' 运行态' : '运行态未返回'} · ${tests} 测试证据`
} as const
