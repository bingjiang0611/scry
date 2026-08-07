const coreFallbackData = {
  meta: {
    sampleLabel: '结构仿真 · 示例数据',
    snapshot: '2026-08-07 17:42',
  },
  welcome: {
    providers: [
      {
        id: 'claude',
        name: 'Claude Code',
        state: 'ready',
        stateLabel: '已就绪',
        detail: 'CLI、hooks 与 usage 均可验证',
        facts: [
          { label: 'CLI', value: '1.0.35', state: 'exact' },
          { label: 'Hooks', value: '4 / 4', state: 'exact' },
        ],
      },
      {
        id: 'codex',
        name: 'Codex',
        state: 'ready',
        stateLabel: '已就绪',
        detail: '执行可观测；危险分类能力未支持',
        facts: [
          { label: '执行', value: '可观测', state: 'exact' },
          { label: '危险分类', value: '未支持', state: 'unsupported' },
        ],
      },
      {
        id: 'qoder',
        name: 'Qoder',
        state: 'partial',
        stateLabel: '部分就绪',
        detail: 'CLI 可用；首次运行前 usage 仍未知',
        facts: [
          { label: 'CLI', value: '已发现', state: 'exact' },
          { label: 'Usage', value: '未知', state: 'unknown' },
        ],
      },
      {
        id: 'opencode',
        name: 'OpenCode',
        state: 'partial',
        stateLabel: '部分就绪',
        detail: '运行时可用；审计能力存在边界',
        facts: [
          { label: '运行时', value: '已发现', state: 'exact' },
          { label: '危险分类', value: '未支持', state: 'unsupported' },
        ],
      },
    ],
    permissions: [
      { label: '当前工作区', value: '读写已授权', state: 'exact', detail: '/Users/baobingjiang/IdeaProjects/vibecoding/scry' },
      { label: 'Shell', value: '本机执行', state: 'exact', detail: '命令会记录为工具证据' },
      { label: '外部网络', value: '按任务授权', state: 'partial', detail: '不同 Provider 的策略可能不同' },
      { label: '今日失败', value: '0', state: 'zero', detail: '完整观测到的真实 0' },
    ],
    projects: [
      { id: 'scry', name: 'scry', path: '~/IdeaProjects/vibecoding/scry', provider: 'codex', activity: '刚刚', summary: '优化 Analytics 统计口径' },
      { id: 'rate-native', name: 'rate-native', path: '~/.treehouse/rate-native/7', provider: 'claude', activity: '6 天前', summary: '两轮 rate-workflow 验收' },
      { id: 'etch', name: 'etch', path: '~/IdeaProjects/vibecoding/etch', provider: 'qoder', activity: '2 周前', summary: '字幕轨道导出诊断' },
    ],
  },
  chat: {
    session: {
      title: '修复 Analytics 的统计口径',
      project: 'scry',
      provider: 'Codex',
      branch: 'codex/scry-editorial-ui',
      status: 'running',
      statusLabel: '执行中',
      started: '17:24',
    },
    events: [
      {
        id: 'turn-1',
        kind: 'user',
        actor: '你',
        time: '17:24',
        title: '优化所有分析页面，并保留数据口径的诚实表达。',
        body: '参考 Run Streak 的质感，但不要把工作台做成长滚动故事。',
        state: 'exact',
      },
      {
        id: 'turn-2',
        kind: 'agent',
        actor: 'Codex',
        time: '17:26',
        title: '先隔离实现边界，再统一九个表面的证据语言。',
        body: '当前主工作树含 OAuth 改动，已切到独立 worktree，避免构建污染。',
        state: 'exact',
      },
      {
        id: 'turn-3',
        kind: 'tool',
        actor: 'Shell',
        time: '17:31',
        title: '读取 Analytics SQL 与 renderer 语义',
        body: '发现工具、项目、模型三个 Top N 查询口径与 UI 标题不一致。',
        state: 'exact',
        evidence: 'span-ledger.ts · AnalyticsView.tsx',
      },
      {
        id: 'turn-4',
        kind: 'agent',
        actor: 'Codex',
        time: '17:38',
        title: '结论：先纠正统计口径，再迁移视觉系统。',
        body: '部分覆盖显示已知下界；unsupported 不解释成 0；真实 0 必须有完整观测证据。',
        state: 'partial',
        evidence: '3 个查询待修复 · 1 个覆盖条件待补齐',
      },
    ],
    evidence: [
      { label: '当前分支', value: 'codex/scry-editorial-ui', state: 'exact', detail: '隔离 worktree' },
      { label: 'Analytics 覆盖', value: '28 / 31 turns', state: 'partial', detail: '已知 Token 仅是下界' },
      { label: '可证明成本', value: '未知', state: 'unknown', detail: 'Provider 没有完整上报' },
      { label: 'Codex 危险分类', value: '未支持', state: 'unsupported', detail: '不能解释为 0 danger' },
      { label: '本轮工具失败', value: '0', state: 'zero', detail: '8 / 8 次调用均有结果' },
    ],
  },
  overview: {
    verdict: '口径修复进行中；当前没有工具失败。',
    verdictState: 'partial',
    metrics: [
      { label: '已知 Token', value: '≥ 194k', state: 'partial', note: '2 / 3 轮完整' },
      { label: '运行时间', value: '14m 32s', state: 'exact', note: '持续更新' },
      { label: '工具失败', value: '0', state: 'zero', note: '8 / 8 已观测' },
      { label: '可证明成本', value: '未知', state: 'unknown', note: '上游未完整上报' },
    ],
    ledger: [
      { label: 'Provider', value: 'Codex', state: 'exact', detail: '本地 CLI' },
      { label: '分支', value: 'codex/scry-editorial-ui', state: 'exact', detail: 'worktree 隔离' },
      { label: '危险分类', value: '未支持', state: 'unsupported', detail: '不可解释为安全' },
      { label: 'Usage 覆盖', value: '2 / 3 turns', state: 'partial', detail: '已知下界' },
      { label: 'MCP 写入', value: '0', state: 'zero', detail: '完整审计范围内' },
    ],
    turns: [
      { id: 'turn-4', rank: 1, label: 'Turn 4', value: '≥ 92k', score: 100, state: 'partial', detail: '正在运行' },
      { id: 'turn-2', rank: 2, label: 'Turn 2', value: '64k', score: 70, state: 'exact', detail: '完整' },
      { id: 'turn-3', rank: 3, label: 'Turn 3', value: '38k', score: 42, state: 'exact', detail: '完整' },
      { id: 'turn-1', rank: 4, label: 'Turn 1', value: '未知', score: 0, state: 'unknown', detail: '未上报 usage' },
    ],
  },
}

