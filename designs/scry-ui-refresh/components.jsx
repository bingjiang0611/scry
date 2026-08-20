function PrototypeControls({ theme, panelOpen, tweaksOpen, onTheme, onPanel, onTweaks }) {
  return (
    <header className="prototype-controls" aria-label="原型控制栏">
      <div className="prototype-mark">
        <span className="prototype-kicker">SCRY</span>
        <span className="prototype-title">UI Refresh</span>
        <span className="prototype-note">示例数据 · 不连接 Provider</span>
      </div>
      <div className="direction-badge" aria-label="已选设计方向">
        <span>A · Workbench</span>
        <small>三栏工作台</small>
      </div>
      <div className="prototype-actions">
        <button type="button" className="icon-label-button" onClick={onTheme} title="切换深浅主题">
          <ScryIcon name={theme === 'dark' ? 'sun' : 'moon'}></ScryIcon>
          {theme === 'dark' ? '浅色' : '深色'}
        </button>
        <button type="button" className={`icon-label-button ${panelOpen ? 'on' : ''}`} onClick={onPanel} title="显示或隐藏纵览">
          <ScryIcon name="panel"></ScryIcon>
          纵览
        </button>
        <button type="button" className={`icon-label-button ${tweaksOpen ? 'on' : ''}`} onClick={onTweaks} aria-expanded={tweaksOpen}>
          <ScryIcon name="settings"></ScryIcon>
          Tweaks
        </button>
      </div>
    </header>
  )
}

function TweaksPanel({ theme, density, panelOpen, onTheme, onDensity, onPanel }) {
  return (
    <aside className="tweaks-panel" aria-label="原型设置">
      <div className="tweaks-head">
        <div>
          <strong>显示设置</strong>
          <span>仅影响这个原型</span>
        </div>
      </div>
      <label className="tweak-row">
        <span>主题</span>
        <span className="mini-segment">
          <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => onTheme('dark')}>深色</button>
          <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => onTheme('light')}>浅色</button>
        </span>
      </label>
      <label className="tweak-row">
        <span>密度</span>
        <span className="mini-segment">
          <button type="button" className={density === 'compact' ? 'active' : ''} onClick={() => onDensity('compact')}>紧凑</button>
          <button type="button" className={density === 'comfortable' ? 'active' : ''} onClick={() => onDensity('comfortable')}>舒适</button>
        </span>
      </label>
      <label className="tweak-row switch-row">
        <span>
          <b>默认打开纵览</b>
          <small>宽屏三栏常驻，窄屏自动转抽屉</small>
        </span>
        <button type="button" className={`switch ${panelOpen ? 'on' : ''}`} onClick={onPanel} role="switch" aria-checked={panelOpen}>
          <span></span>
        </button>
      </label>
    </aside>
  )
}

function ScryTitlebar({ sidebarOpen, onSidebar }) {
  return (
    <div className="window-titlebar">
      <div className="traffic-light-wrap"><MacTrafficLights></MacTrafficLights></div>
      <button type="button" className={`window-icon-button ${sidebarOpen ? 'on' : ''}`} onClick={onSidebar} title="折叠或展开侧栏" aria-pressed={sidebarOpen}>
        <ScryIcon name="sidebar"></ScryIcon>
      </button>
      <div className="window-name">Scry</div>
      <div className="window-session-state"><span className="status-dot ok"></span> 本地</div>
    </div>
  )
}

