const primarySurfaces = [
  { id: 'welcome', label: '欢迎页', icon: 'plus' },
  { id: 'chat', label: '对话', icon: 'message' },
  { id: 'analytics', label: '分析', icon: 'chart' },
  { id: 'diagnostics', label: '诊断', icon: 'pulse' },
  { id: 'graph', label: '拓扑', icon: 'branch' },
  { id: 'segments', label: '分段', icon: 'layers' },
  { id: 'skills', label: '技能', icon: 'box', modal: true },
  { id: 'mcp', label: 'MCP', icon: 'grid', modal: true },
  { id: 'overview', label: '总览', icon: 'eye', alias: 'chat' }
]

function PrototypeBar({ active, theme, displayState, onSurface, onTheme, onState }) {
  return (
    <header className="prototype-bar" aria-label="原型控制栏">
      <div className="prototype-brand"><strong>SCRY · EVIDENCE SYSTEM</strong><span>九表面统一原型</span><em>{sampleData.meta.source}</em></div>
      <nav className="prototype-surface-nav" aria-label="快速切换表面">
        {primarySurfaces.map((surface) => <button type="button" key={surface.id} className={cx(active === surface.id && 'active')} onClick={() => onSurface(surface.id)}>{surface.label}</button>)}
      </nav>
      <div className="prototype-actions">
        <label className="state-control"><span>STATE</span><select value={displayState} onChange={(event) => onState(event.target.value)} aria-label="数据状态"><option value="ready">Ready</option><option value="partial">Partial</option><option value="empty">Empty</option><option value="error">Error</option></select></label>
        <button type="button" className="toolbar-button" onClick={onTheme}><ScryIcon name={theme === 'dark' ? 'sun' : 'moon'} />{theme === 'dark' ? '浅色' : '深色'}</button>
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

function SidebarItem({ icon, label, active, badge, onClick }) {
  return <button type="button" className={cx('sidebar-item', active && 'active')} aria-current={active ? 'page' : undefined} onClick={onClick}><ScryIcon name={icon} /><span>{label}</span>{badge && <em>{badge}</em>}</button>
}

function ScrySidebar({ active, onNavigate, onOpenModal }) {
  return (
    <aside className="scry-sidebar" aria-label="Scry 主导航">
      <div className="sidebar-brand"><span>S</span><strong>Scry</strong><em>0.2.32</em></div>
      <button type="button" className="sidebar-new" onClick={() => onNavigate('welcome')}><ScryIcon name="plus" /><span>新建会话</span><kbd>⌘N</kbd></button>
      <label className="sidebar-search"><ScryIcon name="search" /><input placeholder="搜索会话或项目" aria-label="搜索会话或项目" /></label>
      <nav className="sidebar-global">
        <SidebarItem icon="chart" label="分析" active={active === 'analytics'} onClick={() => onNavigate('analytics')} />
        <SidebarItem icon="pulse" label="诊断" active={active === 'diagnostics'} badge="1" onClick={() => onNavigate('diagnostics')} />
        <SidebarItem icon="box" label="技能" badge="31" onClick={() => onOpenModal('skills')} />
        <SidebarItem icon="grid" label="MCP" badge="2/4" onClick={() => onOpenModal('mcp')} />
      </nav>
      <div className="sidebar-section-title"><span>最近会话</span><b>3</b></div>
      <div className="sidebar-project">
        <div className="sidebar-project-title"><ScryIcon name="down" size={13} /><span><b>scry</b><small>local</small></span></div>
        <button type="button" className={cx('sidebar-session', ['chat', 'graph', 'segments'].includes(active) && 'active')} onClick={() => onNavigate('chat')}><i className="provider-dot codex"></i><span>优化 Analytics 叙事</span><time>now</time></button>
      </div>
      <div className="sidebar-project">
        <div className="sidebar-project-title"><ScryIcon name="down" size={13} /><span><b>rate-native</b><small>treehouse</small></span></div>
        <button type="button" className="sidebar-session"><i className="provider-dot claude"></i><span>验证 rate workflow</span><time>6d</time></button>
        <button type="button" className="sidebar-session"><i className="provider-dot qoder"></i><span>/rate-native-rate…</span><time>1w</time></button>
      </div>
      <button type="button" className="sidebar-settings"><ScryIcon name="settings" /><span>设置</span></button>
    </aside>
  )
}

function SessionChrome({ active, onNavigate }) {
  return (
    <header className="session-chrome">
      <div className="session-identity"><i className="provider-dot codex"></i><span><strong>优化 Analytics 叙事</strong><small>scry · codex/scry-editorial-ui</small></span><StatusMark status="running" label="ACTIVE" compact /></div>
      <nav className="session-tabs" aria-label="会话视图">
        <button type="button" className={cx(active === 'chat' && 'active')} onClick={() => onNavigate('chat')}><ScryIcon name="message" />对话</button>
        <button type="button" className={cx(active === 'graph' && 'active')} onClick={() => onNavigate('graph')}><ScryIcon name="branch" />拓扑</button>
        <button type="button" className={cx(active === 'segments' && 'active')} onClick={() => onNavigate('segments')}><ScryIcon name="layers" />分段</button>
      </nav>
      <div className="session-actions"><span>Claude Code</span><button type="button" className="icon-button" aria-label="更多"><ScryIcon name="more" /></button></div>
    </header>
  )
}

function EmptyState({ kind }) {
  const error = kind === 'error'
  return <div className="surface-state"><span className={cx('state-glyph', error && 'error')}><ScryIcon name={error ? 'alert' : 'box'} size={20} /></span><h2>{error ? '证据读取失败' : '当前范围没有可展示的证据'}</h2><p>{error ? '保持上一次可信状态，不把请求失败解释成 0。' : '连接 Provider 或运行一次任务后，这里会按真实范围建立账本。'}</p><button type="button" className="secondary-button"><ScryIcon name="refresh" />{error ? '重新读取' : '刷新范围'}</button></div>
}

function SurfaceRenderer({ active, displayState, selectedEvent, onSelectEvent }) {
  if ((displayState === 'empty' || displayState === 'error') && !['welcome', 'chat'].includes(active)) return <EmptyState kind={displayState} />
  const props = { displayState, selectedEvent, onSelectEvent }
  if (active === 'welcome') return React.createElement(window.WelcomeSurface, props)
  if (active === 'chat') return React.createElement(window.ChatSurface, props)
  if (active === 'analytics') return React.createElement(window.AnalyticsSurface, props)
  if (active === 'diagnostics') return React.createElement(window.DiagnosticsSurface, props)
  if (active === 'graph') return React.createElement(window.ExecutionGraphSurface, props)
  if (active === 'segments') return React.createElement(window.SegmentsSurface, props)
  return React.createElement(window.WelcomeSurface, props)
}

function ScryWindow({ active, modal, displayState, onNavigate, onOpenModal, onCloseModal }) {
  const [selectedEvent, setSelectedEvent] = React.useState('turn-4')
  const hasOverview = active === 'chat'
  const isSession = ['chat', 'graph', 'segments'].includes(active)
  return (
    <section className="scry-window" data-screen-label={`Scry · ${primarySurfaces.find((surface) => surface.id === (modal || active))?.label || active}`}>
      <WindowTitlebar />
      <div className={cx('scry-body', hasOverview && 'has-overview')}>
        <ScrySidebar active={active} onNavigate={onNavigate} onOpenModal={onOpenModal} />
        <main className="main-stack">
          {isSession && <SessionChrome active={active} onNavigate={onNavigate} />}
          <div className={cx('surface-host', `surface-${active}`)}>
            <SurfaceRenderer active={active} displayState={displayState} selectedEvent={selectedEvent} onSelectEvent={setSelectedEvent} />
          </div>
        </main>
        {hasOverview && React.createElement(window.OverviewPanel, { displayState, selectedEvent, onSelectEvent: setSelectedEvent })}
      </div>
      {modal === 'skills' && <ModalFrame title="技能清单" subtitle="Claude Code · /scry · project + user scope" onClose={onCloseModal}>{['empty', 'error'].includes(displayState) ? <EmptyState kind={displayState} /> : React.createElement(window.SkillsModalContent, { displayState })}</ModalFrame>}
      {modal === 'mcp' && <ModalFrame title="MCP Fleet" subtitle="配置、运行时、测试与认证证据彼此独立" onClose={onCloseModal}>{['empty', 'error'].includes(displayState) ? <EmptyState kind={displayState} /> : React.createElement(window.McpModalContent, { displayState })}</ModalFrame>}
    </section>
  )
}

Object.assign(window, { primarySurfaces, PrototypeBar, ScryWindow })
