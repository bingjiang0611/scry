function RuntimeComposer({ cwd, provider = 'Codex', providerKnown = true, model = '按 Provider 上报' }) {
  const [prompt, setPrompt] = React.useState('')
  const [permission, setPermission] = React.useState('完全访问')
  const [workdirOpen, setWorkdirOpen] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const live = Boolean(sampleData.meta?.live)
  const commands = live ? [] : [
    { name: '/compact', detail: '压缩当前上下文' },
    { name: '/review', detail: '复核本轮改动' },
    { name: '/rate-workflow', detail: '运行两轮 rate-native 验收' },
  ]
  const slashOpen = prompt.startsWith('/') && !/\s/.test(prompt)
  const matches = commands.filter((command) => command.name.includes(prompt))
  const modelLabel = live && model === '按 Provider 上报' ? '模型未捕获' : model
  const permissionLabel = live ? '权限未读取' : permission
  const providerId = providerKnown ? provider.toLowerCase().replace(' code', '') : 'unknown'
  const send = () => {
    if (!prompt.trim()) return
    setNotice('只读验收原型不会启动本机 Agent；草稿未发送。')
  }

  return (
    <section className="runtime-composer" aria-label="会话输入">
      <div className="composer-shell-real">
        <div className="composer-workdir">
          <button type="button" className="workdir-trigger" aria-expanded={live ? undefined : workdirOpen} onClick={() => setWorkdirOpen((value) => !value)} disabled={live} title={live ? 'SQLite / archive 只提供历史工作目录；此处不切换真实 cwd' : undefined}>
            <ScryIcon name="folder" size={13} /><span>{cwd || '不绑定项目'}</span><ScryIcon name="down" size={11} />
          </button>
          {!live && workdirOpen && <div className="workdir-menu" role="menu"><button type="button" onClick={() => setWorkdirOpen(false)}>{cwd || '不绑定项目'}</button><button type="button" onClick={() => setWorkdirOpen(false)}>选择其他文件夹…</button></div>}
        </div>
        {slashOpen && <div className="slash-menu-real"><header>Commands</header>{live ? <p>当前 Provider 命令目录未读取；不伪造 slash command。</p> : matches.length ? matches.map((command) => <button type="button" key={command.name} onClick={() => setPrompt(`${command.name} `)}><b>{command.name}</b><span>{command.detail}</span></button>) : <p>无匹配命令</p>}</div>}
        <textarea value={prompt} onChange={(event) => { setPrompt(event.target.value); setNotice('') }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }} placeholder={live ? providerKnown ? `给 ${provider} 一个任务…（只读验收，不会发送）` : '准备新任务…（Provider 未选择；只读验收）' : `给 ${provider} 一个任务…（/ 唤起命令，Enter 发送，Shift+Enter 换行）`} aria-label="给 Agent 一个任务"></textarea>
        {notice && <div className="composer-notice" role="status">{notice}</div>}
        <div className="composer-controls-real">
          <div className="composer-control-group">
            <button type="button" className="runtime-pill is-locked" title={providerKnown ? '当前历史会话的 Provider' : '欢迎页尚未选择 Provider'} disabled={!providerKnown}><i className={`provider-dot ${providerId}`}></i>{provider}<ScryIcon name="lock" size={11} /></button>
            <button type="button" className="runtime-pill" disabled={live} title={live ? '最近一轮 usage 中的历史模型；不是当前可选模型' : undefined}>{modelLabel}<ScryIcon name="down" size={11} /></button>
            <button type="button" className={cx('runtime-pill', !live && permission === '完全访问' && 'tone-danger')} disabled={live} title={live ? 'SQLite / archive 不保存当前 Provider 权限模式' : undefined} onClick={() => setPermission((value) => value === '完全访问' ? '按需确认' : '完全访问')}><ScryIcon name="shield" size={12} />{permissionLabel}<ScryIcon name="down" size={11} /></button>
          </div>
          <div className="composer-actions-real"><button type="button" className="attach-action" aria-label="粘贴图片" disabled={live} title={live ? '只读验收原型不读取附件' : undefined}><ScryIcon name="paperclip" size={14} /></button><button type="button" className="send-action" onClick={send} disabled={!prompt.trim()}><ScryIcon name="send" size={14} /><span>发送</span></button></div>
        </div>
      </div>
    </section>
  )
}

