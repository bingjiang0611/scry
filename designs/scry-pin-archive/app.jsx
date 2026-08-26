// 编排层：状态全部在 App，置顶 / 存档 / 取消存档 / 删除都是真实状态变更。
const { INITIAL_SESSIONS, groupByProject, Icon, SessionRow, ArchivedChats } = window
const { useMemo, useState } = React

function App() {
  const [theme, setTheme] = useState('dark')
  const [sessions, setSessions] = useState(INITIAL_SESSIONS)
  const [activeId, setActiveId] = useState('sc-02')
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState(new Set())
  const [settings, setSettings] = useState(null) // null | 'appearance' | 'archived'
  const [undo, setUndo] = useState(null)
  const [archQ, setArchQ] = useState('')
  const [archProvider, setArchProvider] = useState('all')
  const [archProject, setArchProject] = useState('all')
  const [confirming, setConfirming] = useState(false)

  document.documentElement.dataset.theme = theme

  const ql = q.trim().toLowerCase()
  const match = (s) => !ql || s.preview.toLowerCase().includes(ql)

  const live = sessions.filter((s) => !s.archivedAt)
  const pinned = live
    .filter((s) => s.pinnedAt && match(s))
    .sort((a, b) => b.pinnedAt - a.pinnedAt)
  const recentGroups = groupByProject(live.filter((s) => !s.pinnedAt && match(s)))
  const archived = sessions.filter((s) => s.archivedAt)

  const archProjects = useMemo(() => {
    const seen = new Map()
    for (const s of archived) if (!seen.has(s.cwd)) seen.set(s.cwd, { cwd: s.cwd, name: s.name })
    return [...seen.values()]
  }, [archived])

  const archFiltered = archived.filter((s) => {
    const aq = archQ.trim().toLowerCase()
    if (aq && !s.preview.toLowerCase().includes(aq)) return false
    if (archProvider !== 'all' && s.providerId !== archProvider) return false
    if (archProject !== 'all' && (s.cwd || 'none') !== archProject) return false
    return true
  })
  const archGroups = groupByProject(archFiltered).map((g) => ({
    ...g,
    sessions: [...g.sessions].sort((a, b) => b.archivedAt - a.archivedAt)
  }))

  const patch = (id, fields) =>
    setSessions((prev) => prev.map((s) => (s.sessionId === id ? { ...s, ...fields } : s)))

  const togglePin = (s) => patch(s.sessionId, { pinnedAt: s.pinnedAt ? null : Date.now() })

  const archive = (s) => {
    patch(s.sessionId, { archivedAt: Date.now(), pinnedAt: null })
    setUndo({ sessionId: s.sessionId, preview: s.preview, pinnedAt: s.pinnedAt })
  }

  const unarchive = (s) => patch(s.sessionId, { archivedAt: null })

  const undoArchive = () => {
    if (!undo) return
    patch(undo.sessionId, { archivedAt: null, pinnedAt: undo.pinnedAt })
    setUndo(null)
  }

  const removeOne = (s) => setSessions((prev) => prev.filter((x) => x.sessionId !== s.sessionId))

  const deleteAll = () => {
    setSessions((prev) => prev.filter((s) => !s.archivedAt))
    setConfirming(false)
  }

  const toggleProject = (cwd) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(cwd) ? next.delete(cwd) : next.add(cwd)
      return next
    })

  const rowProps = {
    onPick: (s) => setActiveId(s.sessionId),
    onTogglePin: togglePin,
    onArchive: archive
  }

  return (
    <div className="page">
      <header className="page__bar">
        <div className="page__id">
          <strong>Scry · 置顶与存档</strong>
          <span>Sidebar pin / archive + 设置 › 已存档会话</span>
        </div>
        <div className="knobs" style={{ padding: 0, border: 0, background: 'transparent' }}>
          <div className="knob">
            <span>主题</span>
            <div className="knob__seg">
              {['dark', 'light'].map((t) => (
                <button key={t} type="button" className={theme === t ? 'active' : ''} onClick={() => setTheme(t)}>
                  {t === 'dark' ? '深色' : '浅色'}
                </button>
              ))}
            </div>
          </div>
          <div className="knob">
            <span>场景</span>
            <div className="knob__seg">
              <button type="button" className={settings === null ? 'active' : ''} onClick={() => setSettings(null)}>
                侧边栏
              </button>
              <button type="button" className={settings === 'appearance' ? 'active' : ''} onClick={() => setSettings('appearance')}>
                设置 · 外观
              </button>
              <button type="button" className={settings === 'archived' ? 'active' : ''} onClick={() => setSettings('archived')}>
                设置 · 已存档
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="stage">
        <div className="mock-app" data-screen-label="Scry 主界面">
          <aside className="sidebar" aria-label="会话导航">
            <div className="sb-brand">
              <span className="name">Scry</span>
              <span className="ver">0.4.1</span>
            </div>
            <button className="sb-new" type="button">
              <Icon name="plus" /> 新建会话
              <span className="kbd">⌘N</span>
            </button>
            <label className="sb-search">
              <Icon name="search" />
              <input placeholder="搜索会话 / 项目…" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>

            <nav className="sb-nav" aria-label="主要视图">
              <button type="button" className="sb-navitem"><Icon name="chart" /> 分析</button>
              <button type="button" className="sb-navitem"><Icon name="info" /> 诊断</button>
              <button type="button" className="sb-navitem">
                <Icon name="box" /> 技能
                <span className="sb-navmeta">12</span>
              </button>
              <button type="button" className="sb-navitem">
                <Icon name="cube" /> MCP
                <span className="sb-navmeta"><span className="sb-navdot online" />3/3</span>
              </button>
            </nav>

            <div className="sb-list">
              {pinned.length > 0 && (
                <>
                  <div className="sb-section">
                    置顶 <span className="cnt">{pinned.length}</span>
                  </div>
                  <div className="sb-pinned">
                    {pinned.map((s) => (
                      <SessionRow
                        key={s.sessionId}
                        session={s}
                        active={s.sessionId === activeId}
                        showProject
                        {...rowProps}
                      />
                    ))}
                  </div>
                  <div className="sb-divider" />
                </>
              )}

              <div className="sb-section">
                最近 <span className="cnt">{recentGroups.length}</span>
              </div>
              {recentGroups.length === 0 && <div className="sb-empty">无历史会话</div>}
              {recentGroups.map((p) => {
                const open = !collapsed.has(p.cwd)
                return (
                  <div className={`sb-proj ${open ? 'open' : ''}`} key={p.cwd || 'none'}>
                    <button
                      type="button"
                      className="sb-proj-head"
                      aria-expanded={open}
                      onClick={() => toggleProject(p.cwd)}
                    >
                      <Icon name="chevronRight" className="chev" />
                      <span className="pname">{p.name}</span>
                      <span className="pcnt">{p.sessions.length}</span>
                    </button>
                    {open && (
                      <div className="sb-sess-list">
                        {p.sessions.map((s) => (
                          <SessionRow
                            key={s.sessionId}
                            session={s}
                            active={s.sessionId === activeId}
                            {...rowProps}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {undo && (
                <div className="sb-undo" role="status">
                  <span>已存档「{undo.preview}」</span>
                  <button type="button" onClick={undoArchive}>
                    <Icon name="undo" /> 撤销
                  </button>
                </div>
              )}
            </div>

            <div className="sb-footer">
              <button type="button" className="sb-navitem sb-settings" onClick={() => setSettings('appearance')}>
                <Icon name="settings" /> 设置
                <span className="sb-navmeta">{theme === 'dark' ? '深色' : '浅色'}</span>
              </button>
            </div>
          </aside>

          <main className="mock-main">
            <div className="mock-topbar">当前会话 · 侧边栏置顶与存档方案</div>
            <div className="mock-hint">
              <b>这块是会话主区，本次设计不动。</b>
              <span>
                侧边栏交互：鼠标移到任意会话行，右侧浮出 <code>置顶</code> 与 <code>存档</code> 两个图标按钮；
                原来的右键「删除会话」菜单整体去掉，删除只在设置 › 已存档会话里发生。
              </span>
            </div>
          </main>

          {settings && (
            <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setSettings(null) }}>
              <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
                <div className="modal-head">
                  <b>设置</b>
                  <button className="modal-x" aria-label="关闭设置" onClick={() => setSettings(null)}>
                    <Icon name="x" />
                  </button>
                </div>
                <div className="settings-shell">
                  <nav className="settings-rail" aria-label="设置分区">
                    <button
                      type="button"
                      className={`settings-tab ${settings === 'appearance' ? 'active' : ''}`}
                      onClick={() => setSettings('appearance')}
                    >
                      <Icon name="settings" /> 外观
                    </button>
                    <button
                      type="button"
                      className={`settings-tab ${settings === 'archived' ? 'active' : ''}`}
                      onClick={() => setSettings('archived')}
                    >
                      <Icon name="archive" /> 已存档会话
                      <span className="cnt">{archived.length}</span>
                    </button>
                  </nav>
                  <div className="settings-pane">
                    {settings === 'appearance' ? (
                      <div className="settings-body">
                        <div className="settings-copy">
                          <b>外观</b>
                          <span>选择 Scry 的全局界面主题。</span>
                        </div>
                        <div className="theme-options" role="radiogroup" aria-label="界面主题">
                          {[
                            { id: 'dark', title: '深色', hint: '低光环境' },
                            { id: 'light', title: '浅色', hint: '明亮环境' }
                          ].map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              className={`theme-option ${theme === opt.id ? 'active' : ''}`}
                              role="radio"
                              aria-checked={theme === opt.id}
                              onClick={() => setTheme(opt.id)}
                            >
                              <span className={`theme-preview ${opt.id}`} aria-hidden="true">
                                <span />
                                <i />
                              </span>
                              <span className="theme-option-copy">
                                <b>{opt.title}</b>
                                <small>{opt.hint}</small>
                              </span>
                              <span className="theme-check" aria-hidden="true"><Icon name="check" /></span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <ArchivedChats
                        groups={archGroups}
                        total={archived.length}
                        matched={archFiltered.length}
                        query={archQ}
                        provider={archProvider}
                        project={archProject}
                        projects={archProjects}
                        confirming={confirming}
                        onQuery={setArchQ}
                        onProvider={setArchProvider}
                        onProject={setArchProject}
                        onUnarchive={unarchive}
                        onDelete={removeOne}
                        onAskDeleteAll={() => setConfirming(true)}
                        onCancelDeleteAll={() => setConfirming(false)}
                        onDeleteAll={deleteAll}
                      />
                    )}
                  </div>
                </div>
                <div className="modal-foot dim">
                  {settings === 'appearance'
                    ? '选择会保存在此设备，并立即应用到全部视图。'
                    : '取消存档会把会话放回原项目分组；删除会同时移除会话记录、用量与 trace，不可恢复。'}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