function getCoreData() {
  const provided = typeof sampleData === 'object' && sampleData ? sampleData : {}
  return {
    meta: { ...coreFallbackData.meta, ...(provided.meta || {}) },
    welcome: { ...coreFallbackData.welcome, ...(provided.welcome || {}) },
    chat: { ...coreFallbackData.chat, ...(provided.chat || {}) },
    overview: { ...coreFallbackData.overview, ...(provided.overview || {}) },
  }
}

function SampleStamp({ compact = false }) {
  const { meta } = getCoreData()
  return (
    <div className={`sample-stamp ${compact ? 'is-compact' : ''}`} title="原型不会读取本机 Provider 或 SQLite">
      <span className="sample-stamp-dot" aria-hidden="true"></span>
      <b>{meta.sampleLabel}</b>
      {!compact && <time>{meta.snapshot}</time>}
    </div>
  )
}

function ProviderReadiness({ provider, active, onSelect }) {
  return (
    <button
      type="button"
      className={`provider-readiness ${active ? 'is-selected' : ''}`}
      onClick={() => onSelect(provider.id)}
      aria-pressed={active}
    >
      <span className="selection-anchor" aria-hidden="true"></span>
      <span className={`provider-swatch provider-${provider.id}`} aria-hidden="true"></span>
      <span className="provider-readiness-copy">
        <span className="provider-readiness-title">
          <strong>{provider.name}</strong>
          <StatusMark state={provider.state} label={provider.stateLabel} />
        </span>
        <span className="provider-readiness-detail">{provider.detail}</span>
        <span className="provider-readiness-facts">
          {provider.facts.map((fact) => (
            <span className={`fact-token state-${fact.state}`} key={`${provider.id}-${fact.label}`}>
              <small>{fact.label}</small>
              <b>{fact.value}</b>
            </span>
          ))}
        </span>
      </span>
      <ScryIcon name="chevronRight" size={14} />
    </button>
  )
}

