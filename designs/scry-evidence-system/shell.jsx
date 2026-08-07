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

function PrototypeBar({ active, theme, displayState, dataState, sessionOptions, selectedSessionId, onSession, onRefresh, onSurface, onTheme, onState }) {
  const dataLabel = dataState === 'ready' ? 'LIVE' : dataState === 'loading' ? 'READING' : dataState === 'stale' ? 'STALE' : 'FALLBACK'
  const dataTitle = dataState === 'ready' ? `${sampleData.meta.db} · 只读` : dataState === 'loading' ? '正在读取本机 SQLite 与 trace archive' : dataState === 'stale' ? `刷新失败；保留 ${sampleData.meta.snapshot} 的上一次真实快照` : '数据桥不可用，当前为结构仿真降级态'
  return (
    <header className="prototype-bar" aria-label="原型控制栏">
      <div className="prototype-brand"><strong>SCRY · EVIDENCE SYSTEM</strong><span>基于现状 · 真实数据验收</span><em>{sampleData.meta.source}</em></div>
      <nav className="prototype-surface-nav" aria-label="快速切换表面">
        {primarySurfaces.map((surface) => <button type="button" key={surface.id} className={cx(active === surface.id && 'active')} onClick={() => onSurface(surface.id)}>{surface.label}</button>)}
      </nav>
      <div className="prototype-actions">
        <span className={cx('live-data-state', `is-${dataState}`)} title={dataTitle}><i></i>{dataLabel}</span>
        <label className="session-control"><span>SESSION</span><select value={selectedSessionId} onChange={(event) => onSession(event.target.value)} aria-label="选择本机真实会话">{sessionOptions.length ? sessionOptions.map((session) => <option value={session.id} key={session.id}>{session.label}</option>) : <option value="">等待 SQLite…</option>}</select></label>
        <button type="button" className="icon-button prototype-refresh" onClick={onRefresh} aria-label="刷新真实数据" disabled={dataState === 'loading'}><ScryIcon name="refresh" /></button>
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

function ScrySidebar({ active, onNavigate, onOpenModal, onSession }) {
  const sessions = Array.isArray(sampleData.sessionOptions) ? sampleData.sessionOptions : []
  const skillCount = sampleData.inventory?.skills?.length ?? sampleData.skillsSummary?.length ?? 0
  const mcpCount = sampleData.inventory?.mcps?.length ?? sampleData.mcpSummary?.length ?? 0
  const diagnosticCount = Array.isArray(sampleData.diagnostics?.issues)
    ? sampleData.diagnostics.issues.filter((issue) => ['warn', 'error'].includes(issue.severity)).length
    : 0
  const groupedSessions = sessions.slice(0, 12).reduce((groups, session) => {
    const key = session.cwd ? session.cwd.split('/').filter(Boolean).at(-1) : '不绑定项目'
    if (!groups[key]) groups[key] = []
    groups[key].push(session)
    return groups
  }, {})
  return (
    <aside className="scry-sidebar" aria-label="Scry 主导航">
      <div className="sidebar-brand"><span>S</span><strong>Scry</strong><em>0.2.32</em></div>
      <button type="button" className="sidebar-new" onClick={() => onNavigate('welcome')}><ScryIcon name="plus" /><span>新建会话</span><kbd>⌘N</kbd></button>
      <label className="sidebar-search"><ScryIcon name="search" /><input placeholder="搜索会话或项目" aria-label="搜索会话或项目" /></label>
      <nav className="sidebar-global">
        <SidebarItem icon="chart" label="分析" active={active === 'analytics'} onClick={() => onNavigate('analytics')} />
        <SidebarItem icon="pulse" label="诊断" active={active === 'diagnostics'} badge={diagnosticCount ? String(diagnosticCount) : null} onClick={() => onNavigate('diagnostics')} />
        <SidebarItem icon="box" label="技能" badge={String(skillCount)} onClick={() => onOpenModal('skills')} />
        <SidebarItem icon="grid" label="MCP" badge={String(mcpCount)} onClick={() => onOpenModal('mcp')} />
      </nav>
      <div className="sidebar-section-title"><span>最近会话</span><b>{sessions.length || 3}</b></div>
      {sessions.length ? Object.entries(groupedSessions).map(([project, items]) => (
        <div className="sidebar-project" key={project}>
          <div className="sidebar-project-title"><ScryIcon name="down" size={13} /><span><b>{project}</b><small>{items.length}</small></span></div>
          {items.map((session) => <button type="button" key={session.id} className={cx('sidebar-session', session.id === sampleData.meta.selectedSessionId && ['chat', 'graph', 'segments'].includes(active) && 'active')} onClick={() => { onSession?.(session.id); onNavigate('chat') }} title={session.label}><i className={`provider-dot ${session.provider}`}></i><span>{session.label.split(' · ').slice(2).join(' · ') || session.provider}</span><time>{session.turns}t</time></button>)}
        </div>
      )) : <>
        <div className="sidebar-project"><div className="sidebar-project-title"><ScryIcon name="down" size={13} /><span><b>rate-native</b><small>treehouse</small></span></div><button type="button" className={cx('sidebar-session', ['chat', 'graph', 'segments'].includes(active) && 'active')} onClick={() => onNavigate('chat')}><i className="provider-dot codex"></i><span>/rate-workflow 84441907</span><time>now</time></button></div>
      </>}
      <button type="button" className="sidebar-settings"><ScryIcon name="settings" /><span>设置</span></button>
    </aside>
  )
}

function SessionChrome({ active, onNavigate, showPanel, showWorkspace, onTogglePanel, onToggleWorkspace }) {
  const provider = sampleData.chat?.provider || 'Codex'
  const providerId = sampleData.meta?.providerId || provider.toLowerCase().replace(' code', '')
  return (
    <header className="session-chrome">
      <nav className="session-tabs" aria-label="会话视图">
        <button type="button" className={cx(active === 'chat' && 'active')} onClick={() => onNavigate('chat')}><ScryIcon name="message" />对话</button>
        <button type="button" className={cx(active === 'graph' && 'active')} onClick={() => onNavigate('graph')}><ScryIcon name="branch" />拓扑</button>
        <button type="button" className={cx(active === 'segments' && 'active')} onClick={() => onNavigate('segments')}><ScryIcon name="layers" />分段</button>
      </nav>
      <div className="session-spacer"></div>
      <div className="session-actions" aria-label="会话工具">
        <span className="agent-pill"><i className={`provider-dot ${providerId}`}></i>{provider}</span>
        {active === 'chat' && <button type="button" className={cx('panel-pill', showWorkspace && 'on')} aria-pressed={showWorkspace} onClick={onToggleWorkspace}><ScryIcon name="folder" />文件</button>}
        {active === 'chat' && <button type="button" className={cx('panel-pill', showPanel && 'on')} aria-pressed={showPanel} onClick={onTogglePanel}><ScryIcon name="grid" />纵览</button>}
      </div>
    </header>
  )
}

function WorkspacePanel({ onClose }) {
  const files = sampleData.overview?.files || []
  const cwd = sampleData.chat?.cwd || '不绑定项目'
  const modeLabel = (mode) => ({ read: 'R', write: 'W', edit: 'E' }[mode] || String(mode || '—').toUpperCase())
  return (
    <aside className="workspace-drawer" aria-label="工作区文件">
      <header><span><ScryIcon name="folder" />文件</span><button type="button" className="icon-button" onClick={onClose} aria-label="关闭文件面板"><ScryIcon name="x" /></button></header>
      <div className="workspace-root">{cwd.split('/').filter(Boolean).at(-1) || '不绑定项目'} <small title={cwd}>{cwd}</small></div>
      {files.length ? files.map((file, index) => <button type="button" className="workspace-file" key={`${file.label}-${index}`} title={file.label}><ScryIcon name={file.mode === 'read' ? 'fileText' : 'file'} /><span>{file.label.split('/').filter(Boolean).at(-1) || file.label}</span><em>{modeLabel(file.mode)} ×{file.count}</em></button>) : <div className="workspace-empty">当前会话没有结构化文件证据</div>}
      <p>来自 SQLite file_ops；只统计可从结构化工具输入确认的 R/W/E。</p>
    </aside>
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

function ScryWindow({ active, modal, displayState, dataEpoch, onNavigate, onOpenModal, onCloseModal, onSession }) {
  const [selectedEvent, setSelectedEvent] = React.useState('turn-01')
  const [showOverview, setShowOverview] = React.useState(true)
  const [showWorkspace, setShowWorkspace] = React.useState(false)
  const hasOverview = active === 'chat' && showOverview
  const isSession = ['chat', 'graph', 'segments'].includes(active)
  const inventoryProvider = sampleData.chat?.provider || sampleData.meta?.providerId || 'Provider 未知'
  const inventoryWorkspace = sampleData.meta?.workspace || '工作区未知'
  React.useEffect(() => setSelectedEvent('turn-01'), [dataEpoch])
  return (
    <section className="scry-window" data-screen-label={`Scry · ${primarySurfaces.find((surface) => surface.id === (modal || active))?.label || active}`}>
      <WindowTitlebar />
      <div className={cx('scry-body', hasOverview && 'has-overview')}>
        <ScrySidebar active={active} onNavigate={onNavigate} onOpenModal={onOpenModal} onSession={onSession} />
        <main className="main-stack">
          {isSession && <SessionChrome active={active} onNavigate={onNavigate} showPanel={showOverview} showWorkspace={showWorkspace} onTogglePanel={() => setShowOverview((value) => !value)} onToggleWorkspace={() => setShowWorkspace((value) => !value)} />}
          <div className={cx('surface-host', `surface-${active}`)}>
            <SurfaceRenderer active={active} displayState={displayState} selectedEvent={selectedEvent} onSelectEvent={setSelectedEvent} />
          </div>
          {active === 'chat' && showWorkspace && <WorkspacePanel onClose={() => setShowWorkspace(false)} />}
        </main>
        {hasOverview && React.createElement(window.OverviewPanel, { displayState, selectedEvent, onSelectEvent: setSelectedEvent })}
      </div>
      {modal === 'skills' && <ModalFrame title="技能清单" subtitle={`${inventoryProvider} · ${inventoryWorkspace} · 仅列真实调用证据`} onClose={onCloseModal}>{['empty', 'error'].includes(displayState) ? <EmptyState kind={displayState} /> : React.createElement(window.SkillsModalContent, { displayState, key: `skills-${dataEpoch}` })}</ModalFrame>}
      {modal === 'mcp' && <ModalFrame title="MCP Fleet" subtitle="配置、运行时、测试与认证证据彼此独立" onClose={onCloseModal}>{['empty', 'error'].includes(displayState) ? <EmptyState kind={displayState} /> : React.createElement(window.McpModalContent, { displayState, key: `mcp-${dataEpoch}` })}</ModalFrame>}
    </section>
  )
}

Object.assign(window, { primarySurfaces, PrototypeBar, ScryWindow })
