;(() => {
  const { useMemo, useState } = React

  const PROVIDERS = [
    { id: 'claude', label: 'Claude Code', short: 'CLAUDE', turns: 12, known: 12, tokens: 1540, cache: '81.4%', danger: 'classified', dangerText: '1 danger · 3 warn' },
    { id: 'codex', label: 'Codex', short: 'CODEX', turns: 9, known: 9, tokens: 1080, cache: '62.1%', danger: 'unsupported', dangerText: '未支持分类' },
    { id: 'qoder', label: 'Qoder', short: 'QODER', turns: 7, known: 5, tokens: 930, cache: null, danger: 'classified', dangerText: '1 danger · 3 warn' },
    { id: 'opencode', label: 'OpenCode', short: 'OPENCODE', turns: 3, known: 2, tokens: 410, cache: null, danger: 'unsupported', dangerText: '未支持分类' }
  ]

  const ACTIVE_DAYS = [
    { day: '07-10', amount: 86, status: 'exact', provider: 'codex' },
    { day: '07-13', amount: 72, status: 'exact', provider: 'qoder' },
    { day: '07-15', amount: 215, status: 'exact', provider: 'codex' },
    { day: '07-20', amount: 242, status: 'exact', provider: 'claude' },
    { day: '07-25', amount: 302, status: 'exact', provider: 'codex' },
    { day: '07-31', amount: 274, status: 'exact', provider: 'codex' },
    { day: '08-01', amount: 316, status: 'exact', provider: 'claude' },
    { day: '08-02', amount: 168, status: 'exact', provider: 'qoder' },
    { day: '08-04', amount: 138, status: 'lowerBound', provider: 'qoder' },
    { day: '08-05', amount: 249, status: 'exact', provider: 'claude' },
    { day: '08-06', amount: 211, status: 'lowerBound', provider: 'codex' },
    { day: '08-07', amount: 92, status: 'lowerBound', provider: 'opencode' }
  ]

  const TOOLS = [
    { name: 'Bash', provider: 'claude', calls: 58, avg: '3.4s', failures: 2 },
    { name: 'Read', provider: 'codex', calls: 44, avg: '0.6s', failures: 0 },
    { name: 'Grep', provider: 'qoder', calls: 31, avg: '0.4s', failures: 0 },
    { name: 'Edit', provider: 'codex', calls: 18, avg: '1.1s', failures: 1 },
    { name: 'mcp__browser', provider: 'claude', calls: 14, avg: '4.8s', failures: 1 },
    { name: 'Skill', provider: 'qoder', calls: 9, avg: '0.2s', failures: 0 }
  ]

  const DIAGNOSTIC_ISSUES = [
    {
      id: 'coverage',
      severity: 'warn',
      title: '3 个轮次缺少完整 Token 字段',
      summary: 'Qoder 2 轮、OpenCode 1 轮仅能给出已知下界。',
      verdict: 'partial',
      value: '28 / 31',
      evidence: [
        ['08-07 14:32', 'OpenCode · turn 31', 'input_tokens 未上报', 'partial'],
        ['08-06 18:09', 'Codex · turn 29', 'cache_read_tokens 未上报', 'partial'],
        ['08-04 11:20', 'Qoder · turn 26', 'output_tokens 未上报', 'partial']
      ],
      action: '按 Provider 原始 record 核验缺字段；汇总继续显示下界。'
    },
    {
      id: 'danger',
      severity: 'unknown',
      title: '2 个 Provider 不支持危险操作分类',
      summary: 'Codex 与 OpenCode 的空白不能解释为“零危险”。',
      verdict: 'unsupported',
      value: '2 / 4',
      evidence: [
        ['能力矩阵', 'Codex', 'danger verdict：unsupported', 'unsupported'],
        ['能力矩阵', 'OpenCode', 'danger verdict：unsupported', 'unsupported'],
        ['能力矩阵', 'Claude Code / Qoder', '分类可用', 'exact']
      ],
      action: '保持 capability 盲区标签；不要纳入跨 Provider 安全排名。'
    },
    {
      id: 'mcp',
      severity: 'clear',
      title: 'MCP 失败率处于可接受范围',
      summary: '38 次已完成调用中 1 次失败，未见连续退化。',
      verdict: 'exact',
      value: '2.6%',
      evidence: [
        ['08-06 19:44', 'browser', 'P95 4.8s · 1 failure', 'warn'],
        ['近 90 天', 'github', '12 calls · 0 failure', 'trueZero'],
        ['近 90 天', 'filesystem', '8 calls · 0 failure', 'trueZero']
      ],
      action: '无需处置；browser P95 超过 6s 时再升级为问题。'
    },
    {
      id: 'archive',
      severity: 'clear',
      title: '会话归档结构完整',
      summary: '7 个归档均具备 session、turn 与 span 关联。',
      verdict: 'exact',
      value: '7 / 7',
      evidence: [
        ['结构检查', 'session → turn', '31/31 可关联', 'exact'],
        ['结构检查', 'turn → span', '184/184 可关联', 'exact'],
        ['结构检查', '孤立 span', '0 · 已验证', 'trueZero']
      ],
      action: '无需处置。'
    }
  ]

  const GRAPH_SESSIONS = [
    {
      id: 's-claude',
      label: 'Claude Code · hello',
      provider: 'claude',
      time: '14:02—14:09',
      nodes: [
        { id: 'n1', kind: 'prompt', label: '用户提示', detail: '优化 Analytics 的数据叙事', duration: '0ms', status: 'exact', tokens: '—', source: 'session record' },
        { id: 'n2', kind: 'model', label: '分析与规划', detail: '读取现有视图与查询口径', duration: '43.2s', status: 'exact', tokens: '18.4k', source: 'provider result' },
        { id: 'n3', kind: 'tool', label: 'Read × 6', detail: '读取组件、样式与数据库查询', duration: '3.8s', status: 'exact', tokens: '不适用', source: 'tool spans' },
        { id: 'n4', kind: 'tool', label: 'browser', detail: '检查参考站与本地原型', duration: '4.8s', status: 'warn', tokens: '不适用', source: 'MCP span' },
        { id: 'n5', kind: 'model', label: '最终回复', detail: '交付原型与验证结果', duration: '12.6s', status: 'partial', tokens: '≥ 6.2k', source: 'provider result · partial' }
      ]
    },
    {
      id: 's-codex',
      label: 'Codex · UI refresh',
      provider: 'codex',
      time: '14:11—14:18',
      nodes: [
        { id: 'n6', kind: 'prompt', label: '跟进指令', detail: '统一优化所有分析表面', duration: '0ms', status: 'exact', tokens: '—', source: 'session record' },
        { id: 'n7', kind: 'model', label: '代码实施', detail: '生成共享视觉系统', duration: '5m 14s', status: 'exact', tokens: '22.1k', source: 'provider result' },
        { id: 'n8', kind: 'tool', label: 'Edit × 18', detail: '更新原型组件与样式', duration: '19.8s', status: 'exact', tokens: '不适用', source: 'tool spans' },
        { id: 'n9', kind: 'result', label: '构建通过', detail: '静态预览无控制台错误', duration: '8.4s', status: 'trueZero', tokens: '0 errors', source: 'browser console' }
      ]
    },
    {
      id: 's-qoder',
      label: 'Qoder · provider test',
      provider: 'qoder',
      time: '14:22—14:27',
      nodes: [
        { id: 'n10', kind: 'prompt', label: '回归提示', detail: '验证 Provider usage 与恢复', duration: '0ms', status: 'exact', tokens: '—', source: 'session record' },
        { id: 'n11', kind: 'model', label: '执行中断', detail: '上游未返回完整 usage', duration: '4m 02s', status: 'partial', tokens: '≥ 13.8k', source: 'provider result · partial' },
        { id: 'n12', kind: 'result', label: '分类能力', detail: 'danger verdict 可用', duration: '—', status: 'exact', tokens: '不适用', source: 'adapter capability' }
      ]
    }
  ]

  const SEGMENTS = [
    { id: 'seg-1', index: '01', label: '理解请求', kind: 'model', provider: 'claude', start: '14:02:11', durationMs: 43200, token: '18.4k', status: 'exact', tools: 0, failures: 0, note: '读取请求并建立执行计划。' },
    { id: 'seg-2', index: '02', label: '读取上下文', kind: 'tool', provider: 'claude', start: '14:02:54', durationMs: 8600, token: '不适用', status: 'exact', tools: 8, failures: 0, note: '读取 8 个工作区文件；无失败。' },
    { id: 'seg-3', index: '03', label: '参考审计', kind: 'mcp', provider: 'claude', start: '14:03:03', durationMs: 12600, token: '不适用', status: 'warn', tools: 3, failures: 1, note: 'browser P95 较高；一次失败后恢复。' },
    { id: 'seg-4', index: '04', label: '界面实施', kind: 'model', provider: 'codex', start: '14:03:16', durationMs: 314000, token: '22.1k', status: 'exact', tools: 18, failures: 0, note: '完成共享视觉系统与九个表面。' },
    { id: 'seg-5', index: '05', label: 'Provider 回补', kind: 'model', provider: 'qoder', start: '14:08:30', durationMs: 242000, token: '≥ 13.8k', status: 'partial', tools: 4, failures: 0, note: 'usage 缺字段；Token 仅为已知下界。' },
    { id: 'seg-6', index: '06', label: '静态验证', kind: 'result', provider: 'codex', start: '14:12:32', durationMs: 8400, token: '不适用', status: 'trueZero', tools: 2, failures: 0, note: '构建与浏览器控制台均为 0 error。' }
  ]

  function getSample(key, fallback) {
    return window.sampleData?.dataSurfaces?.[key] || fallback
  }

  function stateLabel(state) {
    return {
      exact: '精确值',
      classified: '已分类',
      lowerBound: '已知下界',
      partial: '部分数据',
      unknown: '未知',
      unsupported: '未支持',
      trueZero: '真实 0',
      notApplicable: '不适用',
      warn: '需关注',
      error: '读取失败'
    }[state] || state
  }

  function DataViewHeader(props) {
    const Component = window.ViewHeader
    if (Component) return <Component {...props} />
    return (
      <header className="view-header">
        <span>{props.eyebrow}</span>
        <h1>{props.title}</h1>
        <p>{props.summary}</p>
      </header>
    )
  }

  function DataSectionTitle(props) {
    const Component = window.SectionTitle
    if (Component) return <Component {...props} />
    return <div className="section-title"><span>{props.index}</span><h2>{props.title}</h2><small>{props.meta}</small></div>
  }

  function DataStatus({ status, label }) {
    const Component = window.StatusMark
    if (Component) return <Component status={status} label={label || stateLabel(status)} />
    return <span className={`status-mark status-${status}`}>{label || stateLabel(status)}</span>
  }

  function DataKnown({ value, state = 'exact', suffix = '', className = '' }) {
    return (
      <span className={`known-value known-${state} ${className}`} data-state={state} title={stateLabel(state)}>
        <b>{state === 'unknown' || state === 'unsupported' ? '—' : value}</b>{suffix && <small>{suffix}</small>}
      </span>
    )
  }

  function DataEvidenceRow({ label, value, state = 'exact', note, onClick, active = false }) {
    const Component = window.EvidenceRow
    if (Component && !onClick) return <Component label={label} value={value} state={state} note={note} />
    const Tag = onClick ? 'button' : 'div'
    return (
      <Tag type={onClick ? 'button' : undefined} className={`evidence-row ${active ? 'active' : ''}`} onClick={onClick}>
        <span>{label}</span><i></i><DataKnown value={value} state={state} />{note && <small>{note}</small>}
      </Tag>
    )
  }

  function SampleSource({ children = '结构仿真 · 不连接 Provider / SQLite' }) {
    return <div className="sample-source"><span>示例数据</span><i></i><b>{children}</b></div>
  }

  function SemanticLegend() {
    return (
      <div className="semantic-legend" aria-label="数据状态图例">
        <DataStatus status="exact" label="精确" />
        <DataStatus status="lowerBound" label="下界 ≥" />
        <DataStatus status="unknown" label="未知" />
        <DataStatus status="unsupported" label="未支持" />
        <DataStatus status="trueZero" label="真实 0" />
      </div>
    )
  }

  function SurfaceState({ kind, noun }) {
    if (kind === 'empty') {
      return (
        <div className="surface-state surface-empty">
          <span className="state-code">TRUE ZERO</span>
          <h2>这个时间范围内没有{noun}</h2>
          <p>这是查询成功后的真实 0，不是未知值。改变时间范围或开始一次会话后再查看。</p>
          <DataKnown value="0" state="trueZero" suffix={` ${noun}`} />
        </div>
      )
    }
    if (kind === 'error') {
      return (
        <div className="surface-state surface-error">
          <span className="state-code">SOURCE ERROR</span>
          <h2>无法读取{noun}</h2>
          <p>SQLite 查询没有返回可验证结果；界面不会把读取失败替换为 0。</p>
          <DataKnown value="—" state="unknown" />
          <button type="button" className="secondary-action">重新读取</button>
        </div>
      )
    }
    return null
  }

  function AnalyticsField({ selectedProvider, onProvider }) {
    const days = getSample('analyticsDays', ACTIVE_DAYS)
    const [selectedDay, setSelectedDay] = useState(days[days.length - 1]?.day || '')
    const max = Math.max(...days.map((day) => day.amount), 1)
    const current = days.find((day) => day.day === selectedDay) || days[0]
    return (
      <div className="analytics-chapter-grid">
        <article className="story-lead">
          <span className="chapter-code">00 · THE FIELD</span>
          <DataStatus status="lowerBound" label="近 30 天 · 已知下界" />
          <DataKnown value="3.96M" state="lowerBound" suffix=" 已知 Token" className="story-number" />
          <h2>Token 没有均匀发生：三个高峰日承载了 23% 的已知量。</h2>
          <p>每一列是活跃日，长度仅编码已上报 Token。斜纹表示该日存在缺字段轮次；保留已知量，但不伪装成完整总量。</p>
          <div className="metric-strip">
            <span><b>24</b><small>活跃日</small></span>
            <span><b>31</b><small>轮次</small></span>
            <span><b>28/31</b><small>完整</small></span>
          </div>
          <SampleSource />
        </article>
        <div className="analytics-visual field-panel">
          <div className="visual-meta"><span>OBSERVED TOKEN · ACTIVE DAYS</span><span>点击日期查看证据</span></div>
          <div className="day-field" role="list" aria-label="近 30 天已知 Token">
            {days.map((day) => {
              const active = day.day === selectedDay
              const dimmed = selectedProvider && day.provider !== selectedProvider
              return (
                <button
                  type="button"
                  key={day.day}
                  className={`day-column provider-${day.provider} state-${day.status} ${active ? 'active' : ''} ${dimmed ? 'dimmed' : ''}`}
                  onClick={() => setSelectedDay(day.day)}
                  aria-pressed={active}
                  aria-label={`${day.day}，${day.status === 'lowerBound' ? '至少' : ''}${day.amount}k Token`}
                >
                  <span className="day-bar"><i style={{ height: `${Math.max(8, (day.amount / max) * 100)}%` }}></i></span>
                  <time>{day.day}</time>
                </button>
              )
            })}
          </div>
          {current && (
            <div className="evidence-ledger day-evidence">
              <header><b>{current.day}</b><DataStatus status={current.status} /></header>
              <DataEvidenceRow label="OBSERVED TOKEN" value={`${current.status === 'lowerBound' ? '≥ ' : ''}${current.amount}k`} state={current.status} />
              <DataEvidenceRow label="PROVIDER" value={current.provider.toUpperCase()} />
              <DataEvidenceRow label="INTERPRETATION" value={current.status === 'lowerBound' ? '缺字段，不参与精确环比' : 'Provider 字段完整'} state={current.status} />
            </div>
          )}
          <div className="provider-picks" aria-label="Provider 高亮">
            {PROVIDERS.map((provider) => (
              <button type="button" key={provider.id} className={selectedProvider === provider.id ? 'active' : ''} onClick={() => onProvider(selectedProvider === provider.id ? null : provider.id)}>
                <i className={`provider-dot provider-${provider.id}`}></i>{provider.short}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  function AnalyticsCoverage({ selectedProvider, onProvider }) {
    const providers = getSample('providers', PROVIDERS)
    const max = Math.max(...providers.map((provider) => provider.tokens), 1)
    const selected = providers.find((provider) => provider.id === selectedProvider)
    return (
      <div className="analytics-chapter-grid">
        <article className="story-lead">
          <span className="chapter-code">01 · COVERAGE</span>
          <DataStatus status="partial" label="近 30 天 · 证据优先" />
          <div className="ratio-number story-number"><b>28</b><span>/31</span></div>
          <small className="story-unit">轮次具备完整 Token</small>
          <h2>覆盖度先于排名；不完整的总量只能是下界。</h2>
          <p>颜色只表示 Provider 类别，长度只表示已知 Token。选中状态使用青色轮廓，不复用为数据色。</p>
          <SampleSource>Provider coverage · 结构仿真</SampleSource>
        </article>
        <div className="analytics-visual provider-panel">
          <div className="provider-table-head"><span>PROVIDER</span><span>KNOWN</span><span>OBSERVED TOKEN</span><span>CAPABILITY</span></div>
          <div className="provider-ladder">
            {providers.map((provider, index) => {
              const partial = provider.known < provider.turns
              return (
                <button type="button" key={provider.id} className={`provider-row ${selectedProvider === provider.id ? 'active' : ''}`} onClick={() => onProvider(selectedProvider === provider.id ? null : provider.id)}>
                  <span className="provider-rank">0{index + 1}</span>
                  <span className="provider-name"><i className={`provider-dot provider-${provider.id}`}></i><b>{provider.label}</b><small>{provider.short}</small></span>
                  <span className="provider-known"><b>{provider.known}/{provider.turns}</b><i><em style={{ width: `${(provider.known / provider.turns) * 100}%` }}></em></i></span>
                  <span className="provider-volume"><DataKnown value={`${partial ? '≥ ' : ''}${(provider.tokens / 1000).toFixed(2)}M`} state={partial ? 'lowerBound' : 'exact'} /><i><em className={`provider-${provider.id}`} style={{ width: `${(provider.tokens / max) * 100}%` }}></em></i></span>
                  <DataStatus status={provider.danger} />
                </button>
              )
            })}
          </div>
          <div className={`selection-ledger ${selected ? '' : 'is-empty'}`}>
            {selected ? (
              <>
                <header><i className={`provider-dot provider-${selected.id}`}></i><b>{selected.label}</b></header>
                <DataEvidenceRow label="TOKEN COVERAGE" value={`${selected.known}/${selected.turns} turns`} state={selected.known < selected.turns ? 'partial' : 'exact'} />
                <DataEvidenceRow label="CACHE REUSE" value={selected.cache || '—'} state={selected.cache ? 'exact' : 'unknown'} note={selected.cache ? 'Provider 字段可比' : '分母或上游字段未知'} />
                <DataEvidenceRow label="DANGER" value={selected.danger === 'classified' ? selected.dangerText : '—'} state={selected.danger} note={selected.danger === 'unsupported' ? '未支持不等于安全' : '已分类 · 审计不拦截'} />
              </>
            ) : <p>选择一个 Provider 查看覆盖、缓存口径与能力盲区。</p>}
          </div>
        </div>
      </div>
    )
  }

  function AnalyticsOperations({ selectedProvider }) {
    const allTools = getSample('tools', TOOLS)
    const filtered = selectedProvider ? allTools.filter((tool) => tool.provider === selectedProvider) : allTools
    const tools = filtered.length ? filtered : allTools
    const max = Math.max(...tools.map((tool) => tool.calls), 1)
    const top = [...tools].sort((a, b) => b.calls - a.calls)[0]
    return (
      <div className="analytics-chapter-grid">
        <article className="story-lead">
          <span className="chapter-code">02 · OPERATIONS</span>
          <DataStatus status="exact" label="全时段 · 调用次数排序" />
          <DataKnown value={String(top.calls)} state="exact" suffix={` ${top.name} calls`} className="story-number" />
          <h2>{top.name} 是{selectedProvider ? ` ${selectedProvider.toUpperCase()} 样本` : '全 Provider 样本'}中调用最多的一类。</h2>
          <p>条长只编码调用次数；耗时与失败数是精确旁注。没有 tool-level Token 归因，因此不制造 Token 份额。</p>
          <SampleSource>tool spans · completed duration</SampleSource>
        </article>
        <div className="analytics-visual operations-panel">
          <div className="tool-table-head"><span>TOOL</span><span>CALLS</span><span>AVG</span><span>FAIL</span></div>
          <div className="tool-ranking">
            {tools.map((tool, index) => (
              <div className="tool-row" key={tool.name}>
                <span className="tool-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="tool-name"><b>{tool.name}</b><small>{tool.provider}</small></span>
                <span className="tool-bar"><i style={{ width: `${(tool.calls / max) * 100}%` }}></i></span>
                <b>{tool.calls}</b><span>{tool.avg}</span>
                <DataKnown value={String(tool.failures)} state={tool.failures === 0 ? 'trueZero' : 'exact'} />
              </div>
            ))}
          </div>
          <div className="latency-ledger">
            <DataSectionTitle index="MCP" title="完成调用延迟" meta="近 90 天" />
            <DataEvidenceRow label="browser" value="P50 1.2s · P95 4.8s · 1 fail" state="warn" />
            <DataEvidenceRow label="github" value="P50 0.8s · P95 2.4s · 0 fail" state="trueZero" />
            <DataEvidenceRow label="filesystem" value="P50 0.3s · P95 0.9s · 0 fail" state="trueZero" />
            <p>仅统计已完成调用；失败数不折算为延迟。</p>
          </div>
        </div>
      </div>
    )
  }

  function AnalyticsRisk({ selectedProvider, onProvider }) {
    const provider = PROVIDERS.find((item) => item.id === selectedProvider)
    const supported = !provider || provider.danger === 'classified'
    const cells = Array.from({ length: 90 }, (_, index) => {
      const events = { 7: 'warn', 18: 'warn', 31: 'danger', 44: 'warn', 63: 'warn', 77: 'danger', 86: 'warn' }
      return { index, status: events[index] || 'trueZero' }
    })
    return (
      <div className="analytics-chapter-grid">
        <article className="story-lead">
          <span className="chapter-code">03 · RISK</span>
          <DataStatus status={supported ? 'exact' : 'unsupported'} label={supported ? '近 90 天 · 观测不拦截' : `${provider.label} · 分类未支持`} />
          <DataKnown value={supported ? '2' : '—'} state={supported ? 'exact' : 'unsupported'} suffix={supported ? ' danger · 6 warn' : ''} className="story-number" />
          <h2>{supported ? '危险事件很稀疏；能力盲区却不能被画成安全。' : `${provider.label} 没有分类能力，不能得出“零危险”。`}</h2>
          <p>红色与黄色只表示已分类事件。空格是“可分类范围内无事件”；unsupported 另列说明，不与真实 0 混为一谈。</p>
          <SampleSource>danger verdict · provider capability</SampleSource>
        </article>
        <div className="analytics-visual risk-panel">
          <div className="visual-meta"><span>90 DAYS · MAY 10 — AUG 07</span><span>{provider ? provider.short : 'ALL CLASSIFIED EVENTS'}</span></div>
          <div className={`risk-grid ${supported ? '' : 'unsupported'}`} aria-label="近 90 天危险操作矩阵">
            {cells.map((cell) => <i key={cell.index} className={`risk-cell state-${supported ? cell.status : 'unsupported'}`} title={`Day ${cell.index + 1} · ${supported ? stateLabel(cell.status) : '未支持分类'}`}></i>)}
          </div>
          <SemanticLegend />
          <div className="capability-ledger">
            {PROVIDERS.map((item) => (
              <button type="button" key={item.id} className={selectedProvider === item.id ? 'active' : ''} onClick={() => onProvider(selectedProvider === item.id ? null : item.id)}>
                <span><i className={`provider-dot provider-${item.id}`}></i>{item.label}</span>
                <DataKnown value={item.danger === 'classified' ? item.dangerText : '—'} state={item.danger} />
                <small>{item.danger === 'classified' ? '已分类 · 审计放行' : '未支持 · 不等于安全'}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  function AnalyticsSurface({ displayState = 'ready' }) {
    const chapters = [
      { id: 'field', index: '00', label: '近 30 天' },
      { id: 'coverage', index: '01', label: 'Provider 覆盖' },
      { id: 'operations', index: '02', label: '工具与延迟' },
      { id: 'risk', index: '03', label: '风险与盲区' }
    ]
    const [active, setActive] = useState('field')
    const [provider, setProvider] = useState(null)
    const statePanel = SurfaceState({ kind: displayState, noun: '分析记录' })
    return (
      <section className="data-surface analytics-surface" data-screen-label="分析 · 四章叙事">
        <DataViewHeader eyebrow="ANALYTICS" title="从量到证据，再到能力盲区" summary="四章共享同一事实口径；高亮只改变聚焦，不改变汇总。" trailing={<DataStatus status={displayState === 'partial' ? 'partial' : 'exact'} label={displayState === 'partial' ? '部分完整' : '结构仿真'} />} />
        <nav className="chapter-tabs" aria-label="分析章节">
          {chapters.map((chapter) => (
            <button type="button" key={chapter.id} className={active === chapter.id ? 'active' : ''} onClick={() => setActive(chapter.id)} aria-current={active === chapter.id ? 'page' : undefined}>
              <span>{chapter.index}</span>{chapter.label}
            </button>
          ))}
          <span className="chapter-focus">{provider ? `${provider.toUpperCase()} HIGHLIGHT` : 'ALL PROVIDERS'}</span>
        </nav>
        {statePanel || (
          <div className={`chapter-stage ${displayState === 'partial' ? 'is-partial' : ''}`}>
            {active === 'field' && <AnalyticsField selectedProvider={provider} onProvider={setProvider} />}
            {active === 'coverage' && <AnalyticsCoverage selectedProvider={provider} onProvider={setProvider} />}
            {active === 'operations' && <AnalyticsOperations selectedProvider={provider} />}
            {active === 'risk' && <AnalyticsRisk selectedProvider={provider} onProvider={setProvider} />}
          </div>
        )}
        <footer className="surface-foot"><SampleSource /><span>UNKNOWN ≠ 0 · UNSUPPORTED ≠ SAFE</span></footer>
      </section>
    )
  }

  function DiagnosticsSurface({ displayState = 'ready' }) {
    const issues = getSample('diagnostics', DIAGNOSTIC_ISSUES)
    const [selectedId, setSelectedId] = useState(issues[0]?.id)
    const selected = issues.find((issue) => issue.id === selectedId) || issues[0]
    const statePanel = SurfaceState({ kind: displayState, noun: '诊断证据' })
    return (
      <section className="data-surface diagnostics-surface" data-screen-label="诊断 · Verdict 与证据通道">
        <DataViewHeader eyebrow="DIAGNOSTICS" title="先说结论，再交付证据" summary="按处置优先级排列；盲区与真实故障分开表达。" trailing={<button type="button" className="secondary-action">重新诊断</button>} />
        {statePanel || (
          <>
            <div className="verdict-band">
              <div className="verdict-main"><DataStatus status="warn" label="需要关注" /><b>1</b><span>项会影响统计解释</span></div>
              <DataEvidenceRow label="CHECKS" value="4" />
              <DataEvidenceRow label="CLEAR" value="2" />
              <DataEvidenceRow label="PARTIAL" value="1" state="partial" />
              <DataEvidenceRow label="UNSUPPORTED" value="1" state="unsupported" />
            </div>
            <div className="diagnostics-workspace">
              <div className="issue-channel">
                <DataSectionTitle index="01" title="优先检查" meta="按解释风险排序" />
                {issues.map((issue) => (
                  <button type="button" key={issue.id} className={`issue-row severity-${issue.severity} ${selectedId === issue.id ? 'active' : ''}`} onClick={() => setSelectedId(issue.id)} aria-pressed={selectedId === issue.id}>
                    <DataStatus status={issue.verdict} />
                    <span className="issue-copy"><b>{issue.title}</b><small>{issue.summary}</small></span>
                    <DataKnown value={issue.value} state={issue.verdict} />
                    <span className="row-chevron">›</span>
                  </button>
                ))}
              </div>
              {selected && (
                <aside className="diagnostic-evidence" aria-live="polite">
                  <header><span>EVIDENCE CHANNEL</span><DataStatus status={selected.verdict} /></header>
                  <h2>{selected.title}</h2>
                  <p>{selected.summary}</p>
                  <div className="evidence-timeline">
                    {selected.evidence.map(([time, source, finding, status], index) => (
                      <div className="evidence-event" key={`${selected.id}-${index}`}>
                        <time>{time}</time><i></i><span><b>{source}</b><small>{finding}</small></span><DataStatus status={status} />
                      </div>
                    ))}
                  </div>
                  <div className="diagnostic-action"><span>NEXT ACTION</span><p>{selected.action}</p></div>
                  <SampleSource>trace archive · capability matrix · 结构仿真</SampleSource>
                </aside>
              )}
            </div>
          </>
        )}
        <footer className="surface-foot"><SemanticLegend /><span>诊断只报告证据，不自动修复或拦截。</span></footer>
      </section>
    )
  }

  function ExecutionGraphSurface({ displayState = 'ready' }) {
    const sessions = getSample('graphSessions', GRAPH_SESSIONS)
    const flatNodes = useMemo(() => sessions.flatMap((session) => session.nodes.map((node) => ({ ...node, session }))), [sessions])
    const [selectedId, setSelectedId] = useState(flatNodes[1]?.id)
    const selected = flatNodes.find((node) => node.id === selectedId) || flatNodes[0]
    const statePanel = SurfaceState({ kind: displayState, noun: '执行节点' })
    return (
      <section className="data-surface graph-surface" data-screen-label="拓扑 · Session wall 与节点证据">
        <DataViewHeader eyebrow="EXECUTION GRAPH" title="会话墙比蜘蛛网更诚实" summary="会话保持稳定泳道；选择节点后在右侧查看证据，不让布局重新跳动。" trailing={<DataStatus status={displayState === 'partial' ? 'partial' : 'exact'} label="示例拓扑" />} />
        {statePanel || (
          <>
            <div className="graph-summary-strip">
              <DataEvidenceRow label="SESSIONS" value="3" />
              <DataEvidenceRow label="NODES" value="12" />
              <DataEvidenceRow label="PARTIAL" value="2" state="partial" />
              <DataEvidenceRow label="ERRORS" value="0" state="trueZero" />
              <div className="graph-legend"><span><i className="kind-model"></i>MODEL</span><span><i className="kind-tool"></i>TOOL</span><span><i className="kind-result"></i>RESULT</span></div>
            </div>
            <div className="graph-workspace">
              <div className="session-wall" role="list" aria-label="执行会话墙">
                {sessions.map((session) => (
                  <div className="session-lane" key={session.id}>
                    <header><span><i className={`provider-dot provider-${session.provider}`}></i><b>{session.label}</b></span><time>{session.time}</time></header>
                    <div className="node-run">
                      {session.nodes.map((node, index) => (
                        <React.Fragment key={node.id}>
                          {index > 0 && <i className="node-edge" aria-hidden="true"></i>}
                          <button type="button" className={`graph-node kind-${node.kind} state-${node.status} ${selectedId === node.id ? 'active' : ''}`} onClick={() => setSelectedId(node.id)} aria-pressed={selectedId === node.id}>
                            <span className="node-kind">{node.kind.toUpperCase()}</span>
                            <b>{node.label}</b>
                            <small>{node.duration}</small>
                            <DataStatus status={node.status} />
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {selected && (
                <aside className="node-inspector" aria-live="polite">
                  <header><span>NODE EVIDENCE</span><DataStatus status={selected.status} /></header>
                  <span className="node-id">{selected.session.id} / {selected.id}</span>
                  <h2>{selected.label}</h2>
                  <p>{selected.detail}</p>
                  <DataEvidenceRow label="PROVIDER" value={selected.session.provider.toUpperCase()} />
                  <DataEvidenceRow label="DURATION" value={selected.duration} state={selected.duration === '0ms' ? 'trueZero' : selected.duration === '—' ? 'unknown' : 'exact'} />
                  <DataEvidenceRow label="TOKEN" value={selected.tokens} state={selected.tokens.startsWith('≥') ? 'lowerBound' : selected.tokens === '—' ? 'unknown' : selected.tokens === '不适用' ? 'notApplicable' : 'exact'} />
                  <DataEvidenceRow label="SOURCE" value={selected.source} state={selected.status === 'partial' ? 'partial' : 'exact'} />
                  <SampleSource>session / turn / span 结构仿真</SampleSource>
                </aside>
              )}
            </div>
          </>
        )}
        <footer className="surface-foot"><SemanticLegend /><span>选择只改变检查对象，不重排节点。</span></footer>
      </section>
    )
  }

  function formatDuration(ms) {
    if (ms >= 60000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
    return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
  }

  function SegmentsSurface({ displayState = 'ready' }) {
    const segments = getSample('segments', SEGMENTS)
    const providers = ['all', ...new Set(segments.map((segment) => segment.provider))]
    const [filter, setFilter] = useState('all')
    const visible = filter === 'all' ? segments : segments.filter((segment) => segment.provider === filter)
    const [selectedId, setSelectedId] = useState(segments[3]?.id)
    const selected = segments.find((segment) => segment.id === selectedId) || visible[0]
    const total = Math.max(...segments.map((segment) => segment.durationMs), 1)
    const statePanel = SurfaceState({ kind: displayState, noun: '执行分段' })
    const selectFilter = (provider) => {
      setFilter(provider)
      if (provider !== 'all') {
        const firstMatch = segments.find((segment) => segment.provider === provider)
        if (firstMatch) setSelectedId(firstMatch.id)
      }
    }
    return (
      <section className="data-surface segments-surface" data-screen-label="分段 · 时间 Ribbon 与账本">
        <DataViewHeader eyebrow="SEGMENTS" title="七分钟里，等待与工作各自发生在哪里" summary="Ribbon 编码耗时，账本保留精确字段；过滤不会改变全局结论。" trailing={<DataStatus status={displayState === 'partial' ? 'partial' : 'exact'} label="6 个分段" />} />
        {statePanel || (
          <>
            <div className="segment-conclusion">
              <div><DataKnown value="7m 23s" state="exact" className="conclusion-number" /><span>总历时</span></div>
              <p><b>界面实施占 71%</b>，是本次会话的主导阶段；Provider 回补的 Token 仍只是已知下界。</p>
              <div className="segment-filters" aria-label="Provider 过滤">
                {providers.map((provider) => <button type="button" key={provider} className={filter === provider ? 'active' : ''} onClick={() => selectFilter(provider)}>{provider === 'all' ? 'ALL' : provider.toUpperCase()}</button>)}
              </div>
            </div>
            <div className="segment-ribbon" aria-label="执行分段时间 Ribbon">
              {segments.map((segment) => (
                <button
                  type="button"
                  key={segment.id}
                  className={`segment-block kind-${segment.kind} provider-${segment.provider} state-${segment.status} ${selectedId === segment.id ? 'active' : ''} ${filter !== 'all' && filter !== segment.provider ? 'dimmed' : ''}`}
                  style={{ flexGrow: Math.max(0.08, segment.durationMs / total) }}
                  onClick={() => setSelectedId(segment.id)}
                  aria-pressed={selectedId === segment.id}
                >
                  <span>{segment.index}</span><b>{segment.label}</b><small>{formatDuration(segment.durationMs)}</small>
                </button>
              ))}
            </div>
            <div className="segments-workspace">
              <div className="segment-ledger">
                <div className="segment-table-head"><span>SEGMENT</span><span>START</span><span>DURATION</span><span>TOOLS</span><span>STATE</span></div>
                {visible.map((segment) => (
                  <button type="button" key={segment.id} className={`segment-row ${selectedId === segment.id ? 'active' : ''}`} onClick={() => setSelectedId(segment.id)}>
                    <span className="segment-name"><i className={`provider-dot provider-${segment.provider}`}></i><b>{segment.index} · {segment.label}</b><small>{segment.kind}</small></span>
                    <time>{segment.start}</time>
                    <b>{formatDuration(segment.durationMs)}</b>
                    <DataKnown value={String(segment.tools)} state={segment.tools === 0 ? 'trueZero' : 'exact'} />
                    <DataStatus status={segment.status} />
                  </button>
                ))}
              </div>
              {selected && (
                <aside className="segment-inspector" aria-live="polite">
                  <header><span>SEGMENT {selected.index}</span><DataStatus status={selected.status} /></header>
                  <h2>{selected.label}</h2>
                  <p>{selected.note}</p>
                  <DataEvidenceRow label="PROVIDER" value={selected.provider.toUpperCase()} />
                  <DataEvidenceRow label="DURATION" value={formatDuration(selected.durationMs)} />
                  <DataEvidenceRow label="TOKEN" value={selected.token} state={selected.token.startsWith('≥') ? 'lowerBound' : selected.token === '不适用' ? 'notApplicable' : 'exact'} />
                  <DataEvidenceRow label="TOOL FAILURES" value={String(selected.failures)} state={selected.failures === 0 ? 'trueZero' : 'exact'} />
                  <SampleSource>turn timing · tool spans · 结构仿真</SampleSource>
                </aside>
              )}
            </div>
          </>
        )}
        <footer className="surface-foot"><SemanticLegend /><span>Ribbon 只编码 duration；Provider 颜色只编码类别。</span></footer>
      </section>
    )
  }

  Object.assign(window, {
    AnalyticsSurface,
    DiagnosticsSurface,
    ExecutionGraphSurface,
    SegmentsSurface
  })
})()
