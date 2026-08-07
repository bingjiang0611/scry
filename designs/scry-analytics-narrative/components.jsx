function formatSampleTokens(k, partial = false) {
  if (k == null) return '未知'
  if (k >= 1000) return `${partial ? '≥ ' : ''}${(k / 1000).toFixed(2)}M`
  return `${partial ? '≥ ' : ''}${k}k`
}

function providerColor(id) {
  return `var(--provider-${id})`
}

function providerById(id) {
  return scryAnalyticsSample.providers.find((provider) => provider.id === id)
}

function sampleFieldCells(day, maxK) {
  const capacity = 14
  const filled = day.totalK === 0 ? 0 : Math.max(1, Math.round((day.totalK / maxK) * capacity))
  const providers = []
  const total = Math.max(1, day.totalK)

  for (let index = 0; index < filled; index += 1) {
    const point = (index + 0.5) / filled
    let cumulative = 0
    let provider = 'claude'
    for (const id of scryProviderIds) {
      cumulative += day.providers[id] / total
      if (point <= cumulative) {
        provider = id
        break
      }
    }
    providers.push(provider)
  }

  return [...Array.from({ length: capacity - filled }, () => null), ...providers]
}

function PrototypeControls({ theme, methodOpen, selectedProvider, onTheme, onMethod, onClearProvider }) {
  const selected = providerById(selectedProvider)
  return (
    <header className="prototype-controls" aria-label="设计原型控制栏">
      <div className="prototype-identity">
        <strong>SCRY · ANALYTICS V2</strong>
        <span>Run Streak 参考方向</span>
        <em>示例数据 · 不连接 SQLite</em>
      </div>
      <div className="prototype-focus" aria-live="polite">
        <span className="focus-pulse"></span>
        {selected ? <><b>{selected.short}</b><small>仅高亮，不改变汇总口径</small></> : <><b>ALL PROVIDERS</b><small>未高亮单一 Provider</small></>}
        {selected && <button type="button" onClick={onClearProvider} aria-label="清除 Provider 高亮">×</button>}
      </div>
      <div className="prototype-actions">
        <button type="button" onClick={onTheme}><ScryAnalyticsIcon name={theme === 'dark' ? 'sun' : 'moon'} />{theme === 'dark' ? '浅色' : '深色'}</button>
        <button type="button" className={methodOpen ? 'active' : ''} onClick={onMethod} aria-expanded={methodOpen}><ScryAnalyticsIcon name="info" />口径</button>
      </div>
    </header>
  )
}

function WindowTitlebar() {
  return (
    <div className="window-titlebar">
      <div className="traffic-lights" aria-hidden="true"><i></i><i></i><i></i></div>
      <span className="window-title">Scry</span>
      <span className="window-local"><i></i>LOCAL</span>
    </div>
  )
}