function WelcomeComposer({ provider, project, onSubmit }) {
  const [prompt, setPrompt] = React.useState('')

  const runPrompt = () => {
    if (!prompt.trim()) return
    if (onSubmit) onSubmit({ prompt: prompt.trim(), provider, project })
  }

  const submit = (event) => {
    event.preventDefault()
    runPrompt()
  }

  return (
    <form className="welcome-composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="welcome-prompt">向 Scry 描述任务</label>
      <textarea
        id="welcome-prompt"
        rows="3"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            runPrompt()
          }
        }}
        placeholder="描述任务，Scry 会保留执行证据与数据边界…"
      ></textarea>
      <div className="welcome-composer-footer">
        <div className="composer-context">
          <span><ScryIcon name="terminal" size={13} />{provider?.name || '未选择 Provider'}</span>
          <span><ScryIcon name="folder" size={13} />{project?.name || '未选择项目'}</span>
          <span className="composer-permission"><ScryIcon name="shield" size={13} />本机权限</span>
        </div>
        <button type="submit" className="primary-action" disabled={!prompt.trim()}>
          开始执行
          <ScryIcon name="arrowUp" size={15} />
        </button>
      </div>
    </form>
  )
}

function WelcomeSurface({ onStart, onOpenProject }) {
  const { welcome } = getCoreData()
  const [activeProviderId, setActiveProviderId] = React.useState(welcome.providers[0]?.id || '')
  const [activeProjectId, setActiveProjectId] = React.useState(welcome.projects[0]?.id || '')
  const activeProvider = welcome.providers.find((provider) => provider.id === activeProviderId)
  const activeProject = welcome.projects.find((project) => project.id === activeProjectId)

  return (
    <main className="surface welcome-surface" data-screen-label="欢迎页 · 本地就绪场">
      <ViewHeader
        eyebrow="LOCAL WORKSPACE"
        title="准备好观察下一次执行。"
        detail="先确认 Provider、权限与工作区，再把任务交给 Scry。"
        trailing={<SampleStamp />}
      />

      <div className="welcome-layout">
        <section className="welcome-primary" aria-labelledby="welcome-start-title">
          <div className="welcome-ready-line">
            <span className="ready-pulse" aria-hidden="true"></span>
            <span><b>3 个运行时可用</b><small>1 项 usage 待首次运行 · 2 项危险分类未支持</small></span>
          </div>

          <div className="welcome-composer-block">
            <SectionTitle id="welcome-start-title" index="00" title="开始一项可追溯任务" meta="证据默认开启" />
            <WelcomeComposer
              provider={activeProvider}
              project={activeProject}
              onSubmit={onStart}
            />
            <p className="composer-hint">Enter 换行 · ⌘↵ 执行 · 示例原型不会真的启动 Provider</p>
          </div>

          <section className="welcome-section" aria-labelledby="provider-ready-title">
            <SectionTitle id="provider-ready-title" index="01" title="Provider 就绪" meta={`${welcome.providers.length} 个适配器`} />
            <div className="provider-readiness-list">
              {welcome.providers.map((provider) => (
                <ProviderReadiness
                  key={provider.id}
                  provider={provider}
                  active={provider.id === activeProviderId}
                  onSelect={setActiveProviderId}
                />
              ))}
            </div>
            <p className="semantic-note">
              <b>边界：</b>“未支持”表示没有该能力，不是 0；“未知”表示尚无足够观测；“部分”只展示已知事实。
            </p>
          </section>
        </section>

        <aside className="welcome-secondary" aria-label="本地工作区状态">
          <section className="welcome-section permission-section" aria-labelledby="permission-title">
            <SectionTitle id="permission-title" index="02" title="本机权限" meta="执行前核对" />
            <div className="evidence-ledger">
              {welcome.permissions.map((item) => (
                <EvidenceRow
                  key={item.label}
                  label={item.label}
                  value={item.value}
                  state={item.state}
                  detail={item.detail}
                />
              ))}
            </div>
          </section>

          <section className="welcome-section recent-section" aria-labelledby="recent-project-title">
            <SectionTitle id="recent-project-title" index="03" title="最近项目" meta="本机历史" />
            <div className="recent-project-list">
              {welcome.projects.map((project) => {
                const active = project.id === activeProjectId
                return (
                  <button
                    type="button"
                    key={project.id}
                    className={`recent-project ${active ? 'is-selected' : ''}`}
                    onClick={() => {
                      setActiveProjectId(project.id)
                      if (onOpenProject) onOpenProject(project)
                    }}
                    aria-pressed={active}
                  >
                    <span className="selection-anchor" aria-hidden="true"></span>
                    <span className={`provider-swatch provider-${project.provider}`} aria-hidden="true"></span>
                    <span className="recent-project-copy">
                      <span><b>{project.name}</b><time>{project.activity}</time></span>
                      <small>{project.path}</small>
                      <em>{project.summary}</em>
                    </span>
                    <ScryIcon name="chevronRight" size={14} />
                  </button>
                )
              })}
            </div>
          </section>
        </aside>
      </div>
    </main>
  )
}

