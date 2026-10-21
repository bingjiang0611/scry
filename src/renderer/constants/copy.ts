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
  providerControlsUnavailable: (host: string) => `${host} 未能读取所选 Provider 设置；暂时无法发送`,
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