function SidebarNavItem({ icon, label, active = false, badge = '' }) {
  return (
    <button type="button" className={`sidebar-nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
      <ScryAnalyticsIcon name={icon} />
      <span>{label}</span>
      {badge && <em>{badge}</em>}
    </button>
  )
}

function ScrySidebar() {
  return (
    <aside className="scry-sidebar" aria-label="Scry 主导航">
      <div className="sidebar-brand"><span>S</span><strong>Scry</strong><em>0.2.32</em></div>
      <button type="button" className="sidebar-new"><ScryAnalyticsIcon name="plus" /><span>新建会话</span><kbd>⌘N</kbd></button>
      <label className="sidebar-search"><ScryAnalyticsIcon name="search" /><input readOnly value="" placeholder="搜索会话或项目" /></label>
      <nav className="sidebar-nav">
        <SidebarNavItem icon="chart" label="分析" active />
        <SidebarNavItem icon="pulse" label="诊断" badge="1" />
        <SidebarNavItem icon="box" label="技能" badge="31" />
        <SidebarNavItem icon="grid" label="MCP" badge="0/15" />
      </nav>
      <div className="sidebar-section-title"><span>最近会话</span><b>7</b></div>
      <div className="sidebar-project">
        <div className="sidebar-project-head"><ScryAnalyticsIcon name="chevron" size={13} /><span><b>rate-native</b><small>treehouse</small></span></div>
        <button type="button" className="sidebar-session"><i className="provider-dot claude"></i><span>hello</span><time>6d</time></button>
        <button type="button" className="sidebar-session"><i className="provider-dot qoder"></i><span>/rate-native-rate…</span><time>1w</time></button>
      </div>
      <div className="sidebar-project">
        <div className="sidebar-project-head"><ScryAnalyticsIcon name="chevron" size={13} /><span><b>scry</b><small>local</small></span></div>
        <button type="button" className="sidebar-session"><i className="provider-dot codex"></i><span>优化 Analytics</span><time>now</time></button>
      </div>
      <div className="sidebar-footer"><ScryAnalyticsIcon name="settings" /><span>设置</span></div>
    </aside>
  )
}

function AnalyticsHeader({ activeChapter, selectedProvider, onChapter, onClearProvider }) {
  const selected = providerById(selectedProvider)
  return (
    <header className="analytics-header">
      <div className="analytics-heading">
        <span className="analytics-kicker">ANALYTICS</span>
        <b>{activeChapter.index} · {activeChapter.label}</b>
      </div>
      <nav className="chapter-tabs" aria-label="分析章节">
        {scryAnalyticsSample.chapters.map((chapter) => (
          <button type="button" key={chapter.id} className={chapter.id === activeChapter.id ? 'active' : ''} onClick={() => onChapter(chapter.id)} aria-label={`跳到${chapter.label}`}>
            <span>{chapter.index}</span>{chapter.short}
          </button>
        ))}
      </nav>
      <div className={`analytics-selected ${selected ? 'is-set' : ''}`}>
        <span className="focus-pulse"></span>
        <b>{selected ? selected.short : 'ALL'}</b>
        {selected && <button type="button" onClick={onClearProvider} aria-label="清除 Provider 高亮"><ScryAnalyticsIcon name="x" size={12} /></button>}
      </div>
    </header>
  )
}

function ChapterRail({ activeChapter, onChapter }) {
  return (
    <nav className="chapter-rail" aria-label="章节快捷导航">
      {scryAnalyticsSample.chapters.map((chapter) => (
        <button type="button" key={chapter.id} className={chapter.id === activeChapter.id ? 'active' : ''} onClick={() => onChapter(chapter.id)} aria-label={chapter.label} title={chapter.label}>
          <i></i><span>{chapter.short}</span>
        </button>
      ))}
    </nav>
  )
}

function DataSourceLine({ children }) {
  return <div className="data-source-line"><span>SOURCE</span><i></i><b>{children}</b></div>
}

function FieldDayLedger({ day }) {
  const partial = day.status === 'partial'
  return (
    <div className={`day-ledger ${partial ? 'partial' : ''}`} aria-live="polite">
      <div className="day-ledger-title">
        <span>{day.day}</span>
        <strong>{formatSampleTokens(day.totalK, partial)} <small>已知 Token</small></strong>
      </div>
      <div className="ledger-row"><span>INPUT</span><i></i><b>{formatSampleTokens(day.inputK, partial)}</b></div>
      <div className="ledger-row"><span>OUTPUT</span><i></i><b>{formatSampleTokens(day.outputK, partial)}</b></div>
      <div className="ledger-row"><span>TURNS</span><i></i><b>{day.turns}</b></div>
      <div className="ledger-row"><span>COVERAGE</span><i></i><b>{day.knownTurns}/{day.turns} 完整</b></div>
      <p>{partial ? '该日存在缺字段轮次；显示的是已知下界，不参与精确环比。' : day.turns === 0 ? '这一天没有会话，是可证明的真实 0。' : 'input 与 output 均由 Provider 上报；本日轮次完整。'}</p>
    </div>
  )
}

function FieldChart({ days, selectedDay, selectedProvider, onDay }) {
  const maxK = Math.max(...days.map((day) => day.totalK), 1)
  const selected = days.find((day) => day.day === selectedDay) || days.find((day) => day.totalK === maxK) || days[0]

  return (
    <div className="field-visual">
      <div className="field-chart-head">
        <span>ONE BLOCK ≈ 23k OBSERVED TOKEN</span>
        <span>30 DAYS · 31 TURNS</span>
      </div>
      <div className="field-chart" role="group" aria-label="近 30 天已知 Token 密度场">
        {days.map((day, dayIndex) => {
          const cells = sampleFieldCells(day, maxK)
          const partial = day.status === 'partial'
          return (
            <button type="button" key={day.day} className={`field-day ${day.day === selected.day ? 'selected' : ''} ${partial ? 'partial' : ''}`} onClick={() => onDay(day.day)} aria-label={`${day.day}，${formatSampleTokens(day.totalK, partial)} 已知 Token，${day.knownTurns}/${day.turns} 轮完整`}>
              <span className="field-cells">
                {cells.map((provider, index) => <i key={index} className={provider ? `filled provider-${provider} ${selectedProvider && provider !== selectedProvider ? 'dimmed' : ''}` : 'empty'}></i>)}
              </span>
              {(dayIndex === 0 || dayIndex === 14 || dayIndex === 29) && <time>{day.day}</time>}
            </button>
          )
        })}
      </div>
      <div className="field-legend">
        {scryAnalyticsSample.providers.map((provider) => <span key={provider.id}><i className={`provider-${provider.id}`}></i>{provider.short}</span>)}
        <span><i className="legend-partial"></i>PARTIAL</span>
      </div>
      <FieldDayLedger day={selected} />
    </div>
  )
}

function FieldChapter({ selectedDay, selectedProvider, onDay }) {
  const days = scryAnalyticsSample.days
  const active = days.filter((day) => day.turns > 0)
  const observedK = days.reduce((sum, day) => sum + day.totalK, 0)
  const topThreeK = [...days].sort((a, b) => b.totalK - a.totalK).slice(0, 3).reduce((sum, day) => sum + day.totalK, 0)
  const concentration = Math.round((topThreeK / observedK) * 100)
  return (
    <section id="field" className="analytics-chapter field-chapter" data-screen-label="00 · 近 30 天">
      <div className="chapter-story">
        <div className="chapter-index">00 · THE FIELD</div>
        <span className="story-eyebrow">近 30 天 · 已知下界</span>
        <div className="story-number">{formatSampleTokens(observedK, true)}</div>
        <div className="story-unit">已知 Token</div>
        <h2>Token 没有均匀发生：三个高峰日承载了 {concentration}% 的已知量。</h2>
        <p>每一列是一天，每个色块代表约 23k 已上报 Token。斜纹列含缺字段轮次；它保留已知量，但不伪装成完整总量。</p>
        <div className="story-metrics">
          <span><b>{active.length}</b><small>活跃日</small></span>
          <span><b>{scryAnalyticsSample.meta.turns}</b><small>轮次</small></span>
          <span><b>{scryAnalyticsSample.meta.knownTurns}/{scryAnalyticsSample.meta.turns}</b><small>完整</small></span>
        </div>
        <DataSourceLine>Provider result · 结构仿真</DataSourceLine>
      </div>
      <FieldChart days={days} selectedDay={selectedDay} selectedProvider={selectedProvider} onDay={onDay} />
    </section>
  )
}

function ProviderLedger({ provider }) {
  if (!provider) {
    return <div className="provider-ledger empty"><span>选择一个 Provider</span><p>高亮会贯穿 30 天密度场、覆盖表与风险能力说明，但不会改变页面汇总口径。</p></div>
  }
  const partial = provider.known < provider.turns
  return (
    <div className="provider-ledger">
      <header><i className={`provider-${provider.id}`}></i><span>{provider.label}</span><b>{formatSampleTokens(provider.tokensK, partial)}</b></header>
      <div className="ledger-row"><span>TOKEN COVERAGE</span><i></i><b>{provider.known}/{provider.turns} turns</b></div>
      <div className="ledger-row"><span>CACHE REUSE</span><i></i><b>{provider.cache == null ? '未知' : `${(provider.cache * 100).toFixed(1)}%`}</b></div>
      <div className="ledger-row"><span>CACHE BASIS</span><i></i><b>{provider.cacheLabel}</b></div>
      <div className="ledger-row"><span>DANGER</span><i></i><b className={provider.danger}>{provider.dangerLabel}</b></div>
      <p>{provider.danger === 'unsupported' ? '未支持分类不能解释为“0 危险”；风险数字对该 Provider 不成立。' : `已分类观测：${provider.risk}。审计只观测，不拦截。`}</p>
    </div>
  )
}

function ProviderChapter({ selectedProvider, onProvider }) {
  const maxTokens = Math.max(...scryAnalyticsSample.providers.map((provider) => provider.tokensK))
  const provider = providerById(selectedProvider)
  return (
    <section id="providers" className="analytics-chapter providers-chapter" data-screen-label="01 · Provider 覆盖">
      <div className="chapter-story">
        <div className="chapter-index">01 · COVERAGE</div>
        <span className="story-eyebrow">近 30 天 · 证据优先</span>
        <div className="story-number">28<span>/31</span></div>
        <div className="story-unit">轮次具备完整 Token</div>
        <h2>覆盖度先于 Token 排名；不完整的总量只能是下界。</h2>
        <p>颜色只表示 Provider 类别，长度只表示已知 Token。青色轮廓专门保留给当前高亮对象，不复用为普通数据色。</p>
        <DataSourceLine>Provider coverage · cache formula</DataSourceLine>
      </div>
      <div className="provider-visual">
        <div className="provider-table-head"><span>PROVIDER</span><span>KNOWN / TURNS</span><span>OBSERVED TOKEN</span></div>
        <div className="provider-ladder">
          {scryAnalyticsSample.providers.map((item, index) => {
            const selected = item.id === selectedProvider
            const partial = item.known < item.turns
            return (
              <button type="button" key={item.id} className={`provider-row ${selected ? 'selected' : ''}`} onClick={() => onProvider(selected ? null : item.id)} aria-pressed={selected}>
                <span className="provider-rank">0{index + 1}</span>
                <span className="provider-name"><i className={`provider-${item.id}`}></i><b>{item.label}</b><small>{item.short}</small></span>
                <span className="provider-coverage"><b>{item.known}/{item.turns}</b><i><em style={{ width: `${(item.known / item.turns) * 100}%` }}></em></i></span>
                <span className="provider-tokens"><b>{formatSampleTokens(item.tokensK, partial)}</b><i><em className={`provider-${item.id}`} style={{ width: `${(item.tokensK / maxTokens) * 100}%` }}></em></i></span>
                <span className="provider-state"><em className={item.danger}>{item.dangerLabel}</em><ScryAnalyticsIcon name="chevron" size={13} /></span>
              </button>
            )
          })}
        </div>
        <ProviderLedger provider={provider} />
      </div>
    </section>
  )
}

function OperationsChapter({ selectedProvider }) {
  const tools = selectedProvider ? scryAnalyticsSample.tools.filter((tool) => tool.provider === selectedProvider) : scryAnalyticsSample.tools
  const shownTools = tools.length ? tools : scryAnalyticsSample.tools
  const topTool = [...shownTools].sort((a, b) => b.calls - a.calls)[0]
  const providerLabel = selectedProvider ? providerById(selectedProvider).label : '全 Provider'
  const maxCalls = Math.max(...shownTools.map((tool) => tool.calls), 1)
  return (
    <section id="operations" className="analytics-chapter operations-chapter" data-screen-label="02 · 工具与延迟">
      <div className="chapter-story">
        <div className="chapter-index">02 · OPERATIONS</div>
        <span className="story-eyebrow">全时段 · 调用次数排序</span>
        <div className="story-number">{topTool.calls}</div>
        <div className="story-unit">{topTool.name} calls</div>
        <h2>{topTool.name} 是 {providerLabel} 样本里调用最多的一类。</h2>
        <p>条长只编码调用次数；平均耗时和失败率保留为精确旁注。没有 tool-level Token 归因，因此这里不制造 Token 份额。</p>
        <DataSourceLine>tool spans · completed duration</DataSourceLine>
      </div>
      <div className="operations-visual">
        <div className="operations-heading"><span>{selectedProvider ? `${providerById(selectedProvider).short} HIGHLIGHT` : 'ALL PROVIDERS'}</span><span>CALLS</span><span>AVG</span><span>FAIL</span></div>
        <div className="tool-ranking">
          {shownTools.map((tool, index) => (
            <div className={`tool-row ${selectedProvider && tool.provider !== selectedProvider ? 'dimmed' : ''}`} key={tool.name}>
              <span className="tool-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="tool-name"><b>{tool.name}</b><small>{tool.provider}</small></span>
              <span className="tool-bar"><i style={{ width: `${(tool.calls / maxCalls) * 100}%` }}></i></span>
              <span className="tool-value">{tool.calls}</span>
              <span className="tool-avg">{tool.avg}</span>
              <span className={`tool-fail ${tool.errors ? 'warn' : ''}`}>{tool.errors ? `${tool.errors} err` : '0'}</span>
            </div>
          ))}
        </div>
        <div className="latency-panel">
          <header><span>MCP LATENCY · 90D</span><b>P50</b><b>P95</b><b>FAIL</b></header>
          {scryAnalyticsSample.latency.map((server) => (
            <div className="latency-row" key={server.server}><span><i></i>{server.server}</span><b>{server.p50}</b><b>{server.p95}</b><b className={server.errors ? 'warn' : ''}>{server.errors}</b></div>
          ))}
          <p>仅统计已完成调用；P50 / P95 使用 nearest-rank，失败数不折算为延迟。</p>
        </div>
      </div>
    </section>
  )
}

function RiskChapter({ selectedProvider, onProvider }) {
  const provider = providerById(selectedProvider)
  const supported = !provider || provider.danger === 'classified'
  const events = selectedProvider ? scryAnalyticsSample.riskDays.filter((day) => day.provider === selectedProvider) : scryAnalyticsSample.riskDays
  const danger = events.reduce((sum, day) => sum + day.danger, 0)
  const warn = events.reduce((sum, day) => sum + day.warn, 0)
  return (
    <section id="risk" className="analytics-chapter risk-chapter" data-screen-label="03 · 风险与盲区">
      <div className="chapter-story">
        <div className="chapter-index">03 · RISK</div>
        <span className="story-eyebrow">近 90 天 · 观测不拦截</span>
        <div className={`story-number ${supported ? 'risk-number' : 'unknown-number'}`}>{supported ? danger : '—'}</div>
        <div className="story-unit">{supported ? `${warn} warn · high-risk events` : '分类能力未支持'}</div>
        <h2>{supported ? '危险事件很稀疏；能力盲区却不能被画成安全。' : `${provider.label} 没有分类能力，因而不能得出“零危险”。`}</h2>
        <p>红色与黄色只表示已分类事件。空格表示“在可分类范围内没有事件”；unsupported 用独立口径行解释，不与空格混为一谈。</p>
        <DataSourceLine>danger verdict · provider capability</DataSourceLine>
      </div>
      <div className="risk-visual">
        <div className="risk-head"><span>90 DAYS · MAY 10 — AUG 07</span><span>{selectedProvider ? provider.short : 'CLASSIFIED EVENTS'}</span></div>
        <div className={`risk-grid ${supported ? '' : 'unsupported-view'}`} aria-label="近 90 天危险操作矩阵">
          {scryAnalyticsSample.riskDays.map((day, index) => {
            const filtered = selectedProvider && day.provider && day.provider !== selectedProvider
            const className = day.danger ? 'danger' : day.warn ? 'warn' : 'clear'
            return <button type="button" key={`${day.day}-${index}`} className={`${className} ${filtered ? 'filtered' : ''}`} title={`${day.day} · ${day.reason || '已分类范围内无事件'} · danger ${day.danger} · warn ${day.warn}`} aria-label={`${day.day}，${day.reason || '已分类范围内无事件'}`}></button>
          })}
        </div>
        <div className="risk-legend"><span><i className="danger"></i>DANGER</span><span><i className="warn"></i>WARN</span><span><i className="clear"></i>CLASSIFIED · 0</span><span><i className="unsupported"></i>UNSUPPORTED</span></div>
        <div className="risk-capability">
          <header><span>PROVIDER CAPABILITY</span><b>EVENTS</b><b>INTERPRETATION</b></header>
          {scryAnalyticsSample.providers.map((item) => (
            <button type="button" key={item.id} className={item.id === selectedProvider ? 'selected' : ''} onClick={() => onProvider(item.id === selectedProvider ? null : item.id)} aria-pressed={item.id === selectedProvider}>
              <span><i className={`provider-${item.id}`}></i>{item.label}</span>
              <b>{item.danger === 'classified' ? item.risk : '—'}</b>
              <em className={item.danger}>{item.danger === 'classified' ? '已分类 · 审计放行' : '未支持 · 不等于安全'}</em>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

function AnalyticsContent({ activeChapter, selectedDay, selectedProvider, onChapter, onDay, onProvider, onClearProvider }) {
  return (
    <main className="analytics-main">
      <AnalyticsHeader activeChapter={activeChapter} selectedProvider={selectedProvider} onChapter={onChapter} onClearProvider={onClearProvider} />
      <div className="analytics-scroll" id="analytics-scroll">
        <FieldChapter selectedDay={selectedDay} selectedProvider={selectedProvider} onDay={onDay} />
        <ProviderChapter selectedProvider={selectedProvider} onProvider={onProvider} />
        <OperationsChapter selectedProvider={selectedProvider} />
        <RiskChapter selectedProvider={selectedProvider} onProvider={onProvider} />
        <footer className="analytics-footer"><span>SCRY ANALYTICS · STRUCTURE PROTOTYPE</span><span>UNKNOWN ≠ 0 · UNSUPPORTED ≠ SAFE</span></footer>
      </div>
      <ChapterRail activeChapter={activeChapter} onChapter={onChapter} />
    </main>
  )
}

function MethodPanel({ onClose }) {
  return (
    <div className="method-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="method-panel" role="dialog" aria-modal="true" aria-labelledby="method-title">
        <header><div><span>PROTOTYPE CONTRACT</span><h2 id="method-title">这版只验证数据叙事与交互层级</h2></div><button type="button" onClick={onClose} aria-label="关闭口径说明"><ScryAnalyticsIcon name="x" /></button></header>
        <section>
          <h3>保留的 Scry 红线</h3>
          <div className="method-row"><ScryAnalyticsIcon name="check" /><span><b>Unknown 不按 0 画</b><small>partial 用斜纹与下界符号，真实 0 单独表达。</small></span></div>
          <div className="method-row"><ScryAnalyticsIcon name="check" /><span><b>Unsupported 不解释为安全</b><small>Codex / OpenCode danger capability 单列说明。</small></span></div>
          <div className="method-row"><ScryAnalyticsIcon name="check" /><span><b>一图只编码一个连续变量</b><small>条长表示量；类别色只表示 Provider；青色只表示高亮对象。</small></span></div>
        </section>
        <section>
          <h3>实现前必须修的查询口径</h3>
          <div className="contract-table">
            <span>常用工具</span><b>SQL 当前先按 avgMs 取 8</b><em>改为 calls Top N</em>
            <span>项目轮次</span><b>SQL 当前先按 cost 取 5</b><em>改为 turns Top N</em>
            <span>模型分布</span><b>SQL 当前先按 cost 取 8</b><em>先修查询再展示</em>
            <span>日 Token</span><b>partial 可能被画成实心柱</b><em>knownTurns 不完整即斜纹</em>
          </div>
        </section>
        <p className="method-foot">页面中的数值是结构仿真样本，不代表本机真实 Scry 数据，也不会调用 Provider 或读取 SQLite。</p>
      </aside>
    </div>
  )
}

Object.assign(window, {
  PrototypeControls,
  WindowTitlebar,
  ScrySidebar,
  AnalyticsContent,
  MethodPanel
})