function ChatEvent({ event, selected, onSelect }) {
  return (
    <article className={`chat-event event-${event.kind} ${selected ? 'is-selected' : ''}`}>
      <button
        type="button"
        className="chat-event-anchor"
        onClick={() => onSelect(event.id)}
        aria-label={`选择 ${event.actor} 在 ${event.time} 的事件`}
        aria-pressed={selected}
      >
        <span className="selection-anchor" aria-hidden="true"></span>
        <span className="event-node" aria-hidden="true"></span>
      </button>
      <div className="chat-event-content">
        <header className="chat-event-meta">
          <span className={`event-kind-mark kind-${event.kind}`}>
            <ScryIcon name={event.kind === 'tool' ? 'terminal' : event.kind === 'user' ? 'user' : 'spark'} size={13} />
            {event.actor}
          </span>
          <time>{event.time}</time>
          {event.state !== 'exact' && <StatusMark state={event.state} label={event.state === 'partial' ? '部分证据' : event.state} />}
        </header>
        <h3>{event.title}</h3>
        <p>{event.body}</p>
        {event.evidence && (
          <button type="button" className="inline-evidence" onClick={() => onSelect(event.id)}>
            <ScryIcon name="fileText" size={13} />
            {event.evidence}
          </button>
        )}
      </div>
    </article>
  )
}

