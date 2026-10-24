export const PI_PICKER_COPY = {
  nativePi: '原生 Pi',
  detail: (detected: boolean, version?: string) =>
    `${detected ? '系统检测' : '自定义 Profile'} · ${version ?? '版本未知'}`,
  removeTitle: '从 Scry 移除；不会删除启动器文件',
  removeLabel: (name: string) => `移除 Pi Profile：${name}`
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

export const OVERVIEW_COST_COPY = {
  label: '成本',
  unavailable: '当前 Provider 未上报成本',
  coverage: (known: number, total: number) => `${known}/${total} 轮上报了成本`
} as const

export const LLM_RUNNING_MODELS_COPY = {
  region: '运行中的模型',
  heading: (count: number) => `运行中 · ${count} 个会话`,
  unknownProvider: '未知 Provider',
  unknownWorkspace: '工作区未提供',
  sessions: (count: number) => ` · ${count} 个会话`,
  average: '会话平均速度',
  speedUnit: 'token/s',
  firstToken: '平均首 token',
  seconds: '秒',
  stateSummary: (counts: Array<[string, number]>) => counts.map(([label, count]) => `${label} ${count}`).join(' · '),
  coverage: (speed: number, wait: number, total: number) => `速度 ${speed}/${total} 个会话有数据；首 token ${wait}/${total} 个会话有数据。分别对有数据的会话取平均，缺失不计为零。`,
  states: { streaming: '生成中', tool: '工具执行', complete: '收尾中', waiting: '等待模型', firstOutput: '等待首次输出' }
} as const

export const LLM_PERFORMANCE_COPY = {
  title: 'LLM 性能',
  providers: { claude: 'Claude', codex: 'Codex', qoder: 'Qoder', opencode: 'OpenCode', pi: 'Pi' },
  ranges: { 1: '1 小时', 24: '24 小时', 168: '7 天' },
  rangeLabel: '时间范围',
  history: (range: string) => `历史表现 · 最近 ${range}`,
  metricLabel: '指标',
  metrics: {
    speed: { label: '输出速度', unit: 'token/s', chartLabel: '各模型输出速度曲线。左右方向键查看时间点，Home 和 End 跳到两端。' },
    firstToken: { label: '首 token', unit: '秒', chartLabel: '各模型首 token 等待曲线。左右方向键查看时间点，Home 和 End 跳到两端。' }
  },
  noSessions: '无运行中的会话',
  reading: '读取中',
  summaryUnknown: '会话状态未知',
  summaryError: (detail: string) => `运行中会话读取失败：${detail}`,
  historyError: (detail: string) => `历史读取失败：${detail}`,
  truncated: (count: number) => `只含最近 ${count} 轮`,
  provisional: '含运行中数据',
  provisionalHelp: '运行中的轮次只使用已完成调用的数据，结束前会更新；结束后由最终记录替换，不重复计数。',
  emptyRange: '这个时间范围内没有数据',
  selectedEmpty: (model: string, metric: string) => `当前时间范围内没有 ${model} 的${metric}数据`,
  empty: '还没有数据',
  idle: '空闲',
  missing: '—',
  legend: '选择模型',
  comparison: '模型对比',
  columns: { model: '模型', distribution: '速度分布', speed: '中位速度', firstToken: '首 token 中位数', rounds: '测速轮次' },
  distributionHelp: '色带表示 P25–P75，竖线表示中位数。只统计有速度数据的成功轮次，不代表受控性能评测。',
  roundsHelp: '只计入有速度数据的轮次。加号前是已完成轮次，带星号的是运行中的暂计轮次；结束后替换为最终记录。',
  rounds: (complete: number, running: number) => running ? `${complete} + ${running}*` : String(complete),
  roundsLabel: (complete: number, running: number) => `有速度数据：已完成 ${complete} 轮，运行中暂计 ${running} 轮`
} as const

export const SESSION_DRAFT_LABEL = '草稿'

export const SIDEBAR_ACTIVITY_COPY = {
  navigation: '侧栏视图',
  projects: '项目',
  activity: '动态',
  scope: '本机任务：需要回复、进行中和明确完成的任务；其他会话请在项目中查看',
  attention: '需要回复',
  working: '进行中',
  completed: '已完成',
  empty: '暂无匹配的任务，其他会话请在「项目」中查看',
  overflow: (count: number) => `另有 ${count} 条，请搜索定位`
} as const

export const REMOTE_ACCESS_COPY = {
  title: '远程访问',
  settingsTab: '远程访问',
  outboundTitle: '连接其他主机',
  inboundTitle: '允许访问本机',
  addHost: '添加主机',
  displayName: '显示名称',
  invitationString: '邀请字符串',
  pair: '配对',
  deviceFingerprint: '设备指纹',
  awaitingHostApproval: '请在远端确认此设备，再完成配对。',
  devicePaired: '设备已配对。',
  retry: '重试',
  loadingHosts: '正在读取主机…',
  noHosts: '没有主机',
  noHostsHint: '在远端生成 SSH 邀请后添加。',
  status: {
    connected: '已连接',
    disconnected: '未连接',
    pairing: '待批准',
    unknown: '状态未知'
  },
  connectionReadError: (detail: string) => `无法确认连接状态：${detail}`,
  connect: '连接',
  disconnect: '断开',
  finishPairing: '完成配对',
  hostDetails: (expanded: boolean, label: string) => `${expanded ? '收起' : '展开'} ${label}`,
  hostFingerprint: '主机指纹',
  editAddress: '编辑地址',
  projects: '项目',
  cachedProjects: '以下是上次读取的项目；连接后才能新建会话。',
  connectForProjects: '连接后可查看项目。',
  projectReadError: (detail: string) => `无法读取项目：${detail}`,
  loadingProjects: '正在读取项目…',
  loadingProviderControls: '正在读取所选 Provider 设置…',
  providerControlsChanged: '所选模型、推理强度或权限已变化；请重新选择',
  legacyProviderControls: '旧版主机能力快照；发送时由主机重验',
  providerControlsUnavailable: (host: string) => `${host} 未能读取所选 Provider 设置；暂时无法发送`,
  retryProviderControls: '重试读取 Provider 设置',
  refreshProviderControls: '重新读取设置',
  providerControlsObserved: (observedAt?: number, refreshing = false) => {
    const source = observedAt === undefined ? '主机快照；读取时间未知' : `主机读取于 ${new Date(observedAt).toLocaleString()}`
    return refreshing ? `重新读取中 · ${source}` : source
  },
  noProjects: '没有项目。',
  newSession: '新建会话',
  removeHost: '移除主机',
  removeHostEffect: '只移除本机连接，不撤销远端授权。',
  closeAddHost: '关闭添加主机',
  closeEditAddress: '关闭编辑连接地址',
  editAddressEffect: '保存后会断开。请手动重连；远端任务不会停止。',
  hostname: '主机名 / IP',
  sshUsername: 'SSH 用户名',
  sshPort: 'SSH 端口',
  cancel: '取消',
  saving: '正在保存…',
  saveAddress: '保存地址',
  saveFailed: (detail: string) => `保存失败：${detail}`,
  manage: '管理远程访问…',
  desktop: '桌面',
  phone: '手机',
  enabled: '已启用',
  disabled: '未启用',
  relayOnline: '中继已配置',
  relayDormant: '中继休眠',
  relayDormantEffect: '中继休眠，暂时无法接入。',
  generateSshInvite: '生成 SSH 邀请',
  sshInvite: 'SSH 邀请',
  copyInvite: '复制邀请',
  closeInvite: '关闭 SSH 邀请',
  pairPhone: '配对手机',
  closePairing: '关闭配对码',
  close: '关闭',
  enableAndGenerateSshInvite: '启用并生成邀请',
  disableDesktopAccess: '关闭',
  sshInviteEffect: '短时有效，仅发送给预期设备。新邀请会使旧的未完成邀请失效。',
  loadingDesktopStatus: '正在读取桌面访问状态…',
  generatePairingCode: '生成配对码',
  pairingQr: '配对二维码',
  qrFailed: '二维码生成失败，请使用文本码。',
  pairingFingerprintEffect: '配对必须在被访问的主机上批准。请核对连接设备上的公钥指纹。',
  scanQr: '使用 Scry 手机 App 扫码。2 分钟内有效。',
  showTextCode: '无法扫描？查看文本码',
  relayUnavailableSecret: '中继休眠，手机暂时无法接入。一次性口令 2 分钟内有效。',
  pendingDevices: '等待确认',
  pendingFingerprint: (fingerprint: string) => `确认连接设备显示相同指纹：${fingerprint}…`,
  confirm: '确认',
  authorizedDevices: '已授权设备',
  noAuthorizedDevices: '暂无已授权设备。',
  revoke: '吊销授权',
  unnamedDevice: '未命名设备',
  awaitingFingerprint: '等待确认指纹',
  deviceConnecting: '设备连接中…',
  paired: '已配对'
} as const

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

export const REMOTE_SESSION_COPY = {
  archivedTitle: '远程已存档会话',
  archivedDescription: '恢复会话会将其放回远程项目。删除仅移除对应主机上的 Scry 副本。',
  restore: '取消存档',
  deleteUnsupported: '此历史会话缺少可用的 Provider 身份，无法删除。',
  restoreLabel: (label: string) => `取消存档：${label}`,
  archiveLabel: (label: string) => `存档会话：${label}`,
  archiveHint: '存档并停止运行，取消排队消息',
  manageUnavailable: (host: string) => `请连接 ${host} 并确认远端 Scry 支持此操作。`,
  updateUnconfirmed: '远端未确认会话更新，请刷新后核对。',
  upgrade: (host: string) => `请更新并重启 ${host} 上的 Scry，以启用会话操作。`,
  delete: '删除 Scry 副本',
  deleting: '正在删除…',
  cancel: '取消',
  deleteTitle: (host: string) => `删除 ${host} 上的会话`,
  deleteWarning: (label: string) => `将永久删除「${label}」的 Scry 会话副本、附件和用量数据。工作区 .scry 记录与 Provider 原始数据保留。此操作不可撤销。`,
  deleteFailed: (detail: string) => `未能完整删除远端会话：${detail}`,
  operationUnknown: '远端操作结果未确认。请刷新会话列表核对，不要直接重复操作。',
  forkBoundaryMissing: '当前轮次缺少可验证的 Provider 会话边界。',
  forkUnsupported: '此远端或 Provider 不支持创建分支，请更新远端 Scry 后确认能力。'
} as const

export const REMOTE_ATTACHMENTS_COPY = {
  unsupported: '这台远端 Scry 不支持当前图片附件传输。请更新远端 Scry 后重试；图片草稿仍会保留。',
  tooLarge: '图片附件超过这台远端 Scry 的传输限制。请缩小图片或更新远端 Scry；图片草稿仍会保留。',
  tooMany: '图片附件数量超过这台远端 Scry 的传输限制。请移除部分图片或更新远端 Scry。'
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
  session: '正在加载会话历史',
  cache: '正在更新最近会话缓存',
  cacheDetail: '先展示上次读取的最近一页；核对完成前不能发送或分叉。',
  localArchive: '正在读取本机归档，请稍候。',
  remoteArchive: (host: string) => `正在读取 ${host} 的归档，请稍候。`,
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
