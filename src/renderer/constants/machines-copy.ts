// 「机器」页的文案（P8 §2）。搬迁过来的配对与连接文案留在 remote-copy.ts，
// 这里只放这个页面自己的标题、状态和提示，避免一个字典文件无限增长。
export const MACHINES_COPY = {
  navLabel: '机器',
  title: '机器',
  subtitle: '本机、执行目标和已配对设备的状态与资源',
  refresh: '刷新',
  refreshing: '正在刷新…',
  section: {
    local: '本机',
    targets: '执行目标',
    devices: '已配对的设备'
  },
  localTitle: '本机',
  online: '在线',
  loading: '正在读取…',
  readFailed: '读取资源失败',
  unknown: '状态未知',
  expandDetail: '展开明细',
  collapseDetail: '收起明细',
  sampledAt: (time: string) => `${time} · `,
  scryUsage: 'Scry 占用',
  daemon: '后台服务',
  providerProcesses: (count: number) => `Provider ${count} 个进程`,
  providerUnreadable: 'Provider 进程不可用',
  resources: '资源',
  disks: '磁盘',
  usageTable: {
    source: '来源',
    processes: '进程',
    cpu: 'CPU',
    memory: '内存',
    total: '合计',
    note: '只统计 Scry 后台服务启动的进程，按 Provider 汇总；不读取命令行。第二版按会话拆分。'
  },
  runsRow: '运行',
  services: '本机服务与入站连接',
  unavailable: '不可用',
  // 目标机卡片在没有资源可显示时说的实话；绝不画一条 0%。
  targetOffline: '离线',
  targetOfflineDetail: '连接后才能读取这台机器的资源。',
  targetUnsupported: '该主机版本不支持，请升级',
  targetUnsupportedDetail: '升级后即可显示这台机器的资源；会话和运行不受影响。',
  targetFailed: (detail: string) => `读取资源失败：${detail}`,
  targetFailedDetail: '显示的仍是上次成功读取的数据；可以重试。',
  targetRetry: '重试',
  sectionEmptyTargets: '还没有执行目标',
  settingsMigrated: '连接与设备已移到侧栏「机器」。执行目标、已配对的设备、允许其他设备连接本机，都在那里管理。',
  settingsOpenMachines: '打开「机器」',
  settingsHint: '这一页保留一个版本作为指引，之后会从设置里移除。',
  settingsMigratedTag: '已迁移'
} as const