function activeProviderId() {
  return sampleData.meta?.providerId || String(sampleData.chat?.provider || 'codex').toLowerCase().replace(' code', '')
}

function WelcomeSurface() {
  const live = Boolean(sampleData.meta?.live)
  const { welcome } = window.getCoreData()
  const [activeProviderId, setActiveProviderId] = React.useState(welcome.providers[0]?.id || '')
  const activeProvider = welcome.providers.find((provider) => provider.id === activeProviderId)
  const readyCount = welcome.providers.filter((provider) => provider.state === 'ready').length
  return (
    <main className="surface cold-start-surface" data-screen-label="欢迎页 · 未绑定项目会话">
      <div className="cold-chat-body welcome-live-scroll">
        <div className="welcome-live-field">
          <header className="welcome-live-heading">
            <div className="surface-kicker"><i></i>NEW SESSION · LOCAL EVIDENCE</div>
            <h1>开始一次可追溯执行。</h1>
            <p>可直接发起任务；需要读写项目文件时再选择工作目录，执行证据默认保留在本机。</p>
          </header>
          <section aria-label="Provider">
            <div className="welcome-live-status" role="status">
              <i aria-hidden="true"></i>
              <span><b>{readyCount}/{welcome.providers.length} 个 Provider 可用</b><small>结构预览；运行状态以 Scry 本机探测为准</small></span>
            </div>
            <div className="welcome-live-providers" aria-label="Provider 结构预览">
              {welcome.providers.map((provider) => {
                const active = provider.id === activeProviderId
                return (
                  <button type="button" key={provider.id} className={cx('welcome-live-provider', active && 'is-selected')} onClick={() => setActiveProviderId(provider.id)} aria-pressed={active}>
                    <i className={`provider-swatch provider-${provider.id}`} aria-hidden="true"></i>
                    <span><b>{provider.name}</b><small>{provider.detail}</small></span>
                    <StatusMark state={provider.state} label={provider.stateLabel} compact />
                    <ScryIcon name="chevronRight" size={13} />
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      </div>
      <RuntimeComposer cwd={null} provider={activeProvider?.name || (live ? 'Provider 未选择' : 'Codex')} providerKnown={Boolean(activeProvider)} model="按 Provider 上报" />
    </main>
  )
}

function ToolTraceRow({ block, selected, onSelect }) {
  const [open, setOpen] = React.useState(false)
  const icon = block.kind === 'skill' ? 'box' : block.kind === 'mcp' ? 'grid' : 'terminal'
  return (
    <div className={cx('trace-tool', `kind-${block.kind}`, selected && 'is-selected')}>
      <button type="button" className="trace-tool-main" onClick={() => { onSelect(block.id); setOpen((value) => !value) }} aria-expanded={open}>
        <span className="trace-kind"><ScryIcon name={icon} size={13} />{block.kind === 'skill' ? 'Skill' : block.kind === 'mcp' ? 'MCP' : block.label}</span>
        <span className="trace-detail">{block.kind === 'tool' ? block.detail : block.label}</span>
        {block.io && <em className={`trace-io io-${block.io.toLowerCase()}`}>{block.io}</em>}
        <StatusMark state={block.status} compact />
        <time>{block.duration}</time><ScryIcon name={open ? 'down' : 'chevronRight'} size={11} />
      </button>
      {block.kind !== 'tool' && <div className="trace-subline">{block.detail}</div>}
      {open && <div className="trace-output"><span>OUTPUT PREVIEW</span><code>{block.output || '调用完成；没有可展示的文本输出。'}</code><small>SQLite / archive 只读投影；常见凭据做基础脱敏，长输出已截断。</small></div>}
    </div>
  )
}

function TranscriptTurn({ turn, activeEventId, onSelect }) {
  const blocks = turn.blocks || []
  const selected = activeEventId === turn.id || blocks.some((block) => block.id === activeEventId)
  const hookKnown = Number.isFinite(turn.hookCount) && Number.isFinite(turn.hookEventCount)
  const hookPrefix = turn.hookEvidenceState === 'partial' ? '≥ ' : ''
  const hookEvidenceLabel = hookKnown ? `${hookPrefix}${turn.hookCount} 个 logical runs · ${hookPrefix}${turn.hookEventCount} events` : '— logical runs · — events'
  return (
    <article id={`chat-${turn.id}`} className={cx('transcript-turn', selected && 'is-jump-target')} data-run-id={turn.runId}>
      <div className="user-message-real"><span className="user-bubble">{turn.user.startsWith('/') && <b className="slash-chip">{turn.user.split(' ')[0]}</b>}{turn.user.startsWith('/') ? ` ${turn.user.split(' ').slice(1).join(' ')}` : turn.user}</span></div>
      <div className="assistant-turn-real">
        {turn.transcriptAvailable === false && <div className="transcript-gap-real"><ScryIcon name="info" size={13} /><span><b>Transcript archive 不可用</b>当前轮次来自 SQLite result / spans；用户与 Assistant 正文不作补写。</span></div>}
        <header className="assistant-who"><span className="assistant-identity"><i className={`provider-dot ${activeProviderId()}`}></i><b>{sampleData.chat.provider} run</b><code>{turn.runId}</code></span><span className="turn-summary"><b>{turn.tokens}</b><i></i><span>{turn.tools} calls</span>{turn.errors > 0 && <><i></i><span className="has-error">{turn.errors} err</span></>}</span></header>
        <details className="turn-disclosure files-summary-real"><summary><span><ScryIcon name="file" size={13} />{turn.diff.label}</span><b>{turn.diff.detail}</b><StatusMark state={turn.diff.status === 'unavailable' ? 'unknown' : 'exact'} compact /><ScryIcon name="chevronRight" size={11} /></summary><div><button type="button">打开 Review</button><span>{turn.diff.status === 'unavailable' ? '本轮没有可用 Git 快照；不从文件工具推断 diff。' : 'Git 快照差异与结构化文件工具证据分开记录。'}</span></div></details>
        <details className="turn-disclosure hooks-summary-real"><summary><span><ScryIcon name="bolt" size={13} />本轮 HOOK</span><b>{hookEvidenceLabel}</b><ScryIcon name="chevronRight" size={11} /></summary><div>{turn.hooks.length ? turn.hooks.map((hook, index) => <div className="hook-evidence-row" key={`${hook.label}-${index}`}><StatusMark state={hook.status} compact /><b>{hook.label}</b><span>{hook.detail}</span></div>) : <p className="evidence-unavailable">{hookKnown ? '当前 archive 观测到真实 0 个 Hook run。' : 'Hook evidence 未捕获；不解释为 0。'}</p>}</div></details>
        <div className="turn-stream">{blocks.length ? blocks.map((block) => block.kind === 'assistant' ? <p className="assistant-prose" key={block.id}>{block.text}</p> : block.kind === 'thinking' ? <details className="thinking-block-real" key={block.id}><summary><ScryIcon name="spark" size={12} />Thinking <ScryIcon name="chevronRight" size={10} /></summary><p>{block.text}</p></details> : <ToolTraceRow key={block.id} block={block} selected={activeEventId === block.id} onSelect={onSelect} />) : <p className="assistant-prose evidence-unavailable">完整 assistant transcript 未捕获；仅保留 SQLite 结构化结果。</p>}</div>
        <footer className="turn-footer-real"><span>in <b>{turn.footer.input}</b></span><span>out <b>{turn.footer.output}</b></span><span>cache·r <b>{turn.footer.cacheRead}</b></span><span>api <b>{turn.footer.api}</b></span><span>files <b>{turn.footer.files}</b></span><time>{turn.duration}</time></footer>
      </div>
    </article>
  )
}

function ChatSurface({ displayState, selectedEvent, onSelectEvent }) {
  const chat = sampleData.chat
  const [internalSelected, setInternalSelected] = React.useState(selectedEvent || 'turn-01')
  const activeEventId = selectedEvent ?? internalSelected
  const turns = displayState === 'empty' ? [] : chat.turns
  const selectEvent = (eventId) => { setInternalSelected(eventId); onSelectEvent?.(eventId) }
  React.useEffect(() => { if (String(activeEventId).startsWith('turn-')) document.getElementById(`chat-${activeEventId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }, [activeEventId])
  return (
    <main className="surface chat-surface" data-screen-label="对话 · 真实 Turn transcript">
      <div className="chat-source-line"><span><i></i>{sampleData.meta.live ? '本机真实会话' : '结构仿真降级'}</span><code>{sampleData.meta.db || '未连接 SQLite'}</code><b>TRANSCRIPT · {sampleData.meta.transcriptSource || 'sample'} · 基础脱敏 / 限长投影</b></div>
      <div className="chat-scroll-real">{displayState === 'error' && <div className="chat-error-banner"><ScryIcon name="alert" />最近一次证据读取失败；下方保留上一次可信 transcript。</div>}{turns.length ? turns.map((turn) => <TranscriptTurn key={turn.id} turn={turn} activeEventId={activeEventId} onSelect={selectEvent} />) : <div className="unbound-empty-real"><span><ScryIcon name="message" size={18} /></span><strong>还没有会话轮次</strong><p>发送任务后，Scry 会按真实顺序保留消息、工具、Hook 与结果。</p></div>}</div>
      <RuntimeComposer key={sampleData.meta?.selectedSessionId || 'sample'} cwd={chat.cwd} provider={chat.provider} model={chat.model} />
    </main>
  )
}

function ContextGauge({ context }) {
  if (!context) return <section className="context-usage is-unavailable"><div className="context-ring"><span>—</span></div><div className="context-copy"><span>上下文</span><b>暂无上下文数据</b><small>仅在 Provider 同时上报当前占用与窗口时显示。</small></div></section>
  return <section className="context-usage"><div className="context-ring" style={{ '--context-pct': context.pct }} aria-label={`上下文占用 ${context.pct}%`}><span>{context.pct}%</span></div><div className="context-copy"><span>上下文 · {context.model}</span><b>{context.used} / {context.window}</b><small>已占 {context.pct}% · 残余 {context.remaining} · {context.source}</small></div></section>
}

function TurnCallRow({ turn, selected, expandedKey, onSelect, onToggle }) {
  const groups = [['timing', '耗时', turn.groups.timing ?? (turn.duration && turn.duration !== '—' ? 1 : 0)], ['intervention', '介入', turn.groups.intervention], ['mcp', 'MCP', turn.groups.mcp], ['skill', 'Skill', turn.groups.skill], ['agent', '子Agent', turn.groups.agent], ['hooks', 'Hooks', turn.groups.hooks], ['file', '文件', turn.groups.file]]
  return (
    <article className={cx('turn-call-row-real', selected && 'is-selected')}><button type="button" className="turn-open-real" onClick={() => onSelect(turn.id)} aria-label={`跳到第 ${turn.index} 轮对话`}>T{turn.index}</button><div className="turn-call-content-real"><header><b>{turn.user}</b><span>{turn.duration}</span></header><div className="turn-call-groups-real">{groups.map(([key, label, count]) => <button type="button" key={key} className={cx(expandedKey === `${turn.id}:${key}` && 'is-open', Number(count) === 0 && 'is-empty')} onClick={() => onToggle(`${turn.id}:${key}`)}><span>{label}</span><b>{count ?? '—'}</b><ScryIcon name={expandedKey === `${turn.id}:${key}` ? 'down' : 'chevronRight'} size={10} /></button>)}</div>{expandedKey?.startsWith(`${turn.id}:`) && <div className="turn-call-detail-real"><span>{expandedKey.split(':')[1].toUpperCase()}</span><b>{turn.detail}</b><small>点击 T{turn.index} 定位左侧完整原始证据。</small></div>}</div></article>
  )
}

function SessionDataPanel({ overview }) {
  const hookPrefix = overview.hooks.state === 'partial' ? '≥ ' : ''
  const hookValue = (value) => Number.isFinite(value) ? `${hookPrefix}${value}` : '—'
  return <div className="session-data-real"><section className="overview-plain-section"><header><h4>TOP TOOLS</h4><span>{overview.tools.reduce((sum, tool) => sum + tool.calls, 0)} calls</span></header><div className="tool-rank-real">{overview.tools.map((tool) => <button type="button" key={tool.label}><span>{tool.label}</span><i><b style={{ width: `${tool.score}%` }}></b></i><strong>{tool.calls}</strong><em>{tool.errors ? `${tool.errors} err` : '—'}</em></button>)}</div></section><section className="overview-plain-section"><header><h4>HOOKS</h4><span>{hookValue(overview.hooks.runs)} logical runs · {hookValue(overview.hooks.events)} events</span></header><div className="hook-summary-real"><span className="ok"><b>{hookValue(overview.hooks.passed)}</b> passed</span><span className="warn"><b>{hookValue(overview.hooks.cancelled)}</b> cancelled</span><span className="bad"><b>{hookValue(overview.hooks.failed)}</b> failed</span><span><b>{hookValue(overview.hooks.unknown)}</b> unknown</span></div><p className="panel-source-note">Hook evidence 覆盖 {overview.hooks.coverage || '未知'}；未捕获不解释为 0。</p></section><details className="overview-details-real" open><summary>调用明细（Skill / MCP / 工具）<span>{overview.calls.length}</span></summary>{overview.calls.map((item) => <div className="compact-data-row" key={item.label}><b>{item.label}</b><span>{item.note}</span><strong>{item.value}</strong></div>)}</details><details className="overview-details-real"><summary>文件足迹<span>{overview.files.length}</span></summary>{overview.files.map((file, index) => <div className="compact-data-row file" key={`${file.label}-${index}`}><em>{file.mode}</em><b>{file.label}</b><strong>×{file.count}</strong></div>)}<p className="panel-source-note">R/W/E 来自结构化文件工具；其他间接访问可能未统计。</p></details><div className="panel-source-note">累计 Token 来自当前会话 result；工具、Skill、MCP 与 Hook 没有独立 Token 字段。</div></div>
}

function BillingPanel({ billing, onSelectTurn }) {
  return <div className="overview-scroll-content billing-panel-real"><section className="panel-heading-real"><div><h3>账单卫士</h3><span>{billing.status}</span></div></section><div className="billing-source-real"><span>{billing.source}</span><span className="muted">{billing.policy}</span></div><div className="billing-grid-real">{billing.metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><b>{metric.value}</b></div>)}</div><div className="billing-coverage-real">{billing.coverage.map((item) => <span key={item}>{item}</span>)}</div><details className="overview-details-real billing-details-real" open><summary>行动信号<span>{billing.signals.length}</span></summary>{billing.signals.length ? billing.signals.map((signal) => <button type="button" className="billing-signal-real" key={signal.title}><i></i><span><b>{signal.title}</b><small>{signal.detail}</small></span></button>) : <p className="evidence-unavailable">暂无符合规则的 Token / 上下文提示。</p>}</details><details className="overview-details-real billing-details-real" open><summary>高 Token 轮次<span>{billing.turns.length}</span></summary><div className="token-table-real"><div className="token-table-head"><span>轮次</span><span>总 Token</span><span>缓存</span><span>输入 / 输出</span><span>工具</span><span>上下文</span></div>{billing.turns.map((turn) => <button type="button" key={turn.id} onClick={() => onSelectTurn(turn.id)}><span>T{turn.index}</span><b>{turn.total}</b><span>{turn.cache}</span><span>{turn.io}</span><span>{turn.tools}</span><span>{turn.context}</span></button>)}</div></details><p className="panel-source-note">按轮次统计 Token；不同厂商与模型不换算金额，也不把整轮 Token 分摊给具体工具。</p></div>
}

function TrustPanel({ trust }) {
  const [refreshing, setRefreshing] = React.useState(false)
  const refresh = () => { setRefreshing(true); window.setTimeout(() => setRefreshing(false), 700) }
  return <div className="overview-scroll-content trust-panel-real"><section className="panel-heading-real"><div><h3>MCP 信任</h3><span>{trust.status}</span></div><div><button type="button" onClick={refresh}><ScryIcon name="refresh" />{refreshing ? '刷新中…' : '刷新 MCP 状态'}</button><button type="button" disabled><ScryIcon name="shield" />扫描当前 MCP</button></div></section><div className="trust-runtime-real"><span>运行时 · {trust.provider}</span><p>{trust.reason}</p></div>{trust.live?.length > 0 && <section className="overview-plain-section"><header><h4>需要关注</h4><span>{trust.live.length}</span></header>{trust.live.map((item) => <div className="trust-gap-real" key={item.label}><StatusMark state="warning" compact /><b>{item.label}</b><span>{item.detail}</span></div>)}</section>}<div className="trust-wait-real"><ScryIcon name="lock" /><b>没有扫描报告</b><p>SQLite 只记录真实 MCP 调用；live 授权与 MCP Guard 报告不在数据库中，因此不伪造风险 KPI、Fleet 或认证标签。</p></div></div>
}

function OverviewPanel({ displayState, selectedEvent, onSelectEvent }) {
  const overview = sampleData.overview
  const [tab, setTab] = React.useState('overview')
  const [dataTab, setDataTab] = React.useState('turns')
  const [expandedKey, setExpandedKey] = React.useState('')
  const [internalSelected, setInternalSelected] = React.useState(selectedEvent || 'turn-01')
  const activeEventId = selectedEvent ?? internalSelected
  const selectTurn = (turnId) => { setInternalSelected(turnId); onSelectEvent?.(turnId) }
  return (
    <aside className="overview-panel" data-screen-label="总览 · 当前会话证据" aria-label="当前执行总览"><div className="overview-sticky-head"><div className="overview-title-row"><span><b>总览</b><small>当前执行</small></span><SampleStamp compact /></div><nav className="overview-tabs" aria-label="总览面板章节">{[['overview', '纵览'], ['billing', '账单卫士'], ['trust', 'MCP 信任']].map(([id, label]) => <button type="button" key={id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}>{label}</button>)}</nav></div>
      {tab === 'overview' && <div className="overview-scroll-content">{displayState === 'error' ? <div className="panel-state-real"><ScryIcon name="alert" /><b>纵览读取失败</b><p>保持上一次可信状态，不把失败解释成 0。</p></div> : displayState === 'empty' ? <div className="panel-state-real"><ScryIcon name="box" /><b>等待会话证据</b><p>完成一轮任务后显示 Context、调用与文件足迹。</p></div> : <><ContextGauge context={overview.context} /><section className={`overview-verdict state-${overview.verdictState}`}><span className="verdict-line"><i></i><b>{overview.verdict}</b></span><span>{overview.metrics[2]?.value || 0} calls</span></section><div className="overview-metric-grid">{overview.metrics.map((metric) => <OverviewMetric key={metric.label} metric={metric} />)}</div><div className="verdict-foot-real">{overview.cache.map((item) => <span key={item.label}><em>{item.label}</em><b>{item.value}</b></span>)}</div><section className="session-facts-real"><header><h4>会话</h4></header><div><span>sessionId</span><code title={overview.sessionId}>{overview.sessionId}</code></div><div><span>Compact</span><b>{overview.compactions} 次</b></div></section><nav className="overview-data-tabs-real" role="tablist" aria-label="纵览数据维度"><button type="button" className={dataTab === 'turns' ? 'active' : ''} onClick={() => setDataTab('turns')}>轮次数据</button><button type="button" className={dataTab === 'session' ? 'active' : ''} onClick={() => setDataTab('session')}>会话数据</button></nav>{dataTab === 'turns' ? <section className="turn-calls-real"><header><h4>每轮调用</h4><span>{overview.turns.length} turns</span></header>{overview.turns.map((turn) => <TurnCallRow key={turn.id} turn={turn} selected={activeEventId === turn.id} expandedKey={expandedKey} onSelect={selectTurn} onToggle={(key) => setExpandedKey((value) => value === key ? '' : key)} />)}<p className="panel-source-note">Txx 跳回左侧对应用户消息；明细从原始 TraceEvent 聚合。</p></section> : <SessionDataPanel overview={overview} />}</>}</div>}
      {tab === 'billing' && <BillingPanel billing={overview.billing} onSelectTurn={selectTurn} />}{tab === 'trust' && <TrustPanel trust={overview.trust} />}
    </aside>
  )
}

Object.assign(window, { WelcomeSurface, ChatSurface, OverviewPanel })
