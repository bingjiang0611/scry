const sampleData = {
  meta: {
    snapshot: '2026-08-07 18:24',
    source: '结构仿真 · 不连接 Provider / SQLite',
    workspace: 'scry',
    branch: 'codex/scry-editorial-ui',
    scope: '当前项目 · Claude Code'
  },
  providers: [
    { id: 'claude', name: 'Claude Code', short: 'CLAUDE', status: 'ready', model: 'Claude Opus 4.1', turns: 12, known: 12, tokens: 1438000, danger: 'classified' },
    { id: 'codex', name: 'Codex', short: 'CODEX', status: 'ready', model: 'GPT-5.6 Codex', turns: 9, known: 9, tokens: 984000, danger: 'unsupported' },
    { id: 'qoder', name: 'Qoder', short: 'QODER', status: 'degraded', model: 'Qoder Plus', turns: 7, known: 5, tokens: 611000, danger: 'classified' },
    { id: 'opencode', name: 'OpenCode', short: 'OPENCODE', status: 'unknown', model: '未上报', turns: 3, known: 2, tokens: 246000, danger: 'unsupported' }
  ],
  recent: [
    { title: '优化 Analytics 叙事', project: 'scry', provider: 'codex', time: '刚刚', state: 'complete' },
    { title: '验证 rate workflow', project: 'rate-native', provider: 'claude', time: '6 天', state: 'complete' },
    { title: '/rate-native-rate…', project: 'rate-native', provider: 'qoder', time: '1 周', state: 'cancelled' }
  ],
  chat: {
    sessionId: '019fdb67-9684-71e1-9209-029f74245020',
    cwd: '~/.treehouse/rate-native/7',
    provider: 'Codex',
    model: 'gpt-5.6-sol',
    turns: [
      {
        id: 'turn-01', index: '01', runId: 'run-rate-84441907-01', state: 'complete',
        user: '/rate-workflow 84441907', duration: '18m 24s', tokens: '5,711.8k tok', tools: 74, errors: 3,
        diff: { files: 3, label: '本轮改动', detail: '3 files · +48 −12' },
        hooks: [
          { label: 'SessionStart', detail: '1 handler · 238ms', status: 'passed' },
          { label: 'PostToolUse', detail: '14 logical runs · 2.1s', status: 'passed' }
        ],
        blocks: [
          { id: 't1-a1', kind: 'assistant', text: '先冻结 Scry、已安装 CLI 与 recorder 版本，再核对预热 treehouse 和 Provider 槽位。' },
          { id: 't1-skill', kind: 'skill', label: 'validate-scry-rate-workflow', detail: 'project skill · loaded', duration: '0.8s', status: 'passed' },
          { id: 't1-shell', kind: 'tool', label: 'Shell', detail: 'git status --short --branch', duration: '1.2s', status: 'passed', io: 'R' },
          { id: 't1-summary', kind: 'tool', label: 'Shell', detail: 'scry turns summary --provider codex', duration: '4.8s', status: 'failed', io: 'E', output: '首次读取时 session archive 尚未落盘；保留原始错误，不改写为 0。' },
          { id: 't1-a2', kind: 'assistant', text: '版本与源码边界已核对。下一步等待人工完成固定需求克隆，再继续两轮真实验收。' }
        ],
        footer: { input: '5,688.4k', output: '23.4k', cacheRead: '5,492.0k', api: '96.8s', files: 3 }
      },
      {
        id: 'turn-02', index: '02', runId: 'run-rate-84441907-02', state: 'complete',
        user: '继续，固定需求已经克隆完成。', duration: '27m 51s', tokens: '7,880.2k tok', tools: 88, errors: 5,
        diff: { files: 5, label: '本轮改动', detail: '5 files · +126 −34' },
        hooks: [
          { label: 'PreToolUse', detail: '18 logical runs · 1 cancelled', status: 'warning' },
          { label: 'Stop', detail: '1 handler · 412ms', status: 'passed' }
        ],
        blocks: [
          { id: 't2-a1', kind: 'assistant', text: '需求 ID 只读核验通过。现在启动隔离 Scry Test，发送严格两轮提示并逐项核对 archive、CLI records 与 Trace Agent Session。' },
          { id: 't2-mcp', kind: 'mcp', label: 'computer-use', detail: 'Inspect Scry Test · 24 calls', duration: '38.6s', status: 'passed' },
          { id: 't2-shell', kind: 'tool', label: 'Shell', detail: 'scry turns summary --session current', duration: '5.4s', status: 'passed', io: 'R', output: '2 turns · usage coverage 2/2 · archive present' },
          { id: 't2-a2', kind: 'assistant', text: '两轮验收完成：归档、真实 turn summary、右侧纵览与 MCP/Skill/Hook 证据均已对齐；运行中的 Scry Test 按验收约定保留。' }
        ],
        footer: { input: '7,850.1k', output: '30.1k', cacheRead: '7,701.2k', api: '121.4s', files: 5 }
      }
    ]
  },
  overview: {
    context: { pct: 25, model: 'gpt-5.6-sol', used: '65.6k', window: '258.4k', remaining: '192.8k', source: '最近一轮完整 prompt÷窗口' },
    verdict: '本会话 2 轮完成 · 8 处工具报错',
    verdictState: 'warning',
    metrics: [
      { label: '总 TOKEN', value: '13,592.0k', state: 'exact', note: '2 / 2 轮已捕获' },
      { label: '输入 / 输出', value: '13,592.0k', state: 'exact', note: 'in 13,538.5k · out 53.5k' },
      { label: '调用', value: '162', state: 'exact', note: '工具 129 · MCP 24 · Skill 9' },
      { label: '危险', value: '0', state: 'zero', note: '无' }
    ],
    cache: [
      { label: 'CACHE·R', value: '13,193.2k' },
      { label: 'CACHE·W', value: '0' },
      { label: 'API', value: '218.2s' }
    ],
    sessionId: '019fdb67-9684-71e1-9209-029f74245020',
    compactions: 0,
    turns: [
      { id: 'turn-01', index: '01', user: '/rate-workflow 84441907', duration: '18m 24s', groups: { intervention: 1, mcp: 8, skill: 4, agent: 0, hooks: 16, file: 3 }, detail: 'API 96.8s · 工具 74 次' },
      { id: 'turn-02', index: '02', user: '继续，固定需求已经克隆完成。', duration: '27m 51s', groups: { intervention: 0, mcp: 16, skill: 5, agent: 0, hooks: 21, file: 5 }, detail: 'API 121.4s · 工具 88 次' }
    ],
    tools: [
      { label: 'Shell', calls: 91, score: 100, errors: 6 },
      { label: 'Read', calls: 24, score: 26, errors: 0 },
      { label: 'computer-use', calls: 24, score: 26, errors: 2 },
      { label: 'Skill', calls: 9, score: 10, errors: 0 }
    ],
    hooks: { runs: 37, handlers: 41, passed: 39, cancelled: 1, failed: 1 },
    segments: [
      { label: 'validate-scry-rate-workflow', value: '2 turns', note: '启发式归属' },
      { label: 'baseline', value: '18 calls', note: '未归入 Skill' }
    ],
    calls: [
      { label: '工具', value: '129', note: '原始 TraceEvent' },
      { label: 'MCP', value: '24', note: '不拆分 Token' },
      { label: 'Skill', value: '9', note: '调用次数' },
      { label: '子 Agent', value: '0', note: '无独立 usage' }
    ],
    files: [
      { label: 'run-manifest.json', mode: 'W', count: 4 },
      { label: 'session-summary.md', mode: 'R/W', count: 3 },
      { label: 'provider-evidence.jsonl', mode: '~R', count: 2 }
    ],
    billing: {
      status: 'Token 统计', source: '本会话可验证 token', policy: '仅看 token，不算金额',
      metrics: [
        { label: '总 TOKEN', value: '13,592.0k' },
        { label: '输入 / 输出', value: '13,538.5k / 53.5k' },
        { label: '缓存读 / 写', value: '13,193.2k / 0' },
        { label: 'API 耗时', value: '218.2s' }
      ],
      coverage: ['轮次覆盖 2/2 · 100%', '模型明细 100%', '工具拆分 暂无独立 token'],
      signals: [
        { severity: 'warning', title: 'T02 Token 高于本会话均值', detail: '7,880.2k tok · 规则提示' },
        { severity: 'warning', title: '8 处工具错误需要复核', detail: '不是模型结论' }
      ],
      turns: [
        { id: 'turn-02', index: '02', total: '7,880.2k', cache: '97.7%', io: '7,850.1k / 30.1k', tools: 88, context: '25%' },
        { id: 'turn-01', index: '01', total: '5,711.8k', cache: '96.6%', io: '5,688.4k / 23.4k', tools: 74, context: '18%' }
      ]
    },
    trust: {
      provider: 'Codex', status: '等待报告', reason: '当前 Provider 暂未接通 MCP Guard 扫描。',
      live: [
        { label: 'notion', status: 'needs-auth', detail: '需要认证' },
        { label: 'filesystem', status: 'failed', detail: '启动失败' }
      ]
    }
  },
  diagnostics: {
    verdict: '本机可工作；1 个认证阻塞与 2 个观测盲区需要处理。',
    issues: [
      { id: 'oauth', severity: 'error', title: 'Notion MCP 需要客户端注册', detail: 'needs-client-registration', action: '配置客户端' },
      { id: 'coverage', severity: 'warning', title: 'Qoder Token 覆盖不完整', detail: '5 / 7 turns known', action: '查看证据' },
      { id: 'danger', severity: 'unsupported', title: 'Codex danger 分类未支持', detail: '不能解释为 0', action: '了解范围' }
    ]
  },
  skillsSummary: [
    { id: 'baoyu-design', name: 'baoyu-design', scope: 'project', source: '.claude/skills', enabled: true, status: 'ready', detail: '高保真 HTML 设计原型' },
    { id: 'emil-design-eng', name: 'emil-design-eng', scope: 'project', source: '.claude/skills', enabled: true, status: 'ready', detail: 'UI polish 与动效判断' },
    { id: 'scry-provider-regression', name: 'scry-provider-regression', scope: 'project', source: '.claude/skills', enabled: false, status: 'ready', detail: '四 Provider L3 回归' },
    { id: 'openai-docs', name: 'openai-docs', scope: 'user', source: '~/.codex/skills', enabled: true, status: 'ready', detail: 'OpenAI 官方文档' },
    { id: 'legacy-export', name: 'legacy-export', scope: 'user', source: '~/.claude/skills', enabled: false, status: 'error', detail: 'SKILL.md 解析失败' }
  ],
  mcpSummary: [
    { id: 'browser', name: 'browser', scope: 'project', configured: true, runtime: 'connected', test: 'passed', auth: 'verified', tools: 12, latency: '1.2s' },
    { id: 'github', name: 'github', scope: 'user', configured: true, runtime: 'connected', test: 'unknown', auth: 'verified', tools: 8, latency: '—' },
    { id: 'notion', name: 'notion', scope: 'project', configured: true, runtime: 'blocked', test: 'failed', auth: 'needs-client-registration', tools: null, latency: '—' },
    { id: 'filesystem', name: 'filesystem', scope: 'project', configured: false, runtime: 'disabled', test: 'unsupported', auth: 'none', tools: 5, latency: '0.3s' }
  ],
  graph: {
    session: { id: 'session-8f31', label: '优化 Analytics 叙事', duration: '14m 32s', status: 'running' },
    lanes: [
      { id: 'turn-01', label: 'T01 · 盘点', duration: '2m 18s', status: 'complete', nodes: [
        { id: 'request-01', type: 'llm', label: 'LLM request', value: '42.6k', status: 'exact' },
        { id: 'read-01', type: 'tool', label: 'Read ×14', value: '8.4s', status: 'exact' },
        { id: 'finding-01', type: 'event', label: '3 findings', value: 'exact', status: 'warning' }
      ]},
      { id: 'turn-02', label: 'T02 · 原型', duration: '8m 06s', status: 'complete', nodes: [
        { id: 'skill-02', type: 'skill', label: 'baoyu-design', value: 'loaded', status: 'exact' },
        { id: 'browser-02', type: 'mcp', label: 'browser ×17', value: '1.2s P50', status: 'exact' },
        { id: 'usage-02', type: 'llm', label: 'LLM result', value: '≥ 214k', status: 'partial' }
      ]},
      { id: 'turn-03', label: 'T03 · 九表面', duration: '4m 08s', status: 'running', nodes: [
        { id: 'agents-03', type: 'agent', label: 'Agents ×3', value: 'running', status: 'running' },
        { id: 'danger-03', type: 'event', label: 'Danger audit', value: 'unsupported', status: 'unsupported' }
      ]}
    ]
  },
  segments: [
    { id: 'baseline', label: 'Baseline', kind: 'baseline', turns: 'T01', duration: 138, tokens: 86400, coverage: '1 / 1', status: 'exact', note: '普通模型与工具活动' },
    { id: 'skill', label: 'baoyu-design', kind: 'skill', turns: 'T02', duration: 486, tokens: 214000, coverage: '4 / 5', status: 'partial', note: '启发式归属；Token 为已知下界' },
    { id: 'mcp', label: 'Browser MCP', kind: 'mcp', turns: 'T02', duration: 79, tokens: null, coverage: 'unsupported', status: 'unsupported', note: 'MCP 无独立 Token 归因' },
    { id: 'running', label: 'Implementation', kind: 'baseline', turns: 'T03', duration: 248, tokens: null, coverage: '0 / 1', status: 'running', note: '执行中；结果尚未落盘' }
  ],
  analytics: {
    totalKnown: 3521000,
    turns: 31,
    knownTurns: 28,
    activeDays: 23,
    days: [
      0,86,134,0,72,148,215,96,0,62,187,242,119,84,0,158,302,226,107,64,0,193,274,316,168,0,138,249,211,92
    ].map((value, index) => ({
      id: `day-${index + 1}`,
      label: index < 23 ? `07-${String(index + 9).padStart(2, '0')}` : `08-${String(index - 22).padStart(2, '0')}`,
      value,
      status: index >= 26 && index % 2 === 0 ? 'partial' : value === 0 ? 'zero' : 'exact',
      turns: value === 0 ? 0 : index > 21 ? 2 : 1
    })),
    tools: [
      { label: 'Bash', calls: 58, avg: '3.4s', errors: 2 },
      { label: 'Read', calls: 44, avg: '0.6s', errors: 0 },
      { label: 'Grep', calls: 31, avg: '0.4s', errors: 0 },
      { label: 'Edit', calls: 18, avg: '1.1s', errors: 1 },
      { label: 'browser MCP', calls: 14, avg: '4.8s', errors: 1 }
    ],
    riskDays: Array.from({ length: 90 }, (_, index) => ({
      id: `risk-${index}`,
      level: [7, 18, 44, 63, 86].includes(index) ? 'warn' : [31, 77].includes(index) ? 'danger' : 'zero'
    }))
  }
}

Object.assign(window, { sampleData })
