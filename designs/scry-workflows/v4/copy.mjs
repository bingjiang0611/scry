// All user-visible prototype text lives here (project copy rule).
export const copy = {
  title: 'Scry · Workflow v4 设计稿', brand: 'SCRY', heading: 'WORKFLOW',
  fixture: '设计稿 · 固定样例回放 · 未连接 Provider，不代表已实现',
  goal: '审计 src/routes 的鉴权逻辑，复核候选后修复并用检查确认',
  views: { run: '运行', plan: '计划确认', list: '管理', template: '模板编辑' },
  viewStatus: { plan: 'NEEDS APPROVAL', list: '5 RUNS', template: 'DRAFT' },
  status: { running: 'RUNNING', paused: 'PAUSED', stopping: 'STOP REQUESTED', stopped: 'STOPPED', completed: 'COMPLETED' },
  actions: { pause: '暂停调度', resume: '继续调度', stop: '停止', stopAgain: '再次停止', replay: '重新回放', step: '下一帧', play: '播放', freeze: '冻结回放' },

  program: {
    role: 'ORCHESTRATOR', model: 'Claude / opus',
    source: '来源', sourceValue: 'builtin:代码审计修复', revision: '模板修订', programRevision: '运行程序',
    size: '规模建议', sizeValue: 'medium <10 · 任务要求全部文件，已覆盖',
    entry: '入口', entryValue: '/scry-workflow run',
    lines: [
      { id: 'scan', depth: 0, text: 'map(files, item =>' },
      { id: 'scan', depth: 1, text: 'call scanner(item))' },
      { id: 'verify', depth: 0, text: 'map(candidates, c =>' },
      { id: 'verify', depth: 1, text: 'call verifier(c, 尝试推翻))' },
      { id: 'branch', depth: 0, text: 'branch(verdict)' },
      { id: 'branch', depth: 1, text: 'confirmed | refuted | unknown' },
      { id: 'loop', depth: 0, text: 'loop(≤3 轮, 两轮无进展停)' },
      { id: 'fix', depth: 1, text: 'call fixer(confirmed)' },
      { id: 'check', depth: 1, text: 'check npm run typecheck' },
      { id: 'return', depth: 0, text: 'return report' },
    ],
  },

  session: { title: 'Claude / opus · 主会话', waiting: '已启动工作流 · 只接收最终报告', done: '最终报告已返回 · 中间结果未进入主会话', stopped: '运行已停止 · 已有结果保留在面板' },
  runtime: {
    title: 'SCRY RUNTIME', slots: '共享槽位', slotsHint: '全部工作流共用 · 超出排队',
    budget: 'Agent 尝试', budgetHint: '根执行预算 · 只增不退',
    queued: '排队', checks: 'main 检查', checksHint: '占槽位，不计预算',
  },
  nodes: {
    scan: { title: 'scan', kind: 'map · 24 项', model: 'Claude / haiku', hint: '逐文件找候选' },
    verify: { title: 'verify', kind: 'map · 对抗复核', model: 'Claude / sonnet', hint: '新会话尝试推翻候选' },
    branch: { title: 'branch', kind: '按判定分流', model: '运行器 · 无模型', hint: 'unknown 不当 false' },
    fix: { title: 'fix', kind: 'call · 隔离副本', model: 'Claude / sonnet', hint: '只接收必要诊断' },
    check: { title: 'check', kind: 'main 检查步骤', model: 'npm run typecheck', hint: '退出码由 main 观测' },
    return: { title: 'return', kind: '最终报告', model: '运行器', hint: '只把报告交回主会话' },
  },
  loopTitle: iteration => `loop · 第 ${iteration}/3 轮`,
  loopIdle: 'loop · 等待分支结果',
  branchCounts: b => [`confirmed ${b.confirmed} → 修复`, `refuted ${b.refuted} → 记录`, `unknown ${b.unknown} → 未验证`],
  branchWaiting: '等待全部复核完成',
  progress: (done, total) => `${done} / ${total} 已结束`,
  queuedCount: n => `${n} 排队`,
  checkResult: c => c.outcome === 'pass' ? `第 ${c.iteration} 轮通过 · exit 0` : `第 ${c.iteration} 轮失败 · ${c.diagnostics} 个诊断`,
  returnDone: r => `扫描 ${r.scanned}/${r.total} · 确认 ${r.confirmed} · 推翻 ${r.refuted} · 未验证 ${r.unknown} · 补丁未应用`,
  returnWaiting: '等待 loop 退出',
  legend: { queued: '排队', running: '执行中', done: '已结束', stalled: '停滞后重启', cancelled: '已取消' },

  detail: {
    title: '任务详情', close: '收起', attempt: (a, max) => `attempt ${a}/${max}`, restartNote: '停滞 → 停止确认收敛 → 新会话重启；旧用量保留',
    item: i => `#${String(i).padStart(2, '0')}`, round: n => `第 ${n} 轮`, outcome: '结果', none: '—',
    outcomes: { candidate: '有候选', none: '无候选', confirmed: 'confirmed', refuted: 'refuted', unknown: 'unknown · 证据不足', patch: '候选补丁', pass: 'exit 0', fail: 'exit 2', limit_exceeded: '超出预算' },
    states: { queued: '排队', running: '执行中', stopping: '停止中', done: '已结束', stalled: '停滞', cancelled: '已取消' },
  },
  log: { title: 'SESSION LOG', source: '样例事件 · 回放时间已压缩', time: t => `t+${String(t).padStart(2, '0')}` },
  logText: {
    plan: e => `计划已确认 · 展开 ${e.count} 个扫描项`,
    dispatch: e => `派发 ${e.count} 个 · ${e.queued} 个等待槽位`,
    verdict: e => `#${e.item} 复核结论 ${e.outcome}`,
    branch: e => `分支：confirmed ${e.confirmed} / refuted ${e.refuted} / unknown ${e.unknown}`,
    iteration: e => `loop 第 ${e.iteration} 轮 · ${e.count} 个修复`,
    checkQueued: e => `第 ${e.iteration} 轮修复完成 · 排入 main 检查`,
    checkFail: e => `检查失败 · ${e.diagnostics} 个诊断 · 进入下一轮`,
    checkPass: () => '检查通过 · exit 0 · loop 退出',
    stalled: e => `#${e.item} 超过 stallMs（30 分钟）无输出 · 停止并等待收敛`,
    restart: e => `#${e.item} 重启为 attempt ${e.attempt}/6 · 预算 +1`,
    report: () => '最终报告交回主会话',
    paused: () => '暂停调度 · 在途任务继续',
    resumed: () => '继续调度',
    stopRequested: e => `停止请求 · 取消排队任务 · ${e.converging} 个等待退出`,
    stopResent: e => `再次停止 · 向 ${e.converging} 个未退出的 Agent 重发停止信号`,
    stopped: () => '全部作用域已收敛 · 运行已停止',
  },
  usage: '用量 / 费用：Provider 未报告',

  plan: {
    title: '确认运行此工作流', revision: 'programRevision r3 · 来自 builtin:代码审计修复',
    note: '确认只授权这一份程序快照。之后修改模型、范围或检查标准都要重新确认。',
    phases: '程序结构', roles: '角色与模型', checks: 'main 将执行的检查', limits: '限额与恢复', cost: '费用',
    phaseRows: [['map scan', '24 个文件', '24 次 Agent'], ['map verify', '每个候选一次', '≤ 24 次 Agent'], ['branch', '按判定分流', '不调用模型'], ['loop fix → check', '≤ 3 轮', '每轮 ≤ 候选数 + 1 次检查'], ['return', '最终报告', '不调用模型']],
    roleRows: [['编排', 'Claude · 默认配置 · opus'], ['扫描', 'Claude · 默认配置 · haiku'], ['复核', 'Claude · 默认配置 · sonnet'], ['修复', 'Claude · 默认配置 · sonnet']],
    checkHead: ['argv', 'cwd', '超时'],
    checkRows: [['["npm", "run", "typecheck"]', '. (隔离副本)', '10 分钟']],
    checkWarning: '将以本机用户权限执行仓库 package.json 定义的脚本。可执行文件：/opt/homebrew/bin/npm · sha256 3f9a…c21e',
    limitRows: [['并发', '共享槽位 16（按 CPU）'], ['Agent 尝试上限', '1000 / 根执行'], ['停滞自动重启', '开启 · 每调用最多 5 次'], ['写入', '只产出候选补丁，不应用']],
    size: '规模建议 medium（<10）。任务明确要求审计全部 24 个文件，计划已按任务覆盖建议。',
    costValue: '扫描 24 次；复核与修复随候选数变化，最多 120 次 Agent 调用（停滞重启另计）。按 Provider 计费，金额未知，不显示为 0。',
    confirm: '确认运行', source: '查看程序源码', edit: '修改本次计划', cancel: '取消',
  },

  list: {
    title: '/scry-workflow list', hint: '所有工作流共享 16 个槽位 · 关闭窗口继续运行，退出 App 会停止并保存',
    head: ['工作流', '会话', '状态', 'Agent', '预算', '操作'],
    rows: [
      { name: '鉴权审计修复', session: 'scry / routes', status: '运行中', tone: 'scan', agents: '14 执行 · 6 排队', budget: '37 / 1000', action: '打开' },
      { name: '批量迁移 fetch → client', session: 'web / api', status: '停止中 · 2 个 Agent 未退出', tone: 'warn', agents: '2 停止中', budget: '212 / 1000', action: '再次停止' },
      { name: '资料调研：本地向量库', session: 'notes', status: '已暂停', tone: 'dim', agents: '0 执行 · 14 排队', budget: '9 / 1000', action: '继续' },
      { name: '检查修复：类型错误', session: 'scry / main', status: '已停止 · 可按依赖恢复', tone: 'dim', agents: '18 完成复用 · 3 重跑', budget: '64 / 1000', action: '按依赖恢复' },
      { name: '多方案：缓存层', session: 'scry / perf', status: 'nothing_to_resume · 恢复记录缺失', tone: 'warn', agents: '—', budget: '—', action: '作为全新运行' },
    ],
    resumeNote: '按依赖恢复：输入与证据未变的已完成任务直接复用；变化节点及下游重跑；结果未知的调用不重发。',
    freshNote: '全新运行会建立新根执行，预算重新计数，需要重新确认。',
  },

  template: {
    title: '模板编辑', scopes: { builtin: '内置 · 只读', personal: '个人', project: '项目 · .scry-workflows/' },
    items: [
      { scope: 'builtin', name: '代码审计修复', id: 'builtin:code-audit-fix' },
      { scope: 'builtin', name: '资料调研', id: 'builtin:research' },
      { scope: 'personal', name: '代码审计修复', id: 'personal:t_7k2q', selected: true },
      { scope: 'project', name: '代码审计修复', id: 'project:t_m4xa' },
      { scope: 'project', name: '迁移 fetch', id: 'project:t_9bwe' },
    ],
    sameName: '同名模板来自三个来源，按来源区分，不互相遮蔽',
    draft: '草稿 5 · 基于修订 a41c…9e07', valid: '定义有效', runnable: '本次执行可用：需绑定“复核”角色的模型',
    sourceTab: '源码', structureTab: '结构',
    diffTitle: '与已保存修订的差异', diffRows: [
      { tone: 'warn', label: 'loop 上限', from: '3 轮', to: '5 轮' },
      { tone: 'warn', label: '复核模型', from: 'sonnet', to: 'opus' },
      { tone: 'scan', label: '新增 branch', from: '—', to: 'unknown → 二次复核' },
      { tone: 'dim', label: '显示名称', from: '代码审计修复', to: '鉴权审计修复' },
    ],
    agentTitle: '让 Agent 修改', agentPlaceholder: '例如：复核失败时增加一次二次复核',
    agentSend: '生成候选', agentNote: '设计稿不调用模型。实际发送前确认编排 Provider/模型与费用。', agentCost: '将发送当前定义与修改要求；单独计费，不附带运行记录',
    stale: '上一次返回的候选已过期 · 基于草稿 4，你已编辑到草稿 5。不会覆盖当前草稿。', staleMerge: '查看差异后手动合并',
    prototypeNote: '设计稿不写文件；实际保存会校验基线修订，冲突时保留草稿。',
    save: '保存新版', saveAs: '另存为…', runOnce: '仅本次使用', saveNote: '保存不启动任务；正在运行的实例继续使用旧快照。',
  },
}

export const templateSource = `{
  "schemaVersion": 1,
  "templateId": "t_7k2q",
  "name": "鉴权审计修复",
  "params": { "files": { "type": "glob", "default": "src/routes/**" } },
  "roles": {
    "scanner": { "prefer": "haiku" },
    "verifier": { "prefer": "opus" },
    "fixer": { "prefer": "sonnet" }
  },
  "program": [
    { "map": "params.files", "do": { "call": "scanner" } },
    { "map": "candidates", "do": { "call": "verifier", "intent": "refute" } },
    { "branch": "verdict", "unknown": { "call": "verifier", "pass": 2 } },
    { "loop": { "max": 5, "noProgress": 2 }, "do": [
      { "call": "fixer" },
      { "check": ["npm", "run", "typecheck"], "timeoutMs": 600000 }
    ] },
    { "return": "report" }
  ]
}`
