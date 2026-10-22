// 所有可见文案与合成数据集中在这里，模板里不写自然语言。
// 复用 iOS 现有 ConnectionCopy 的说法；新增项只覆盖抽屉导航本身。

export const copy = {
  title: 'Scry / iOS 会话抽屉',
  heading: '先给输入框，左上角再给列表。',
  intro: '首屏不再是一页会话索引。左上角打开的抽屉接住 Mac 侧栏的会话能力：需要你、置顶、项目分组、搜索、重命名、存档。深色与语义色沿用 iOS 现值，只借 Codex 的结构，不借它的浅色皮肤。',
  prototype: '设计原型 · 合成数据 · 不连接 Mac，不发送任何内容',
  brief: '技术方案与功能对照 ↗',
  hint: '点左上角开抽屉；点会话行看原型反馈；右键或长按行 = 置顶 / 重命名 / 存档。',
  zoom: { label: '画板缩放', fit: '整屏总览', full: '1× 细节' },

  boards: [
    { id: 'home', label: '首屏 · 先输入，再导航', note: '顶栏只有三件事：左上开抽屉、中间当前主机、右上刷新会话。最近会话贴着输入框，键盘弹起后收起，只留输入框。' },
    { id: 'recent', label: '抽屉 · 最近', note: '抽屉宽 272pt，从左侧推入。搜索点开才出现，先让列表占满高度。等待决定的会话提到最上面，不在下面重复出现。' },
    { id: 'projects', label: '抽屉 · 项目与行操作', note: '项目视图保留 Mac 的折叠与项目内新建。长按行打开置顶 / 重命名 / 存档；存档可撤销，运行中的会话要先停止。' },
    { id: 'evidence', label: '首屏 · 运行、失败与队列仍是证据', note: '刷新失败、等待决定、未确认的后台发送都不藏进抽屉：首屏继续承担“发生了什么”的责任。' }
  ],

  drawerTitle: 'Scry',
  openList: '打开会话列表',
  closeList: '关闭会话列表',
  search: '搜索会话 / 项目',
  searchField: '搜索会话 / 项目…',
  cancel: '取消',
  tabRecent: '最近',
  tabProjects: '项目',

  hostOne: 'MacBook Pro',
  allHosts: '全部主机',
  hostMenuTitle: '查看哪个主机的会话',
  connectedHosts: '已配对',
  connectAnother: '连接另一台 Mac',
  hostMenuNote: '筛选只改变查看范围，不改变已有任务的归属。',

  sectionNeedsYou: '需要你',
  sectionPinned: '置顶',
  sectionRecent: '最近',
  seeAll: count => `查看全部 ${count} 个会话`,
  collapse: '收起',
  expand: '展开',

  newSession: '新建会话',
  settings: '设置',
  archivedSessions: '已存档会话',
  version: '0.2.214 · 已配对',
  unverified: '尚未核对 · 下拉刷新',

  running: '运行中',
  waiting: '等待决定',
  fromMac: 'Mac · ',
  draft: '草稿',
  notOpenable: '未建立会话',
  noSessionHint: '这条会话没有外部会话 ID，手机不能打开内容。',

  menuPin: '置顶',
  menuUnpin: '取消置顶',
  menuRename: '重命名…',
  menuArchive: '存档',
  menuArchiveRunning: '存档并停止',
  menuRestore: '恢复到列表',
  renamed: '已重命名',
  renameTitle: '重命名会话',
  renamePlaceholder: '会话标题',
  save: '保存',
  archiveTitle: '存档这个会话？',
  archiveBody: '存档后从列表移除，可在“设置 · 已存档会话”里恢复。',
  archiveBodyRunning: '会话在 Mac 上仍在运行。存档会请求停止并取消排队消息，可在“设置 · 已存档会话”里恢复。',
  archiveAction: '存档',
  archiveRunningAction: '存档并停止',
  archivedToast: '已存档',
  undo: '撤销',
  archivedRowNote: '已从列表移除，可在设置里恢复。',

  recentPeek: '最近',
  composerPlaceholder: '描述任务，或粘贴错误信息…',
  chooseProject: '选择工作目录',
  chooseProvider: '选择 Provider',
  addAttachment: '添加图片或文件',
  send: '发送',
  composerBlocked: '先选工作目录和 Provider，才能发送',

  returnToTask: '返回当前任务 · MacBook Pro',
  returnToTaskDetail: '运行中 · 会话抽屉打开后不会中断它',
  waitingBanner: '任务正在等待你的决定 · 查看',
  continueTask: '继续',
  queueAction: '核实发送结果',
  queueTitle: '待发送与核实 · MacBook Pro',
  queueUnknown: '尚未确认这条消息的执行结果。已保留消息和原主机，不会自动重投。',
  reconcile: '核实发送结果',
  remove: '移除',
  failureTitle: '会话列表刷新失败',
  failureDetail: '仍显示上次读取的内容，未标为最新。',
  retry: '重试',
  details: '详情',


  noMatchesTitle: '没有匹配的会话',
  noMatchesDetail: '试试项目名或 Provider。',

  feedback: {
    send: '原型未发送：首屏会把这条消息交给当前项目与 Provider。',
    openSession: title => `原型没有打开「${title}」；真实 App 进入会话记录。`,
    refresh: '原型未刷新：真实 App 重新读取主机会话列表。',
    newSession: '原型未新建：真实 App 进入新任务页选择目录与 Provider。',
    settings: '原型未打开设置；已存档会话将放在设置里。',
    archivedList: '原型未打开已存档会话；这里是恢复与删除的唯一入口。',
    hostFilter: '单主机原型：多主机时这里切换查看范围。',
    connect: '原型未配对：真实 App 打开扫码配对。',
    archived: title => `已存档「${title}」，5 秒内可撤销。`,
    restored: title => `已恢复「${title}」到列表。`,
    pin: title => `已置顶「${title}」。`,
    unpin: title => `已取消置顶「${title}」。`
  }
}

