function ScryPrototypeApp() {
  const variant = 'workbench'
  const [theme, setTheme] = React.useState(() => localStorage.getItem('scry-prototype-theme') || 'dark')
  const [density, setDensity] = React.useState('comfortable')
  const [panelOpen, setPanelOpen] = React.useState(true)
  const [sidebarOpen, setSidebarOpen] = React.useState(true)
  const [tweaksOpen, setTweaksOpen] = React.useState(false)
  const [view, setView] = React.useState('chat')
  const [inspectorTab, setInspectorTab] = React.useState('overview')
  const [dataTab, setDataTab] = React.useState('turn')
  const [query, setQuery] = React.useState('')
  const [selectedSession, setSelectedSession] = React.useState('hello')
  const [composerValue, setComposerValue] = React.useState('')
  const [messages, setMessages] = React.useState([])
  const [toast, setToast] = React.useState('')

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('scry-prototype-theme', theme)
  }, [theme])

  React.useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(''), 2200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const filteredProjects = scryPrototypeData.projects
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => {
        const needle = query.trim().toLowerCase()
        if (!needle) return true
        return `${project.name} ${project.path} ${session.provider} ${session.title}`.toLowerCase().includes(needle)
      })
    }))
    .filter((project) => project.sessions.length > 0)

  const sendPrototypeMessage = () => {
    const value = composerValue.trim()
    if (!value) return
    setMessages((current) => [...current, value])
    setComposerValue('')
    setToast('已验证发送状态；原型未调用 Provider')
  }

  const newPrototypeSession = () => {
    setMessages([])
    setComposerValue('')
    setView('chat')
    setToast('已进入新会话草稿')
  }

  return (
    <div className={`prototype-root density-${density}`}>
      <PrototypeControls
        theme={theme}
        panelOpen={panelOpen}
        tweaksOpen={tweaksOpen}
        onTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
        onPanel={() => setPanelOpen((current) => !current)}
        onTweaks={() => setTweaksOpen((current) => !current)}
      ></PrototypeControls>
      {tweaksOpen && <TweaksPanel
        theme={theme}
        density={density}
        panelOpen={panelOpen}
        onTheme={setTheme}
        onDensity={setDensity}
        onPanel={() => setPanelOpen((current) => !current)}
      ></TweaksPanel>}
      <section className="prototype-stage">
        <div className={`scry-window variant-${variant} ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'} ${panelOpen ? 'panel-open' : 'panel-closed'}`} data-screen-label="A · Workbench">
          <ScryTitlebar sidebarOpen={sidebarOpen} onSidebar={() => setSidebarOpen((current) => !current)}></ScryTitlebar>
          <div className="scry-app-body">
            {sidebarOpen && <Sidebar
              projects={filteredProjects}
              query={query}
              selectedSession={selectedSession}
              theme={theme}
              onQuery={setQuery}
              onSelect={setSelectedSession}
              onNew={newPrototypeSession}
              onTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
            ></Sidebar>}
            <section className="main-workspace">
              <SessionTopbar view={view} panelOpen={panelOpen} variant={variant} onView={setView} onPanel={() => setPanelOpen((current) => !current)}></SessionTopbar>
              <ChatPane
                view={view}
                variant={variant}
                metrics={scryPrototypeData.metrics}
                messages={messages}
                composerValue={composerValue}
                onComposer={setComposerValue}
                onSend={sendPrototypeMessage}
              ></ChatPane>
            </section>
            {panelOpen && <Inspector
              activeTab={inspectorTab}
              dataTab={dataTab}
              metrics={scryPrototypeData.metrics}
              variant={variant}
              onTab={setInspectorTab}
              onDataTab={setDataTab}
              onClose={() => setPanelOpen(false)}
            ></Inspector>}
            {panelOpen && <button type="button" className={`drawer-scrim drawer-scrim-${variant}`} onClick={() => setPanelOpen(false)} aria-label="关闭纵览抽屉"></button>}
          </div>
        </div>
      </section>
      {toast && <div className="prototype-toast" role="status"><ScryIcon name="check"></ScryIcon>{toast}</div>}
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<ScryPrototypeApp></ScryPrototypeApp>)