function Sidebar({ projects, query, selectedSession, theme, onQuery, onSelect, onNew, onTheme }) {
  const [openProjects, setOpenProjects] = React.useState(() => new Set(projects.map((project) => project.id)))
  const toggleProject = (id) => {
    setOpenProjects((current) => {
      const next = new Set(current)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  return (
    <aside className="sidebar" aria-label="会话导航">
      <div className="sidebar-brand">
        <div className="brand-lockup"><span className="brand-glyph">S</span><strong>Scry</strong></div>
        <span className="version">0.2.20</span>
      </div>
      <div className="sidebar-primary">
        <button type="button" className="new-session" onClick={onNew}>
          <ScryIcon name="plus"></ScryIcon><span>新建会话</span><kbd>⌘N</kbd>
        </button>
        <label className="session-search">
          <ScryIcon name="search"></ScryIcon>
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索会话或项目" />
          {query && <button type="button" onClick={() => onQuery('')} aria-label="清空搜索">×</button>}
        </label>
      </div>
      <nav className="utility-nav" aria-label="主要视图">
        <button type="button"><ScryIcon name="chart"></ScryIcon><span>分析</span></button>
        <button type="button"><ScryIcon name="info"></ScryIcon><span>诊断</span><i className="nav-attention"></i></button>
        <button type="button"><ScryIcon name="box"></ScryIcon><span>技能</span><em>31</em></button>
        <button type="button"><ScryIcon name="cube"></ScryIcon><span>MCP</span><em className="warn">0/15</em></button>
      </nav>
      <div className="recent-header"><span>最近会话</span><span>{projects.reduce((sum, project) => sum + project.sessions.length, 0)}</span></div>
      <div className="project-list">
        {projects.length === 0 && <div className="sidebar-empty">没有匹配的会话</div>}
        {projects.map((project) => {
          const open = openProjects.has(project.id)
          return (
            <section className="project-group" key={project.id}>
              <button type="button" className="project-heading" onClick={() => toggleProject(project.id)} aria-expanded={open} title={project.path}>
                <ScryIcon name="chevronRight" className={open ? 'open' : ''}></ScryIcon>
                <span><b>{project.name}</b><small>{project.path}</small></span>
                <em>{project.sessions.length}</em>
              </button>
              {open && <div className="session-list">
                {project.sessions.map((session) => (
                  <button type="button" className={`session-row ${session.id === selectedSession ? 'active' : ''}`} onClick={() => onSelect(session.id)} key={session.id}>
                    <span className={`provider-mark ${session.tone}`}>{session.provider.slice(0, 1).toUpperCase()}</span>
                    <span className="session-copy"><b>{session.title}</b><small>{session.provider}</small></span>
                    <time>{session.age}</time>
                  </button>
                ))}
              </div>}
            </section>
          )
        })}
      </div>
      <div className="sidebar-footer">
        <button type="button" onClick={onTheme}><ScryIcon name={theme === 'dark' ? 'moon' : 'sun'}></ScryIcon><span>外观</span><em>{theme === 'dark' ? '深色' : '浅色'}</em></button>
      </div>
    </aside>
  )
}

function SessionTopbar({ view, panelOpen, variant, onView, onPanel }) {
  return (
    <header className="session-topbar">
      <nav className="view-tabs" aria-label="会话视图">
        <button type="button" className={view === 'chat' ? 'active' : ''} onClick={() => onView('chat')}><ScryIcon name="message"></ScryIcon>对话</button>
        <button type="button" className={view === 'graph' ? 'active' : ''} onClick={() => onView('graph')}><ScryIcon name="graph"></ScryIcon>拓扑</button>
        <button type="button" className={view === 'segments' ? 'active' : ''} onClick={() => onView('segments')}><ScryIcon name="chart"></ScryIcon>分段</button>
      </nav>
      <div className="session-context" title="当前工作目录">
        <ScryIcon name="folder"></ScryIcon><span>rate-native</span><small>treehouse</small>
      </div>
      <div className="session-actions">
        <span className="agent-chip"><span className="status-dot ok"></span>Claude Code <b>2.1.216</b></span>
        <button type="button" className={`topbar-button ${panelOpen ? 'active' : ''}`} onClick={onPanel} aria-pressed={panelOpen} title={variant === 'focus' ? '打开纵览抽屉' : '显示纵览面板'}>
          <ScryIcon name="panel"></ScryIcon><span>纵览</span>
        </button>
      </div>
    </header>
  )
}

function TraceStrip() {
  return (
    <div className="trace-strip" aria-label="当前轮次轨迹">
      <span className="turn-number">T01</span>
      <span className="trace-node done"><i></i>SessionStart</span>
      <span className="trace-line"></span>
      <span className="trace-node done"><i></i>Model</span>
      <span className="trace-line"></span>
      <span className="trace-node done"><i></i>Stop</span>
      <button type="button">Hooks 7 <ScryIcon name="chevronRight" size={13}></ScryIcon></button>
    </div>
  )
}

function TurnFooter({ metrics }) {
  return (
    <div className="turn-footer" aria-label="本轮指标">
      <span><small>IN</small><b>{metrics.input}</b></span>
      <span><small>OUT</small><b>{metrics.output}</b></span>
      <span><small>CACHE·W</small><b>{metrics.cacheWrite}</b></span>
      <span><small>DUR</small><b>{metrics.duration}</b></span>
      <span><small>API</small><b>{metrics.api}</b></span>
      <span><small>TOOLS</small><b>{metrics.calls}</b></span>
    </div>
  )
}

function AssistantMessage({ data, metrics }) {
  return (
    <article className="assistant-message">
      <div className="message-author"><span className="assistant-avatar">C</span><div><b>Claude Code</b><small>claude-opus-4-8[1m] · 完成</small></div></div>
      <div className="assistant-copy">
        <p>{data.intro}</p>
        <p>{data.lead}</p>
        <ul>
          {data.bullets.map(([label, text, command]) => <li key={label}><strong>{label}</strong><span>：{text}</span>{command && <code>{command}</code>}</li>)}
        </ul>
        <p>{data.outro}</p>
      </div>
      <details className="evidence-disclosure">
        <summary><ScryIcon name="tool"></ScryIcon><span>执行证据</span><b>3 个 Hook 周期</b><ScryIcon name="chevronRight"></ScryIcon></summary>
        <div className="evidence-body"><span>SessionStart · 1</span><span>UserPromptSubmit · 2</span><span>Stop · 4</span></div>
      </details>
      <TurnFooter metrics={metrics}></TurnFooter>
    </article>
  )
}

function EmptyView({ view }) {
  const graph = view === 'graph'
  return (
    <div className="empty-view">
      <div className="empty-view-icon"><ScryIcon name={graph ? 'graph' : 'chart'} size={24}></ScryIcon></div>
      <strong>{graph ? '本轮没有工具调用' : '本轮没有可切分的 Skill 段落'}</strong>
      <span>{graph ? '模型直接返回结果，因此没有生成调用拓扑。' : '出现 Skill、工具或子 Agent 后，这里会按实际执行顺序分段。'}</span>
    </div>
  )
}

function Composer({ value, onChange, onSend }) {
  const send = () => value.trim() && onSend()
  return (
    <div className="composer-wrap">
      <div className="composer">
        <div className="composer-context"><ScryIcon name="folder"></ScryIcon><b>rate-native</b><span>·</span><span>默认审批</span></div>
        <textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        }} placeholder="给 Claude Code 一个任务…  / 唤起命令，Enter 发送"></textarea>
        <div className="composer-footer">
          <div className="run-controls"><button type="button"><span className="provider-mark claude">C</span>Claude Code<ScryIcon name="chevronDown" size={13}></ScryIcon></button><button type="button">自动模型<ScryIcon name="chevronDown" size={13}></ScryIcon></button></div>
          <button type="button" className="send-button" disabled={!value.trim()} onClick={send} aria-label="发送任务"><ScryIcon name="send"></ScryIcon></button>
        </div>
      </div>
    </div>
  )
}

function ChatPane({ view, variant, metrics, messages, composerValue, onComposer, onSend }) {
  if (view !== 'chat') return <main className="chat-pane"><EmptyView view={view}></EmptyView></main>
  return (
    <main className="chat-pane" data-screen-label="Scry Chat">
      {variant === 'focus' && <div className="focus-summary"><span className="status-dot ok"></span><b>本会话完成</b><span>1 轮</span><span>{metrics.totalTokens} tok</span><span>{metrics.duration}</span></div>}
      <div className="chat-scroll">
        <div className="conversation-column">
          <TraceStrip></TraceStrip>
          <AssistantMessage data={scryPrototypeData.assistant} metrics={metrics}></AssistantMessage>
          {messages.map((message, index) => <article className="draft-user-message" key={`${message}-${index}`}><span>你</span><p>{message}</p></article>)}
        </div>
      </div>
      <Composer value={composerValue} onChange={onComposer} onSend={onSend}></Composer>
    </main>
  )
}

function ContextRing({ percent }) {
  return <div className="context-ring" style={{ '--percent': `${percent * 3.6}deg` }}><span>{percent}%</span></div>
}

function OverviewContent({ dataTab, metrics, onDataTab }) {
  return (
    <>
      <section className="context-card">
        <ContextRing percent={metrics.contextPercent}></ContextRing>
        <div><small>上下文 · claude-opus-4-8[1m]</small><strong>{metrics.contextUsed} <span>/ {metrics.contextWindow}</span></strong><p>已占 {metrics.contextPercent}% · 剩余 959.4k · 最近一轮完整</p></div>
      </section>
      <section className="session-verdict">
        <div><small>本会话 · 1 轮</small><strong><span className="status-dot ok"></span>完成</strong><p>1 轮完成 · 0 次调用</p></div>
        <button type="button" title="跳到本轮">T01 <ScryIcon name="chevronRight" size={13}></ScryIcon></button>
      </section>
      <section className="metric-grid">
        <div><small>总 Token</small><strong className="accent">{metrics.totalTokens}</strong><p>1/1 轮已捕获</p></div>
        <div><small>输入 / 输出</small><strong>{metrics.input} <span>/ {metrics.output}</span></strong><p>Provider 上报</p></div>
        <div><small>调用</small><strong>{metrics.calls}</strong><p>工具 0 · MCP 0 · Skill 0</p></div>
        <div><small>危险</small><strong>{metrics.danger}</strong><p>无观测标记</p></div>
      </section>
      <div className="cache-strip"><span>CACHE·R <b>0</b></span><span>CACHE·W <b>{metrics.cacheWrite}</b></span><span>API <b>{metrics.api}</b></span></div>
      <section className="session-identity"><span>会话</span><code>9b1c07fc-33ef-4b17-ba1e-8a02ce36d94a</code></section>
      <div className="data-tabs" role="tablist" aria-label="纵览数据维度">
        <button type="button" role="tab" aria-selected={dataTab === 'turn'} className={dataTab === 'turn' ? 'active' : ''} onClick={() => onDataTab('turn')}>轮次数据</button>
        <button type="button" role="tab" aria-selected={dataTab === 'session'} className={dataTab === 'session' ? 'active' : ''} onClick={() => onDataTab('session')}>会话数据</button>
      </div>
      {dataTab === 'turn' ? <section className="turn-summary">
        <header><span>每轮调用</span><b>1 turn</b></header>
        <div className="turn-row"><button type="button">T01</button><span><b>hello</b><small>完成 · {metrics.duration}</small></span><em>Hooks {metrics.hooks}</em><ScryIcon name="chevronRight" size={13}></ScryIcon></div>
        <p>数量只来自本轮已上报证据；未知值不按 0 补齐。</p>
      </section> : <section className="session-details">
        <details open><summary>调用明细 <span>0</span><ScryIcon name="chevronRight" size={13}></ScryIcon></summary><p>本会话没有工具、MCP、Skill 或子 Agent 调用。</p></details>
        <details><summary>Hook 生命周期 <span>7</span><ScryIcon name="chevronRight" size={13}></ScryIcon></summary><p>3 个周期 · 7 个处理器实例。</p></details>
        <details><summary>文件证据 <span>未知</span><ScryIcon name="chevronRight" size={13}></ScryIcon></summary><p>Git 差异采集超时；不把缺失证据显示为 0。</p></details>
      </section>}
    </>
  )
}

function Inspector({ activeTab, dataTab, metrics, variant, onTab, onDataTab, onClose }) {
  return (
    <aside className={`inspector inspector-${variant}`} aria-label="会话纵览">
      <header className="inspector-tabs" role="tablist" aria-label="面板视图">
        <button type="button" role="tab" aria-selected={activeTab === 'overview'} className={activeTab === 'overview' ? 'active' : ''} onClick={() => onTab('overview')}><ScryIcon name="grid"></ScryIcon>纵览</button>
        <button type="button" role="tab" aria-selected={activeTab === 'billing'} className={activeTab === 'billing' ? 'active' : ''} onClick={() => onTab('billing')}><ScryIcon name="info"></ScryIcon>账单</button>
        <button type="button" role="tab" aria-selected={activeTab === 'mcp'} className={activeTab === 'mcp' ? 'active' : ''} onClick={() => onTab('mcp')}><ScryIcon name="lock"></ScryIcon>MCP</button>
        <button type="button" className="inspector-close" onClick={onClose} aria-label="关闭纵览">×</button>
      </header>
      <div className="inspector-scroll">
        {activeTab === 'overview' && <OverviewContent dataTab={dataTab} metrics={metrics} onDataTab={onDataTab}></OverviewContent>}
        {activeTab === 'billing' && <div className="honest-state"><ScryIcon name="info" size={22}></ScryIcon><strong>账单状态尚未载入</strong><p>原型不补 `$0` 或空审计结果。真实状态由 Billing Guardian IPC 返回后再展示。</p><button type="button">查看数据语义</button></div>}
        {activeTab === 'mcp' && <div className="honest-state"><ScryIcon name="lock" size={22}></ScryIcon><strong>MCP · 0/15 已连接</strong><p>配置已发现，但当前截图中的真实连接状态仍需探测；“未探测”不等于“断开”。</p><button type="button">重新探测</button></div>}
      </div>
    </aside>
  )
}

Object.assign(window, {
  PrototypeControls,
  TweaksPanel,
  ScryTitlebar,
  Sidebar,
  SessionTopbar,
  ChatPane,
  Inspector
})
