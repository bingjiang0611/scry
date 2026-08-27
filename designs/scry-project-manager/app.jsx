const { Icon } = window
const { useEffect, useMemo, useRef, useState } = React

const initialProjects = [
  {
    id: 'vibecoding',
    name: 'vibecoding',
    path: '/Users/baobingjiang/IdeaProjects/vibecoding',
    pinned: true,
    sessions: [
      { id: 'scry-timeout', provider: 'codex', title: '优化 Pi 版本探测超时', time: '现在' },
      { id: 'sidebar-undo', provider: 'codex', title: '固定侧栏撤销提示', time: '6m' }
    ]
  },
  {
    id: 'rate-native',
    name: 'rate-native',
    path: '/Users/baobingjiang/IdeaProjects/rate-native',
    pinned: false,
    sessions: []
  },
  {
    id: 'dev-agent',
    name: 'dev-agent',
    path: '/Users/baobingjiang/IdeaProjects/vibecoding/dev-agent',
    pinned: false,
    sessions: []
  },
  {
    id: 'nib',
    name: 'Nib',
    path: '/Users/baobingjiang/IdeaProjects/vibecoding/Nib',
    pinned: false,
    sessions: [
      { id: 'editor-polish', provider: 'claude', title: '优化编辑器命令面板', time: '2d' }
    ]
  }
]

