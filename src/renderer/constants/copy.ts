import { detectRendererPlatform, shortcutModifierLabel } from '../platform'

// 快捷键提示里的修饰键跟随实际生效的按键：macOS 显示 ⌘，其他平台显示 Ctrl。
// 处理事件时两个修饰键都接受，所以文案只需跟随平台，不改变行为。
const shortcutModifier = shortcutModifierLabel(detectRendererPlatform())

export const WORKDIR_PICKER_COPY = {
  removeRecentTitle: '从最近文件夹中移除',
  removeRecentLabel: (dir: string) => `从最近文件夹中移除 ${dir}`
} as const

export const PI_PICKER_COPY = {
  nativePi: '原生 Pi',
  detail: (detected: boolean, version?: string) =>
    `${detected ? '系统检测' : '自定义 Profile'} · ${version ?? '版本未知'}`,
  removeTitle: '从 Scry 移除；不会删除启动器文件',
  removeLabel: (name: string) => `移除 Pi Profile：${name}`
} as const

export const COMPOSER_BLOCKED_COPY = {
  missingWorkspace: '原工作目录已不存在。仍可查看历史；恢复目录并重新打开会话后才能继续发送。',
  scanning: '正在检测本机 Provider，暂不能发送',
  // App 不能替用户装 CLI；这里只给出可执行的下一步，不假装能自动修好。
  missingCli: (label: string) => `未检测到 ${label}：先在终端安装并登录该 CLI，再重新检测。草稿与附件已保留。`,
  missingProfile: (profileId: string) => `未检测到 Pi Profile「${profileId}」：在 Agent 菜单重新扫描，或选择其他 Agent。草稿与附件已保留。`
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

export const META_PROMPT_COPY = {
  libraryEmpty: '还没有提示词',
  libraryEmptyDetail: '新建提示词后，就能在这里预览和编辑。',
  create: '新建提示词',
  noResults: (query: string) => `没有与「${query}」匹配的提示词`,
  noResultsDetail: '试试更短的关键词。',
  clearSearch: '清除搜索',
  readFailed: '没能读取提示词库',
  readFailedDetail: '这次读取失败不会改动已保存的提示词。',
  readAgain: '重新读取',
  discardTitle: '放弃未保存的修改？',
  discardDescription: '放弃后，本次修改不会保存。',
  continueEditing: '继续编辑',
  discardChanges: '放弃修改',
  cancel: '取消',
  save: '保存提示词'
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

export const WORKBENCH_EMPTY_COPY = {
  noProject: '尚未选择项目',
  noGitProject: '尚未选择 Git 工作区',
  remoteFilesUnavailable: '当前上下文无法读取文件',
  historyUnavailable: '未取得会话证据',
  diffUnavailable: '尚未取得会话改动证据',
  upgrade: '需要更新远端 Scry',
} as const

export const TERMINAL_EMPTY_COPY = {
  restoring: '正在恢复终端…',
  restoreUnverified: '没能核对原有终端',
  noTerminal: '没有打开的终端',
  noTerminalDetail: '在当前工作区启动终端后，输出会显示在这里。',
  start: '启动终端',
  recordingEmpty: '此页没有录制',
  recordingPartial: '已读取范围内没有录制，列表不完整',
  recordingReadFailed: '没能读取终端录制',
  recordingRefreshFailed: '没能刷新终端录制，仍显示上次读取的列表',
  refreshRecording: '刷新录制',
} as const

export const RENDERER_FAILURE_COPY = {
  title: '没能加载 Scry 界面',
  detail: '若重试仍失败，请重新加载界面。',
  retry: '重试',
  reload: '重新加载',
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
  empty: '尚未收到后台任务记录',
  quiet: '长时间无新进展；文件可能已写入，重试前请先核验。'
} as const

export const OVERVIEW_SESSION_COPY = {
  heading: '会话',
  dataDimensions: '总览数据维度',
  callCount: (count: number) => `${count} 次调用`,
  turnCount: (count: number) => `${count} 轮`,
  context: '上下文占用',
  contextPercent: (value: number) => `上下文占用 ${value}%`,
  contextUnavailable: '未取得上下文占用数据',
  noSessionEvidence: '新会话暂无证据',
  noSubagents: '本会话尚未观测到子 Agent',
  noFileEvidence: '未捕获到文件工具证据',
  noHookEvidence: '未捕获到 Hook 事件',
  noHookResult: 'Provider 未上报执行结果',
  noTurnChanges: '本轮没有净改动',
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
  reading: '读取文件…',
  openFailed: (name: string) => `没能打开「${name}」`,
  openFailedDetail: '如果文件已移动，请从文件树重新选择。',
  accessDenied: '无法访问此文件',
  workspaceAccessDetail: '请在宿主的 Scry 中核对项目授权。',
  fileAccessDetail: '请在宿主上核对文件权限。',
  backToFiles: '返回文件树',
  openAgain: '重新打开',
  refreshFailed: (name: string) => `没能重新读取「${name}」；仍显示当前内容`,
  openedExternally: (name: string) => `已使用系统默认应用打开 ${name}`,
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
  save: `保存 ${shortcutModifier}S`
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

export const OVERVIEW_CREDIT_COPY = {
  label: 'Credit',
  unavailable: '当前会话没有可用的 Qoder Credit 证据',
  coverage: (partial: boolean) => `仅统计已观测到的主会话请求 Credit${partial ? '，存在未覆盖请求或轮次' : ''}`
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
  caughtUp: '暂无需要处理的任务',
  noMatches: (query: string) => `没有与「${query}」匹配的任务`,
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

/** Sidebar notices for sessions the user is not looking at; history stays in the activity view. */
export const BACKGROUND_NOTICE_COPY = {
  region: '后台通知',
  open: (title: string) => `打开会话：${title}`,
  dismiss: (title: string) => `关闭通知：${title}`,
  untitled: '未命名会话',
  kind: {
    attention: '需要回复',
    failed: '运行失败',
    interrupted: '运行中断',
    cancelled: '运行已取消',
    completed: '已完成',
    updated: '有新结果'
  }
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
  queryEmpty: (query: string) => `没有与「${query}」匹配的命令`
} as const

// 时间线分页提示。更早轮次仍在归档里——加载只是收起，不是丢弃，文案必须说清楚。
export const SESSION_EMPTY_COPY = {
  firstTitle: '新会话',
  firstDetail: '发出第一条消息后，回复和执行记录会出现在这里。',
  firstBoundDetail: (workspace: string) => `在「${workspace}」发出第一条消息后，回复和执行记录会出现在这里。`,
  readFailed: '没能读取会话历史',
  readFailedDetail: '这次读取失败不会更改归档。',
  readUnavailable: '未取得会话历史',
  readUnavailableDetail: 'Provider 侧可能还有历史，但 Scry 没有可校验的归档可展示。',
  archiveEmpty: '此归档没有轮次',
  waiting: '尚未取得会话轮次',
  waitingDetail: (host?: string) => host ? `仍在等待「${host}」的归档或运行事件。` : '仍在等待本机归档或运行事件。',
  sideChat: '新侧聊',
} as const

export const HISTORY_WINDOW_COPY = {
  rangeLabel: '历史轮次范围',
  rangeLocal: (loaded: number, total: number) => `已加载 ${loaded} / ${total} 轮·更早轮次仍在本机归档中，未丢弃`,
  rangeRemote: (loaded: number, host: string) => `已加载最近 ${loaded} 轮·更早轮次仍在 ${host} 的归档中，未丢弃`,
  loadOlder: '加载更早轮次',
  loadingShort: '加载中…',
  exhausted: (total: number) => `已到最早一轮 · 共 ${total} 轮`
} as const

export const ARCHIVED_SESSIONS_COPY = {
  localTitle: '本机已存档会话',
  deleteAllLocal: '删除全部本机会话',
  localEmpty: '没有本机已存档会话',
  readFailed: '没能读取本机存档',
  readAgain: '重新读取',
  noMatches: (query: string) => `没有与「${query}」匹配的存档会话`,
  noFilteredSessions: '所选筛选条件下没有存档会话',
  clearSearch: '清除搜索',
  clearFilters: '清除筛选',
  loading: '正在读取已存档会话…',
  deleting: '正在永久删除已存档会话',
  deleteUnavailable: '本地会话数据不可用，恢复后可重试'
} as const

// 归档列表的 Provider 筛选：Provider id 不给人读，未知来源也不能冒充某个 Provider。
export const PROVIDER_FILTER_COPY = {
  label: '按 Provider 筛选',
  all: '全部 Provider',
  unknown: 'Provider 未知'
} as const

export const QUESTIONNAIRE_COPY = {
  pending: (count: number) => `还有 ${count} 题待回答`,
  review: '可修改任意答案，确认后提交',
  submitAll: '提交全部答案',
  selectToContinue: '选择后即可继续',
  ready: '已选择，可继续',
  cancel: '取消',
  submitting: '正在提交…',
  submit: '提交并继续',
  submitShortcut: `${shortcutModifier}↵`
} as const

export const MCP_TRUST_EMPTY_COPY = {
  scanFailed: '没能完成 MCP 扫描',
  scanAgain: '重新扫描',
  liveUnread: '尚未取得 MCP 实时状态',
  refreshLive: '刷新 MCP 状态',
  noAuthorizationGap: '已观测的 MCP 状态无授权缺口',
} as const

export const LOADING_COPY = {
  sessionOpenFailed: (detail: string) => `无法打开对话：${detail}`,
  sessionAdoptFailed: '未能接回正在进行的任务。重新点击侧栏中的会话可重试。',
  sessionHistory: '正在读取会话历史…',
  sessionHistoryDetail: '会话已切换；内容将在本机证据读取完成后显示。',
  // 缓存或目录预览已经在屏幕上时，不能再说「内容将在读取完成后显示」。
  sessionHistoryVerifying: '正在核对会话历史…',
  sessionHistoryVerifyingDetail: '当前显示的是上次读取的内容；核对完成前暂不能发送或分支。',
  sendWaitsForHistory: '会话历史读取完成后才能发送，避免发到错误的会话',
  skillsUnavailable: '没能读取 Skill 清单',
  mcpUnavailable: '没能读取 MCP 配置',
  skills: '正在读取 Skill…',
  skillsSourceEmpty: '当前来源没有 Skill',
  // The Provider answered without a list (unknown/unsupported): not the same as none.
  skillsSourceUnread: '未能读取当前来源的 Skill（原因见上方）',
  skillsEmpty: (scope: string) => `未发现${scope}`,
  skillsNoMatch: (scope: string) => `${scope}中没有匹配结果`,
  mcp: '正在读取 MCP 配置…',
  mcpSourceEmpty: '当前来源没有 MCP',
  mcpSourceUnread: '未能读取当前来源的 MCP（原因见上方）',
  mcpEmpty: '未发现 MCP 配置',
  refresh: '刷新',
  detecting: '检测中…',
  reading: '读取中…',
  readingConfig: '读取配置中…',
  piSnapshot: '正在刷新 Pi MCP 快照…',
  detectingMcp: '正在检测全部 MCP…',
  cancelMcp: '取消检测',
  cancellingMcp: '正在取消…',
  cancelMcpUnavailable: '无法取消',
  detectingMcpSlow: '仍在检测，比平时久；可以关闭此窗口，检测会继续，重新打开时显示结果',
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

/** 停止控制调用的事实文案：调用失败不冒充“已请求”，更不冒充“已终止”。 */
// 侧栏乐观改动的保存状态：固定在行的时间位置，失败时在行内说明并可重试。
export const SESSION_SAVE_COPY = {
  saving: '保存中',
  saved: '已保存',
  retry: '重试',
  gone: '会话已不存在或身份已变化',
  pinFailed: '置顶没有保存',
  archiveFailed: '存档没有保存',
  failed: (action: 'pin' | 'archive', reason: string): string => `${action === 'pin' ? '置顶' : '存档'}没有保存：${reason}`
} as const

export const RUN_STOP_COPY = {
  requesting: {
    label: '正在请求停止…',
    hint: '停止请求已发出，等待 Provider 确认；确认前这一轮仍可能在运行'
  },
  requestFailed: {
    label: '停止请求没有发出',
    hint: (reason: string): string => `${reason}。这一轮仍在运行，可以再次点击停止`
  },
  interruptRequestFailed: {
    label: '停止请求未生效',
    hint: (providerId: string): string =>
      `${providerId} 的取消调用失败，Scry 无法确认取消已经发出。这一轮可能仍在运行，用量与文件足迹尚未收敛；停止意图会继续按窗口升级，只有存在安全的硬杀范围时才会发出强制终止，否则如实显示未确认终止，收到 Provider 终态前不会显示完成`
  }
} as const
