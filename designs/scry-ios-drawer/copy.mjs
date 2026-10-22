// 所有可见文案与合成数据集中在这里，模板里不写自然语言。
// 复用 iOS 现有 ConnectionCopy 的说法；新增项只覆盖抽屉导航本身。

export const copy = {
  title: 'Scry / iOS 会话抽屉',
  heading: '先给输入框，左上角再给列表。',
  intro: '首屏不再是一页会话索引。左上角打开的抽屉接住 Mac 侧栏：需要你、置顶、项目分组、搜索、重命名、存档，外加「工具」里的五个只读面板。深色与语义色沿用 iOS 现值，只借 Codex 的结构，不借它的浅色皮肤。',
  prototype: '设计原型 · 合成数据 · 不连接 Mac，不发送任何内容',
  brief: '技术方案与功能对照 ↗',
  hint: '点左上角开抽屉；点会话行看原型反馈；右键或长按行 = 置顶 / 重命名 / 存档。',
  zoom: { label: '画板缩放', fit: '整屏总览', full: '1× 细节' },

  boards: [
    { id: 'home', label: '首屏 · 先输入，再导航', note: '顶栏只有三件事：左上开抽屉、中间当前主机、右上刷新会话。最近会话贴着输入框，键盘弹起后收起，只留输入框。' },
    { id: 'recent', label: '抽屉 · 最近', note: '抽屉宽 272pt，从左侧推入。搜索点开才出现，先让列表占满高度。等待决定的会话提到最上面，不在下面重复出现。' },
    { id: 'projects', label: '抽屉 · 项目与行操作', note: '项目视图保留 Mac 的折叠与项目内新建。长按行打开置顶 / 重命名 / 存档；存档可撤销，运行中的会话要先停止。' },
    { id: 'evidence', label: '首屏 · 运行、失败与队列仍是证据', note: '刷新失败、等待决定、未确认的后台发送都不藏进抽屉：首屏继续承担“发生了什么”的责任。' },
    { id: 'tools', label: '抽屉 · 工具', note: 'Mac 侧栏的五个面板收进「工具」标签页：每行带真实状态摘要，能力不成立时整行不可用并写原因，不做假入口。' },
    { id: 'analytics', label: '面板 · 分析', note: '读 Mac 的聚合结果。每个指标都带覆盖度；主机没给的字段是 unavailable，不是 0。明细有上限，可再加载。' },
    { id: 'llm', label: '面板 · LLM 性能', note: '与 Mac 同序：运行中会话在上（模型、状态、平均速度、首字），历史在下（范围、指标切换、模型图例、曲线、模型对比）。' },
    { id: 'skills', label: '面板 · 技能', note: '与 Mac 同结构：来源分页（项目 / 用户 / Provider）+ 搜索 + 显示 N / 总数 + 名称 · 描述 · 来源目录。只读，不改 Skill 配置。' },
    { id: 'mcp', label: '面板 · MCP', note: 'Mac 这块本身就是只读观测：运行时状态、策略状态、风险发现、Fleet inventory、策略与审计。手机照搬，动作只有刷新与扫描。' },
    { id: 'meta', label: '面板 · Meta Prompts', note: '与 Mac 同结构：搜索 + 条数 + 列表（标题 + 首行 + 复制）+ 详情（正文 + 字数 + 放入输入框）。编辑留在 Mac，避免跨设备分叉。' }
  ],

  drawerTitle: 'Scry',
  openList: '打开会话列表',
  closeList: '关闭会话列表',
  search: '搜索会话 / 项目',
  searchField: '搜索会话 / 项目…',
  cancel: '取消',
  tabRecent: '最近',
  tabProjects: '项目',
  tabTools: '工具',

  toolsLabel: '工具',
  toolsNote: '只读镜像 · 写操作在 Mac 上完成',
  toolUnavailable: reason => `不可用 · ${reason}`,
  // 能力不成立时写明是哪一项能力缺失，而不是把入口留空。
  toolGated: {
    analytics: '主机的用量数据库不可用',
    llm: '这条链路没有计时证据',
    skills: '当前 Provider 未声明技能能力',
    mcp: '该 Provider 没有 MCP 状态接口',
    meta: '主机没有提示词接口'
  },
  toolRows: [
    { id: 'analytics', label: '分析', icon: 'chart', status: '近 30 天 · 128 轮 · US$4.12' },
    { id: 'llm', label: 'LLM 性能', icon: 'gauge', status: '2 个模型有样本 · 1 个会话运行中' },
    { id: 'skills', label: '技能', icon: 'box', status: '项目 2 · 用户 3' },
    { id: 'mcp', label: 'MCP', icon: 'plug', status: '3 servers · 1 项发现', tone: 'warn' },
    { id: 'meta', label: 'Meta Prompts', icon: 'doc', status: '3 条提示词 · 可填入输入框' }
  ],

  panel: {
    back: '返回',
    refresh: '重新读取',
    provenance: (host, time) => `来自 ${host} · ${time} 读取`,
    unavailable: '不可用',
    readOnly: '只读镜像，不改 Mac 上的配置',
    more: '再加载',
    shown: (n, total) => `显示 ${n} / ${total}`,
    macOnly: '编辑在 Mac 上处理',
    reportNote: (id, rule, who) => `来源 ${id} · rule ${rule} · ${who}；标签只代表报告证据，不是官方认证。`
  },

  analytics: {
    title: '分析',
    rangeLabel: '统计范围',
    ranges: [7, 30, 90],
    rangeLabelOf: days => `${days} 天`,
    period: (from, to) => `${from} – ${to}`,
    totalLabel: '成本合计',
    composition: '成本构成',
    dailyCost: '每日成本',
    dailyTokens: '每日 token',
    metricLabel: '图表指标',
    cost: '成本',
    tokenToggle: 'token',
    byProvider: '按 Provider',
    noCost: '这段时间没有已知成本',
    tokens: 'Token',
    details: '明细',
    dimension: '明细维度',
    model: '模型',
    day: '按日',
    columns: { cost: '成本', share: '占比', token: 'token' },
    noDetails: '没有明细行',
    unattributed: '未归属模型',
    legendNote: '≈ 近似成本 · 下界 = 该行 token 未覆盖全部轮次'
  },

  llm: {
    title: 'LLM 性能',
    rangeLabel: '时间范围',
    ranges: [{ hours: 1, label: '1 小时' }, { hours: 6, label: '6 小时' }, { hours: 24, label: '24 小时' }, { hours: 168, label: '7 天' }],
    running: heading => `${heading} 个会话运行中`,
    runningRegion: '运行中会话',
    sessions: n => `${n} 个会话`,
    average: '平均速度',
    firstToken: '首字',
    speedUnit: 'tok/s',
    seconds: 's',
    missing: '缺数据',
    reading: '读取中…',
    noSessions: '当前没有运行中的会话',
    unknownProvider: '未知 Provider',
    unknownWorkspace: '未知工作目录',
    coverage: (speed, wait, total) => `${speed} 个有速度 · ${wait} 个有首字 · 共 ${total} 个`,
    history: label => `历史 · ${label}`,
    metricLabel: '指标',
    metrics: { speed: { label: '速度', unit: 'tok/s' }, firstToken: { label: '首字延迟', unit: 's' } },
    legend: '模型图例',
    comparison: '模型对比',
    samples: n => `${n} 个样本`,
    unitSamples: '样本',
    provisional: '含临时样本',
    truncated: n => `只保留最近 ${n} 条`,
    empty: '这段时间还没有样本',
    emptyRange: '当前范围没有样本',
    selectedEmpty: label => `所选模型没有${label}数据`
  },

  skills: {
    title: '技能',
    eyebrow: '能力清单',
    intro: '当前 Provider 在这个工作目录里实际发现了哪些 Skill。',
    scopeLabel: 'Skill 来源',
    scopes: { project: '项目 Skill', user: '用户 Skill', provider: 'Provider Skill' },
    scopesShort: { project: '项目', user: '用户', provider: 'Provider' },
    search: '搜索',
    searchPlaceholder: label => `搜索${label}`,
    clear: '清除',
    count: n => `${n} 条`,
    source: '来源',
    empty: label => `未发现${label}`,
    emptyBody: '当前 Provider 没有返回这一类 Skill。',
    noMatch: '没有匹配结果',
    noMatchBody: '换一个关键词，或清空搜索查看全部条目。',
    footnote: '发现证据',
    footnoteBody: '清单直接来自当前 Provider 在这个工作目录的发现结果，Scry 只读取、不改写 Skill 配置。',
    capabilityPending: '读取中…'
  },

  mcp: {
    title: 'MCP',
    summaryTitle: '信任报告',
    servers: n => `${n} servers`,
    refreshLive: '刷新 MCP 状态',
    scan: '扫描当前 MCP',
    scanBusy: '扫描中…',
    liveTitle: '运行时 MCP',
    liveSummary: n => (n ? `${n} live` : '无 live 状态'),
    liveEmpty: '当前 Provider 暂无逐项 live 状态；可发起会话或刷新后重试。',
    missingAuth: n => `${n} 个 MCP server 需要授权 · 按当前运行时处理`,
    policy: '策略状态',
    criticalHigh: '高危发现',
    policyBlocks: '阻断策略',
    auditHash: '审计哈希',
    findings: '风险发现',
    noFindings: '未发现风险项。',
    inventory: 'Fleet inventory',
    policyAudit: '策略与审计',
    notes: n => `${n} notes`,
    scanMode: '扫描模式',
    authPosture: '会话授权姿态',
    skipped: '跳过项',
    errors: '错误',
    dirty: '不是官方认证',
    severity: { critical: '严重', high: '高', warn: '警告', info: '提示' },
    decision: { allow: '允许', review: '待核对', block: '禁止' }
  },

  meta: {
    title: 'Meta Prompts',
    search: '搜索提示词',
    searchPlaceholder: '搜索标题或正文…',
    count: n => `${n} 条提示词`,
    matches: n => `${n} 条匹配`,
    copy: '复制提示词',
    copied: title => `已复制「${title}」`,
    chars: n => `${n} 字 · 纯文本`,
    insert: '放入输入框',
    inserted: '已放入首屏输入框',
    edit: '编辑提示词',
    remove: '删除提示词',
    loadError: '提示词库无法读取',
    loadErrorBody: '为避免覆盖原数据，当前不能编辑提示词。',
    retry: '重新读取',
    empty: '还没有提示词',
    emptyBody: '把第一条常用指令保存下来。',
    noMatch: '没有匹配的提示词',
    noMatchBody: '试试标题或正文中的关键词。'
  },

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
  panels: {
    analytics: {
      period: '10-01 – 10-21',
      cost: 'US$4.12',
      costEvidence: 'exact · 128 轮',
      composition: [
        { provider: 'codex', label: 'Codex', share: 0.62, cost: 'US$2.55' },
        { provider: 'claude', label: 'Claude', share: 0.28, cost: 'US$1.16' },
        { provider: 'qoder', label: 'Qoder', share: 0.10, cost: 'US$0.41' }
      ],
      series: {
        cost: [[0.18, 0.34, 0.22, 0.48, 0.26, 0.12, 0.3, 0.62, 0.44, 0.28, 0.52, 0.38, 0.24, 0.46],
                [0.08, 0.12, 0.3, 0.16, 0.1, 0.22, 0.14, 0.2, 0.34, 0.16, 0.12, 0.26, 0.18, 0.1],
                [0.04, 0.02, 0.06, 0.03, 0.08, 0.04, 0.02, 0.05, 0.07, 0.03, 0.06, 0.02, 0.04, 0.05]],
        tokens: [[0.4, 0.62, 0.38, 0.72, 0.5, 0.28, 0.58, 0.92, 0.7, 0.44, 0.8, 0.6, 0.42, 0.68],
                 [0.12, 0.2, 0.44, 0.26, 0.16, 0.36, 0.22, 0.3, 0.5, 0.24, 0.18, 0.4, 0.28, 0.16],
                 [0.06, 0.04, 0.1, 0.05, 0.12, 0.07, 0.03, 0.08, 0.11, 0.05, 0.09, 0.03, 0.06, 0.08]]
      },
      days: ['10-08', '10-15', '10-21'],
      metrics: [
        { label: '已处理 token', value: '1.82M', evidence: '128 / 128 轮有数据', known: true },
        { label: '缓存读取', value: '1.20M', evidence: '96 / 128 轮有数据', known: true },
        { label: '输入', value: '410K', evidence: '96 / 128 轮有数据', known: true },
        { label: '输出', value: '62.4K', evidence: '124 / 128 轮有数据', known: true },
        { label: '缓存写入', value: null, evidence: '主机未提供该字段', known: false }
      ],
      breakdownModel: [
        { key: 'codex:gpt-5-codex', provider: 'codex', label: 'gpt-5-codex', cost: 'US$2.96', share: '72%', token: '1.24M', approximate: false, lowerBound: false },
        { key: 'claude:sonnet-4.5', provider: 'claude', label: 'claude-sonnet-4.5', cost: '≈US$0.91', share: '22%', token: '512K', approximate: true, lowerBound: true },
        { key: 'qoder:qwen3-coder', provider: 'qoder', label: 'Qwen3 Coder', cost: 'US$0.25', share: '6%', token: '84K', approximate: false, lowerBound: false }
      ],
      breakdownDay: [
        { key: '10-20', label: '10-20', cost: 'US$0.94', share: '23%', token: '402K', approximate: false, lowerBound: false },
        { key: '10-19', label: '10-19', cost: 'US$0.72', share: '17%', token: '318K', approximate: false, lowerBound: false },
        { key: '10-18', label: '10-18', cost: 'US$0.41', share: '10%', token: '196K', approximate: false, lowerBound: true },
        { key: '10-17', label: '10-17', cost: '—', share: null, token: '—', approximate: false, lowerBound: false }
      ]
    },
    llm: {
      running: [
        {
          key: 'gpt-5-codex', model: 'gpt-5-codex', state: '生成中', streaming: true,
          sessions: [
            { key: 'r1', provider: 'Codex', cwd: '~/work/scry', state: '流式中' }
          ],
          speed: '42.0', speedUnit: 'tok/s', firstToken: '1.20', firstTokenUnit: 's',
          coverage: '1 个有速度 · 1 个有首字 · 共 1 个'
        }
      ],
      history: {
        range: '24 小时',
        speed: [[0.32, 0.44, 0.38, 0.52, 0.3, 0.46, 0.58, 0.4, 0.34, 0.5, 0.42, 0.36],
                [0.18, 0.24, 0.2, 0.28, 0.16, 0.22, 0.3, 0.19, 0.15, 0.26, 0.21, 0.17]],
        firstToken: [[0.6, 0.52, 0.66, 0.44, 0.58, 0.5, 0.4, 0.62, 0.7, 0.46, 0.54, 0.6],
                     [0.3, 0.36, 0.28, 0.42, 0.32, 0.38, 0.26, 0.34, 0.4, 0.3, 0.35, 0.28]],
        models: ['gpt-5-codex', 'claude-sonnet-4.5'],
        truncated: '只保留最近 240 条',
        ticks: ['-24h', '-12h', '现在'],
        comparison: [
          { model: 'gpt-5-codex', speed: '42.0', firstToken: '1.20', samples: '12' },
          { model: 'claude-sonnet-4.5', speed: '68.4', firstToken: '0.84', samples: '9' }
        ]
      }
    },
    skills: {
      provider: 'codex',
      scopes: [
        { id: 'project', count: 2 }, { id: 'user', count: 3 }, { id: 'provider', count: 0 }
      ],
      rows: [
        { name: 'scry-performance-climb', scope: 'project', description: '从日常性能记录定位真实慢点并维护性能门禁。', dir: '.agents/skills/scry-performance-climb' },
        { name: 'validate-scry-rate-workflow', scope: 'project', description: '对 rate-native Provider 执行真实 Scry 验收。', dir: '.agents/skills/validate-scry-rate-workflow' },
        { name: 'impeccable', scope: 'user', description: '设计、评审与打磨前端界面。', dir: '~/.claude/skills/impeccable' },
        { name: 'mobile-use', scope: 'user', description: '通过 mobile-mcp 操作真实手机。', dir: '~/.claude/skills/mobile-use' },
        { name: 'ponytail-audit', scope: 'user', description: '扫描整个仓库的过度设计。', dir: '~/.agents/skills/ponytail-audit' }
      ],
      shown: 2,
      total: 2
    },
    mcp: {
      servers: 3,
      live: [
        { name: 'filesystem', status: 'connected', label: '已连接', tools: 8, tone: 'ok' },
        { name: 'github', status: 'connected', label: '已连接', tools: 12, tone: 'ok' },
        { name: 'local-index', status: 'needs-auth', label: '需要认证', tools: null, tone: 'warn' }
      ],
      policy: { status: 'allow', label: '允许', tone: 'ok', criticalHigh: 0, policyBlocks: 0, auditHash: '8f3c…21ab' },
      labels: [
        { key: 'fingerprint', label: '指纹已记录', tone: 'ok' },
        { key: 'scope', label: '配置未越界', tone: 'ok' },
        { key: 'auth', label: '1 项待授权', tone: 'warn' }
      ],
      report: { id: 'scan-8821', rule: 'v12', who: 'local-only' },
      severityCounts: { critical: 0, high: 0, warn: 1, info: 2 },
      findings: [
        { id: 'f1', severity: 'warn', title: '配置引用了用户目录外的可执行文件', rule: 'mcp/exec-outside-scope', target: 'local-index', decision: 'review' }
      ],
      targets: [
        { id: 't1', name: 'filesystem', badge: 'clean', tone: 'ok', meta: 'stdio · project · 8 tools · env 2 · roots 3', path: '~/work/scry/.mcp.json', labels: [{ key: 'fp', label: '指纹已记录', tone: 'ok' }] },
        { id: 't2', name: 'local-index', badge: '1 warn', tone: 'warn', meta: 'stdio · user · 4 tools · env 3 · roots 1', path: '~/.claude.json', labels: [{ key: 'fp', label: '指纹变化', tone: 'warn' }] }
      ],
      audit: [
        { label: '扫描模式', value: 'static · offline · spec 2025-06-18' },
        { label: '会话授权姿态', value: 'needs-auth · missing 1' },
        { label: '跳过项', value: '0' },
        { label: '错误', value: '0' }
      ]
    },
    meta: {
      prompts: [
        { id: 'm1', title: '先写方案，再开始实现', body: '先给出方案与取舍，等我确认后再改代码。不要在一次回复里同时做设计和实现。' },
        { id: 'm2', title: '验收证据清单', body: '给我：改动的文件、运行的命令、结果、未验证项。不要用“应该可以”这类措辞。' },
        { id: 'm3', title: '性能改动的汇报格式', body: '说明这是 L1 计数下降还是 L2 毫秒下降，并指出减少的工作去了哪里。' }
      ],
      selected: 'm1'
    }
  },
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