function ProjectBlock({ project, active, menuProjectId, onSelect, onNewChat, onMenu, onPickSession }) {
  return (
    <section className="project-block">
      <div className={['project-row', active && 'active', menuProjectId === project.id && 'menu-open'].filter(Boolean).join(' ')}>
        <button
          className="project-select"
          type="button"
          aria-current={active ? 'true' : undefined}
          onClick={() => onSelect(project.id)}
        >
          <Icon name="folder" />
          <span className="project-name">{project.name}</span>
          <span className="project-meta">{project.sessions.length || ''}</span>
        </button>
        <span className="project-actions">
          <button
            className="project-action"
            type="button"
            title={`在 ${project.name} 新建会话`}
            aria-label={`在 ${project.name} 新建会话`}
            onClick={() => onNewChat(project.id)}
          >
            <Icon name="plus" />
          </button>
          <button
            className="project-action"
            type="button"
            title={`管理 ${project.name}`}
            aria-label={`管理 ${project.name}`}
            onClick={(event) => onMenu(event, project.id)}
          >
            <Icon name="more" />
          </button>
        </span>
      </div>
      <div className="session-list">
        {project.sessions.length === 0 ? (
          <div className="empty-session">
            <span>暂无会话</span>
            <button className="empty-new" type="button" onClick={() => onNewChat(project.id)}>新建</button>
          </div>
        ) : project.sessions.map((session) => (
          <button className="session-row" type="button" key={session.id} onClick={() => onPickSession(project.id, session.id)}>
            <span className="provider">{session.provider}</span>
            <span className="session-title">{session.title}</span>
            <span className="session-time">{session.time}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function ProjectMenu({ project, position, onClose, onNewChat, onTogglePin, onEdit, onRemove }) {
  return (
    <>
      <div className="menu-dismiss" onClick={onClose}></div>
      <div className="popover" role="menu" style={{ left: position.left, top: position.top }}>
        <div className="popover-title"><Icon name="folder" /> {project.name}</div>
        <div className="popover-path">{project.path}</div>
        <button className="menu-item primary" type="button" onClick={onNewChat}>
          <Icon name="plus" /> 在此项目新建会话 <span className="shortcut">⌘N</span>
        </button>
        <div className="menu-divider"></div>
        <button className="menu-item" type="button" onClick={onTogglePin}>
          <Icon name="pin" /> {project.pinned ? '取消置顶项目' : '置顶项目'}
        </button>
        <button className="menu-item" type="button" onClick={() => {}}>
          <Icon name="external" /> 在 Finder 中显示
        </button>
        <button className="menu-item" type="button" onClick={onEdit}>
          <Icon name="edit" /> 编辑项目
        </button>
        <div className="menu-divider"></div>
        <button className="menu-item danger" type="button" onClick={onRemove}>
          <Icon name="x" /> 从 Scry 移除项目
        </button>
      </div>
    </>
  )
}

function EditProjectDialog({ project, onCancel, onSave }) {
  const [name, setName] = useState(project.name)
  const [path, setPath] = useState(project.path)
  return (
    <div className="scrim" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-label="编辑项目">
        <div className="dialog-head">
          <b>编辑项目</b>
          <span>自定义显示名称；目录路径用于确定新会话的工作区。</span>
        </div>
        <div className="dialog-body">
          <label className="field">
            <span>项目名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>目录路径</span>
            <input value={path} onChange={(event) => setPath(event.target.value)} />
          </label>
        </div>
        <div className="dialog-actions">
          <button className="secondary-action" type="button" onClick={onCancel}>取消</button>
          <button className="primary-action" type="button" disabled={!name.trim() || !path.trim()} onClick={() => onSave(name.trim(), path.trim())}>保存</button>
        </div>
      </section>
    </div>
  )
}

function RemoveProjectDialog({ project, onCancel, onConfirm }) {
  return (
    <div className="scrim" role="presentation">
      <section className="dialog" role="alertdialog" aria-modal="true" aria-label="移除项目">
        <div className="dialog-head">
          <b>从 Scry 移除“{project.name}”？</b>
          <span>只会移除项目入口，不会删除目录、Git 仓库或 Provider 原生会话。以后重新打开该目录即可恢复。</span>
        </div>
        <div className="dialog-actions">
          <button className="secondary-action" type="button" onClick={onCancel}>取消</button>
          <button className="secondary-action danger-action" type="button" onClick={onConfirm}>移除项目</button>
        </div>
      </section>
    </div>
  )
}

function AddProjectDialog({ onCancel, onAdd }) {
  const [path, setPath] = useState('/Users/baobingjiang/IdeaProjects/')
  const name = path.split('/').filter(Boolean).at(-1) || ''
  return (
    <div className="scrim" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-label="添加项目">
        <div className="dialog-head">
          <b>添加项目</b>
          <span>项目添加后会一直保留，即使还没有创建任何会话。</span>
        </div>
        <div className="dialog-body">
          <label className="field">
            <span>目录路径</span>
            <input value={path} onChange={(event) => setPath(event.target.value)} autoFocus />
          </label>
        </div>
        <div className="dialog-actions">
          <button className="secondary-action" type="button" onClick={onCancel}>取消</button>
          <button className="primary-action" type="button" disabled={!name} onClick={() => onAdd(name, path)}>添加项目</button>
        </div>
      </section>
    </div>
  )
}

function App() {
  const [theme, setTheme] = useState('light')
  const [projects, setProjects] = useState(initialProjects)
  const [selectedProjectId, setSelectedProjectId] = useState('rate-native')
  const [menu, setMenu] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [draftProjectId, setDraftProjectId] = useState(null)
  const [text, setText] = useState('')
  const [toast, setToast] = useState(null)
  const composerRef = useRef(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => Number(b.pinned) - Number(a.pinned)),
    [projects]
  )
  const selectedProject = projects.find((project) => project.id === selectedProjectId) || projects[0]
  const menuProject = menu ? projects.find((project) => project.id === menu.projectId) : null

  const flash = (message) => {
    setToast(message)
    window.clearTimeout(window.__scryProjectToast)
    window.__scryProjectToast = window.setTimeout(() => setToast(null), 2400)
  }

  const startChat = (projectId) => {
    setSelectedProjectId(projectId)
    setDraftProjectId(projectId)
    setMenu(null)
    setDialog(null)
    window.setTimeout(() => composerRef.current?.focus(), 0)
    const project = projects.find((item) => item.id === projectId)
    flash(`新会话已绑定到 ${project?.name || '该项目'}`)
  }

  const send = () => {
    if (!text.trim() || !selectedProject) return
    const title = text.trim().slice(0, 28)
    setProjects((current) => current.map((project) => project.id === selectedProject.id
      ? { ...project, sessions: [{ id: `draft-${Date.now()}`, provider: 'pi', title, time: '现在' }, ...project.sessions] }
      : project))
    setDraftProjectId(null)
    setText('')
    flash(`已在 ${selectedProject.name} 创建会话`)
  }

  const openMenu = (event, projectId) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const width = 252
    const left = Math.min(rect.right + 7, window.innerWidth - width - 12)
    const top = Math.min(rect.top - 8, window.innerHeight - 330)
    setSelectedProjectId(projectId)
    setMenu({ projectId, left, top: Math.max(12, top) })
  }

  const saveProject = (name, path) => {
    const id = dialog.projectId
    setProjects((current) => current.map((project) => project.id === id ? { ...project, name, path } : project))
    setDialog(null)
    flash('项目设置已保存')
  }

  const removeProject = () => {
    const id = dialog.projectId
    const removed = projects.find((project) => project.id === id)
    const next = projects.filter((project) => project.id !== id)
    setProjects(next)
    if (selectedProjectId === id) setSelectedProjectId(next[0]?.id || '')
    setDialog(null)
    flash(`已从 Scry 移除 ${removed?.name || '项目'}`)
  }

  const addProject = (name, path) => {
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`
    setProjects((current) => [...current, { id, name, path, pinned: false, sessions: [] }])
    setSelectedProjectId(id)
    setDialog(null)
    flash(`${name} 已加入项目列表`)
  }

  if (!selectedProject) return null

  return (
    <div className="app-stage" data-theme={theme} data-screen-label="Scry 项目管理">
      <div className="app-window">
        <aside className="sidebar" aria-label="会话导航">
          <div className="brand">
            <span className="brand-mark">S</span>
            <b>Scry</b>
            <span className="version">0.2.102</span>
          </div>
          <button className="new-chat" type="button" onClick={() => startChat(selectedProject.id)}>
            <Icon name="plus" /> 新建会话 <span className="kbd">⌘N</span>
          </button>
          <label className="search">
            <Icon name="search" />
            <input placeholder="搜索会话 / 项目…" />
          </label>
          <nav className="primary-nav" aria-label="主要视图">
            <button className="nav-button" type="button"><Icon name="chart" /> 分析</button>
            <button className="nav-button" type="button"><Icon name="info" /> 诊断</button>
          </nav>

          <div className="project-scroll">
            <div className="section-label">
              项目 <span className="section-count">{projects.length}</span>
              <button className="add-project" type="button" title="添加项目" aria-label="添加项目" onClick={() => setDialog({ type: 'add' })}>
                <Icon name="plus" />
              </button>
            </div>
            {sortedProjects.map((project) => (
              <ProjectBlock
                key={project.id}
                project={project}
                active={project.id === selectedProject.id}
                menuProjectId={menu?.projectId}
                onSelect={(id) => { setSelectedProjectId(id); setDraftProjectId(null) }}
                onNewChat={startChat}
                onMenu={openMenu}
                onPickSession={(projectId) => { setSelectedProjectId(projectId); setDraftProjectId(null) }}
              />
            ))}
          </div>

          <div className="sidebar-footer">
            <button className="footer-button" type="button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
              <Icon name="settings" /> 设置 <span className="theme-label">{theme === 'light' ? '浅色' : '深色'}</span>
            </button>
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div className="topbar-project">
              <Icon name="folder" />
              <b>{selectedProject.name}</b>
              <span className="topbar-path">{selectedProject.path}</span>
            </div>
            <span className="context-badge"><Icon name="terminal" /> Local</span>
          </header>

          <section className="workspace">
            <div className="empty-workspace">
              <span className="workspace-icon"><Icon name={draftProjectId === selectedProject.id ? 'edit' : 'folder'} /></span>
              <h1>{draftProjectId === selectedProject.id ? `新会话 · ${selectedProject.name}` : `在 ${selectedProject.name} 开始工作`}</h1>
              <p>
                {selectedProject.sessions.length === 0
                  ? '项目会一直保留在侧栏。新会话会以该目录作为工作区，未发送首条消息前不会写入会话历史。'
                  : `已有 ${selectedProject.sessions.length} 个会话；可以继续历史记录，或在同一项目上下文中新建会话。`}
              </p>
              <button className="primary-action" type="button" onClick={() => startChat(selectedProject.id)}>
                <Icon name="plus" /> 在此项目新建会话
              </button>
            </div>
          </section>

          <div className="composer-shell">
            <div className="composer">
              <textarea
                ref={composerRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    send()
                  }
                }}
                placeholder={`给 ${selectedProject.name} 中的 Agent 发消息…`}
              ></textarea>
              <div className="composer-tools">
                <button className="tool-button" type="button" aria-label="添加附件"><Icon name="plus" /></button>
                <span className="composer-context"><Icon name="folder" /> {selectedProject.name}</span>
                <button className="send-button" type="button" aria-label="发送" disabled={!text.trim()} onClick={send}><Icon name="arrowUp" /></button>
              </div>
            </div>
          </div>
        </main>

        <aside className="inspector" aria-label="项目详情">
          <div className="inspector-head"><Icon name="folder" /><b>项目详情</b></div>
          <div className="inspector-body">
            <div className="detail-group">
              <span className="detail-label">项目</span>
              <span className="detail-value">{selectedProject.name}</span>
              <span className="detail-path">{selectedProject.path}</span>
            </div>
            <div className="detail-group">
              <span className="detail-label">会话</span>
              <span className="detail-value">{selectedProject.sessions.length === 0 ? '还没有会话' : `${selectedProject.sessions.length} 个本地会话`}</span>
            </div>
            <div className="detail-group">
              <span className="detail-label">行为</span>
              <span className="detail-value">项目入口独立于会话保留；移除项目不会删除目录和 Provider 历史。</span>
            </div>
            <div className="inspector-actions">
              <button type="button" onClick={() => startChat(selectedProject.id)}><Icon name="plus" /> 在此项目新建会话</button>
              <button type="button" onClick={() => setDialog({ type: 'edit', projectId: selectedProject.id })}><Icon name="edit" /> 编辑项目</button>
              <button type="button"><Icon name="external" /> 在 Finder 中显示</button>
            </div>
          </div>
        </aside>
      </div>

      {menu && menuProject && (
        <ProjectMenu
          project={menuProject}
          position={menu}
          onClose={() => setMenu(null)}
          onNewChat={() => startChat(menuProject.id)}
          onTogglePin={() => {
            setProjects((current) => current.map((project) => project.id === menuProject.id ? { ...project, pinned: !project.pinned } : project))
            setMenu(null)
            flash(menuProject.pinned ? '已取消置顶项目' : '项目已置顶')
          }}
          onEdit={() => { setDialog({ type: 'edit', projectId: menuProject.id }); setMenu(null) }}
          onRemove={() => { setDialog({ type: 'remove', projectId: menuProject.id }); setMenu(null) }}
        />
      )}

      {dialog?.type === 'edit' && (
        <EditProjectDialog project={projects.find((project) => project.id === dialog.projectId)} onCancel={() => setDialog(null)} onSave={saveProject} />
      )}
      {dialog?.type === 'remove' && (
        <RemoveProjectDialog project={projects.find((project) => project.id === dialog.projectId)} onCancel={() => setDialog(null)} onConfirm={removeProject} />
      )}
      {dialog?.type === 'add' && <AddProjectDialog onCancel={() => setDialog(null)} onAdd={addProject} />}
      {toast && <div className="toast" role="status"><Icon name="check" /> {toast}</div>}
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