export const fixtures = {
  host: { id: 'mac1', name: 'MacBook Pro' },
  // minutes 是“多少分钟前”，用于排序与相对时间。
  sessions: [
    { id: 's1', title: '会话归档与恢复的证据边界', provider: 'Codex', project: 'scry', cwd: '/Users/me/work/scry', minutes: 6, draft: true },
    { id: 's2', title: '补齐 iOS 会话抽屉的长按操作', provider: 'Codex', project: 'scry', cwd: '/Users/me/work/scry', minutes: 18, running: true },
    { id: 's3', title: '验收 Mac1 到 Mac2 的转发链路', provider: 'Qoder', project: 'relay', cwd: '/Users/me/work/relay', minutes: 42, waiting: true },
    { id: 's4', title: '重构远程会话列表并统一信息层级', provider: 'Codex', project: 'scry', cwd: '/Users/me/work/scry', minutes: 55, pinned: true, pinnedMinutes: 30 },
    { id: 's5', title: '排查支付页偶发白屏与恢复流程', provider: 'Claude', project: 'payment-web', cwd: '/Users/me/work/payment-web', minutes: 90, pinned: true, pinnedMinutes: 75 },
    { id: 's6', title: '把 MCP 信任状态搬进设置', provider: 'Codex', project: 'scry', cwd: '/Users/me/work/scry', minutes: 200 },
    { id: 's7', title: '整理 Pi Provider 的用量字段', provider: 'Pi', project: 'scry', cwd: '/Users/me/work/scry', minutes: 320 },
    { id: 's8', title: '安装包签名与公证检查', provider: 'Claude', project: 'release', cwd: '/Users/me/work/release', minutes: 1_500 },
    { id: 's9', title: '补一份 turn diff 的失败提示', provider: 'OpenCode', project: 'scry', cwd: '/Users/me/work/scry', minutes: 1_600 },
    { id: 's10', title: '远程目录选择器的边界', provider: 'Codex', project: 'scry', cwd: '/Users/me/work/scry', minutes: 2_600 },
    { id: 's11', title: '旧版本导入的历史会话', provider: '历史', project: 'scry', cwd: '/Users/me/work/scry', minutes: 3_000, openable: false }
  ]
}
