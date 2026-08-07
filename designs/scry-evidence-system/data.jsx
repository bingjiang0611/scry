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
    title: '优化 Analytics 叙事',
    state: 'complete',
    elapsed: '14m 32s',
    turns: [
      {
        id: 'turn-01', index: '01', state: 'complete', title: '盘点现有数据与视觉层级', duration: '2m 18s', tokens: '86.4k',
        summary: '确认 Analytics 数据足够，但 Top-N 查询口径与页面标题有三处错位。',
        evidence: [
          { id: 'ev-read', kind: 'tool', label: 'Read · 14 files', detail: 'AnalyticsView.tsx · span-ledger.ts', status: 'exact' },
          { id: 'ev-query', kind: 'finding', label: '3 个查询口径风险', detail: '工具 / 模型 / 项目', status: 'warning' }
        ]
      },
      {
        id: 'turn-02', index: '02', state: 'complete', title: '建立叙事原型与证据状态', duration: '8m 06s', tokens: '≥ 214k',
        summary: '把 30 天、Provider、工具延迟与风险盲区拆成四章；缺字段按下界展示。',
        evidence: [
          { id: 'ev-skill', kind: 'skill', label: 'baoyu-design', detail: 'Hi-fi prototype', status: 'exact' },
          { id: 'ev-browser', kind: 'mcp', label: 'Browser · 17 actions', detail: '4 chapters · console clean', status: 'exact' },
          { id: 'ev-usage', kind: 'usage', label: 'Token coverage 4/5', detail: '一轮缺 output', status: 'partial' }
        ]
      },
      {
        id: 'turn-03', index: '03', state: 'running', title: '扩展九表面统一系统', duration: '4m 08s', tokens: '未知',
        summary: '正在把相同证据语言迁移到工作台、诊断、拓扑和配置弹窗。',
        evidence: [
          { id: 'ev-agent', kind: 'agent', label: '3 个并行子任务', detail: 'data · inventory · core', status: 'running' },
          { id: 'ev-danger', kind: 'danger', label: 'Danger classification', detail: 'Codex 未支持', status: 'unsupported' }
        ]
      }
    ]
  },
  overview: {
    verdict: '工作完成度高，但本轮 Token 仍缺一段 Provider 结果。',
    verdictState: 'partial',
    metrics: [
      { label: 'TURNS', value: '3', state: 'exact', note: '当前会话' },
      { label: 'ELAPSED', value: '14m 32s', state: 'exact', note: '持续更新' },
      { label: 'TOKEN', value: '≥ 300k', state: 'partial', note: '2 / 3 轮完整' },
      { label: 'DANGER', value: '未支持', state: 'unsupported', note: 'Codex 能力边界' }
    ]
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