function ChatSurface({ selectedEvent, onSelectEvent }) {
  const { chat } = getCoreData()
  const [internalSelected, setInternalSelected] = React.useState(selectedEvent || 'turn-4')
  const activeEventId = selectedEvent ?? internalSelected
  const selectEvent = (eventId) => {
    setInternalSelected(eventId)
    if (onSelectEvent) onSelectEvent(eventId)
  }
  const activeEvent = chat.events.find((event) => event.id === activeEventId) || chat.events[chat.events.length - 1]

  return (
    <main className="surface chat-surface" data-screen-label="对话 · 稳定执行时间线">
      <ViewHeader
        eyebrow={`${chat.session.project} · ${chat.session.provider}`}
        title={chat.session.title}
        detail={`${chat.session.branch} · 开始于 ${chat.session.started}`}
        status={<StatusMark state={chat.session.status} label={chat.session.statusLabel} />}
        trailing={<SampleStamp compact />}
      />

      <div className="chat-run-strip" aria-label="当前执行摘要">
        <span><i className="live-dot" aria-hidden="true"></i><b>正在执行</b><small>Turn 4</small></span>
        <span><b>8</b><small>工具调用</small></span>
        <span><b className="true-zero">0</b><small>已观测失败</small></span>
        <span><b>≥ 194k</b><small>已知 Token</small></span>
        <span className="run-strip-boundary"><StatusMark state="partial" label="2 / 3 完整" /></span>
      </div>

      <div className="chat-reading-column">
        <section className="chat-timeline" aria-label="执行时间线">
          <div className="timeline-rail" aria-hidden="true"></div>
          {chat.events.map((event) => (
            <ChatEvent
              key={event.id}
              event={event}
              selected={event.id === activeEventId}
              onSelect={selectEvent}
            />
          ))}
        </section>

        <section className="chat-conclusion" aria-labelledby="chat-conclusion-title">
          <div className="conclusion-kicker"><span>当前结论</span><StatusMark state={activeEvent.state} label={activeEvent.state === 'partial' ? '仍在验证' : '有证据'} /></div>
          <h2 id="chat-conclusion-title">{activeEvent.title}</h2>
          <p>{activeEvent.body}</p>
          <div className="conclusion-source"><span>SOURCE</span><i></i><b>{activeEvent.evidence || 'session event ledger'}</b></div>
        </section>

        <section className="chat-evidence-band" aria-labelledby="chat-evidence-title">
          <SectionTitle id="chat-evidence-title" index="E" title="轻证据带" meta="点击时间线以切换锚点" />
          <div className="evidence-band-grid">
            {chat.evidence.map((item) => (
              <EvidenceRow
                key={item.label}
                label={item.label}
                value={item.value}
                state={item.state}
                detail={item.detail}
              />
            ))}
          </div>
          <p className="semantic-note compact">
            绿色 0 只用于完整观测后的真实零；未知、未支持与部分覆盖均保留各自语义。
          </p>
        </section>
      </div>

      <form className="chat-followup" onSubmit={(event) => event.preventDefault()}>
        <label className="sr-only" htmlFor="chat-followup-input">继续对话</label>
        <input id="chat-followup-input" placeholder="继续追问，或给下一步指令…" />
        <button type="button" aria-label="附加上下文"><ScryIcon name="plus" size={15} /></button>
        <button type="submit" className="chat-send" aria-label="发送"><ScryIcon name="arrowUp" size={15} /></button>
      </form>
    </main>
  )
}

function OverviewMetric({ metric }) {
  return (
    <div className={`overview-metric state-${metric.state}`}>
      <span>{metric.label}</span>
      <KnownValue value={metric.value} state={metric.state} />
      <small>{metric.note}</small>
    </div>
  )
}

function TurnRankingRow({ turn, selected, onSelect }) {
  return (
    <button
      type="button"
      className={`turn-ranking-row state-${turn.state} ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(turn.id)}
      aria-pressed={selected}
    >
      <span className="selection-anchor" aria-hidden="true"></span>
      <b className="turn-rank">{String(turn.rank).padStart(2, '0')}</b>
      <span className="turn-ranking-copy">
        <span><strong>{turn.label}</strong><em>{turn.detail}</em></span>
        <span className="turn-rank-track" aria-hidden="true"><i style={{ width: `${turn.score}%` }}></i></span>
      </span>
      <KnownValue value={turn.value} state={turn.state} compact />
    </button>
  )
}

function OverviewPanel({ selectedEvent, onSelectEvent }) {
  const { overview } = getCoreData()
  const [tab, setTab] = React.useState('overview')
  const [internalSelected, setInternalSelected] = React.useState(selectedEvent || 'turn-4')
  const activeEventId = selectedEvent ?? internalSelected
  const selectTurn = (turnId) => {
    setInternalSelected(turnId)
    if (onSelectEvent) onSelectEvent(turnId)
  }

  return (
    <aside className="overview-panel" data-screen-label="总览 · 340px 证据档案" aria-label="当前执行总览">
      <div className="overview-sticky-head">
        <div className="overview-title-row">
          <span><b>总览</b><small>当前执行</small></span>
          <SampleStamp compact />
        </div>
        <nav className="overview-tabs" aria-label="总览面板章节">
          {[
            ['overview', '纵览'],
            ['billing', '账单卫士'],
            ['trust', 'MCP 信任'],
          ].map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={tab === id ? 'is-active' : ''}
              onClick={() => setTab(id)}
              aria-current={tab === id ? 'page' : undefined}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'overview' && (
        <div className="overview-scroll-content">
          <section className={`overview-verdict state-${overview.verdictState}`}>
            <span className="verdict-line"><i aria-hidden="true"></i><b>{overview.verdict}</b></span>
            <StatusMark state={overview.verdictState} label="部分结论" />
          </section>

          <section className="overview-section" aria-labelledby="overview-metrics-title">
            <SectionTitle id="overview-metrics-title" index="01" title="执行尺度" meta="最多 2 × 2" />
            <div className="overview-metric-grid">
              {overview.metrics.slice(0, 4).map((metric) => <OverviewMetric key={metric.label} metric={metric} />)}
            </div>
          </section>

          <section className="overview-section" aria-labelledby="overview-ledger-title">
            <SectionTitle id="overview-ledger-title" index="02" title="证据账本" meta="当前选择" />
            <div className="evidence-ledger compact-ledger">
              {overview.ledger.map((item) => (
                <EvidenceRow
                  key={item.label}
                  label={item.label}
                  value={item.value}
                  state={item.state}
                  detail={item.detail}
                />
              ))}
            </div>
          </section>

          <section className="overview-section" aria-labelledby="turn-ranking-title">
            <SectionTitle id="turn-ranking-title" index="03" title="轮次排名" meta="已知 Token" />
            <div className="turn-ranking-list">
              {overview.turns.map((turn) => (
                <TurnRankingRow
                  key={turn.id}
                  turn={turn}
                  selected={turn.id === activeEventId}
                  onSelect={selectTurn}
                />
              ))}
            </div>
            <p className="semantic-note compact">未知轮次不进入数值排名；部分轮次按已知下界展示。</p>
          </section>
        </div>
      )}

      {tab === 'billing' && (
        <div className="overview-scroll-content overview-empty-tab">
          <StatusMark state="unknown" label="成本未知" />
          <h3>账单数据尚不足以形成结论。</h3>
          <p>Provider 没有完整上报可证明成本。这里不会用 Token 估算冒充账单。</p>
          <EvidenceRow label="已知成本" value="未知" state="unknown" detail="等待 Provider 原始账单" />
          <EvidenceRow label="Token 观测" value="≥ 194k" state="partial" detail="只能作为已知下界" />
        </div>
      )}

      {tab === 'trust' && (
        <div className="overview-scroll-content overview-empty-tab">
          <StatusMark state="zero" label="0 次写入" />
          <h3>本轮没有观测到 MCP 写入。</h3>
          <p>这是审计范围内的真实 0；未授权或未支持的 server 会单独列为未知，而不是并入安全结论。</p>
          <EvidenceRow label="已观测调用" value="6" state="exact" detail="全部为读取" />
          <EvidenceRow label="未授权 server" value="0" state="zero" detail="清单覆盖完整" />
          <EvidenceRow label="外部 OAuth" value="未支持" state="unsupported" detail="不进入本轮信任结论" />
        </div>
      )}
    </aside>
  )
}

Object.assign(window, {
  WelcomeSurface,
  ChatSurface,
  OverviewPanel,
})
