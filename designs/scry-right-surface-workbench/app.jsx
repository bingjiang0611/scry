const { useEffect, useMemo, useRef, useState } = React;

function Sidebar({ theme, onTheme }) {
  const [query, setQuery] = useState("");
  const [openProjects, setOpenProjects] = useState(new Set(["scry"]));
  const toggleProject = (name) => setOpenProjects((current) => {
    const next = new Set(current);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });
  return <aside className="left-sidebar" aria-label="会话导航">
    <div className="brand"><span className="brand-mark">S</span><strong>Scry</strong><small>0.2.32</small></div>
    <div className="sidebar-actions">
      <button className="new-session"><Icon name="plus" size={14}/><span>新建会话</span><span>⌘N</span></button>
      <label className="search"><Icon name="search" size={13}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索会话或项目" /></label>
    </div>
    <nav className="primary-nav" aria-label="主要视图">
      <button className="nav-item"><Icon name="chart" size={14}/>分析</button>
      <button className="nav-item"><Icon name="info" size={14}/>诊断<span className="nav-meta">1</span></button>
      <button className="nav-item"><Icon name="box" size={14}/>技能<span className="nav-meta">8</span></button>
      <button className="nav-item"><Icon name="cube" size={14}/>MCP<span className="nav-meta">3/4</span></button>
    </nav>
    <div className="session-scroll">
      <div className="section-label">最近会话<span>5</span></div>
      {projectGroups.map((project) => {
        const open = openProjects.has(project.name);
        return <div key={project.name}>
          <button className={`project-head ${open ? "open" : ""}`} onClick={() => toggleProject(project.name)}>
            <Icon name="chevron" size={11}/><b>{project.name}</b><em>{project.count}</em>
          </button>
          {open && <div className="session-list">
            {project.sessions.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())).map((session) => <button key={session.title} className={`session-row ${session.active ? "active" : ""}`}>
              <span className="session-title">{session.title}</span>
              <span className="session-meta">{session.running && <i className="running-dot"></i>}{session.meta}</span>
            </button>)}
          </div>}
        </div>;
      })}
    </div>
    <div className="sidebar-footer"><button className="theme-button" onClick={onTheme}><Icon name={theme === "dark" ? "moon" : "sun"} size={14}/>外观<span>{theme === "dark" ? "深色" : "浅色"}</span></button></div>
  </aside>;
}

function MainWorkspace({ panelVisible, onShowPanel }) {
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState("");
  const send = () => {
    if (!draft.trim()) return;
    setDraft("");
    setToast("设计原型不会调用 Provider");
    window.setTimeout(() => setToast(""), 1600);
  };
  return <main className="main-workspace" data-screen-label="Scry 对话主工作区">
    <header className="main-topbar">
      <button className="view-tab active"><Icon name="chat" size={14}/>对话</button>
      <button className="view-tab"><Icon name="graph" size={14}/>拓扑</button>
      <button className="view-tab"><Icon name="segments" size={14}/>分段</button>
      <div className="main-tools"><span className="provider-chip"><i></i>Codex</span><span className="provider-chip"><Icon name="folder" size={11}/>scry</span>{!panelVisible && <button className="icon-button" onClick={onShowPanel} title="显示右侧工作区"><Icon name="panel" size={15}/></button>}</div>
    </header>
    <section className="chat-stream">
      <div className="chat-column">
        <div className="chat-context">结构原型 · 示例数据 · 不连接 Provider</div>
        <div className="user-bubble">参考 t3code，把 Scry 的右侧纵览优化为可切换的工作面板。</div>
        <div className="turn-head"><span className="provider-dot"></span><b>Codex run</b><span>当前任务 · 7 calls</span></div>
        <div className="assistant-copy"><p>右栏不再由“纵览 / 文件 / Diff”三套互斥容器分别控制，而是统一成一个 Surface 工作区。</p><ol><li>每个 Surface 保留自己的滚动位置与选择状态。</li><li>顶栏只承担标签、添加、最大化与关闭。</li><li>终端在本稿中是概念能力，生产实现需要新增 PTY 后端。</li></ol></div>
        <div className="evidence-strip"><b>本轮证据</b><span>Read 5</span><span>Git diff 3</span><span>Files 7</span><span>21s</span></div>
      </div>
    </section>
    <div className="composer-zone"><div className="composer"><textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }}} placeholder="给 Codex 一个任务…（原型不会发送）"></textarea><div className="composer-foot"><span>Codex</span><span>·</span><span>只读权限</span><button className="icon-button send" onClick={send} aria-label="发送"><Icon name="send" size={13}/></button></div></div></div>
    {toast && <div role="status" style={{position:"absolute",bottom:148,left:"50%",transform:"translateX(-50%)",padding:"7px 10px",border:"1px solid var(--border)",borderRadius:6,background:"var(--raised)",boxShadow:"0 12px 30px rgba(0,0,0,.3)",fontSize:10,color:"var(--dim)"}}>{toast}</div>}
  </main>;
}

function EmptySurface({ onOpen }) {
  return <div className="empty-surface"><div className="empty-inner">
    <div className="empty-heading"><h2>打开一个 Surface</h2><p>选择要在右侧工作区中显示的内容。</p></div>
    <div className="surface-card-grid">
      {surfaceCatalog.map((surface) => <button key={surface.id} className="surface-card" onClick={() => onOpen(surface.id)}>
        {surface.available === "concept" && <span className="concept-badge">概念能力</span>}
        <span className="card-icon"><Icon name={surface.icon} size={20}/></span><strong>{surface.label}</strong><p>{surface.description}</p>
      </button>)}
    </div>
  </div></div>;
}

function SurfaceHeading({ surface, subtitle, children }) {
  return <header className="surface-heading"><span className="heading-icon"><Icon name={surface.icon} size={15}/></span><div className="surface-heading-copy"><strong>{surface.label}</strong><span>{subtitle}</span></div><div className="heading-actions">{children}</div></header>;
}

function OverviewSurface() {
  const turns = [
    ["T04", "定义 Surface 信息架构", "7 calls", "21s"], ["T03", "读取 Scry 右栏实现", "13 calls", "44s"], ["T02", "检查 t3code 参考源码", "9 calls", "38s"]
  ];
  return <><SurfaceHeading surface={surfaceCatalog[0]} subtitle="当前会话 · 证据档案"><button className="icon-button" title="刷新"><Icon name="refresh" size={14}/></button></SurfaceHeading><div className="surface-scroll">
    <div className="verdict"><span className="verdict-icon"><Icon name="check" size={16}/></span><div><strong>当前任务正常推进</strong><p>没有运行错误；终端为概念 Surface，不计入现有能力结论。</p></div></div>
    <div className="context-meter"><div className="ring"><span>61%</span></div><div className="context-copy"><small>CONTEXT WINDOW · 示例</small><strong>124k / 203k</strong><p>来自当前 Provider 最近一次可证明的上下文快照。</p></div></div>
    <div className="metric-grid"><div className="metric"><small>调用</small><strong>29</strong><span>工具 24 · MCP 5</span></div><div className="metric"><small>文件</small><strong>7</strong><span>结构化工具证据</span></div><div className="metric"><small>错误</small><strong style={{color:"var(--ok)"}}>0</strong><span>完整观测下的 true zero</span></div><div className="metric"><small>模型耗时</small><strong>1m 43s</strong><span>最近已知累计值</span></div></div>
    <section className="surface-section"><div className="surface-section-head">每轮调用<span>示例会话</span></div>{turns.map((turn) => <div className="turn-row" key={turn[0]}><span className="turn-id">{turn[0]}</span><div className="turn-copy"><strong>{turn[1]}</strong><span>{turn[2]}</span></div><span className="turn-time">{turn[3]}</span></div>)}</section>
  </div></>;
}

const fileContents = {
  "OverviewPanel.tsx": `<span class="code-key">export function</span> <span class="code-type">OverviewPanel</span>({\n  turns, diagnostics, diff, usage\n}: OverviewPanelProps) {\n  <span class="code-key">const</span> [tab, setTab] = useState(\n    <span class="code-string">'overview'</span>\n  )\n\n  <span class="code-key">return</span> (\n    &lt;aside className=<span class="code-string">"panel"</span>&gt;\n      ...\n    &lt;/aside&gt;\n  )\n}`,
  "WorkspacePanel.tsx": `<span class="code-key">export function</span> <span class="code-type">WorkspacePanel</span>({ cwd }) {\n  <span class="code-key">const</span> [selected, setSelected] =\n    useState&lt;WorkspaceEntry | null&gt;(null)\n\n  <span class="code-key">return</span> (\n    &lt;section className=<span class="code-string">"workspace-panel"</span>&gt;\n      ...\n    &lt;/section&gt;\n  )\n}`,
  "TurnDiffReviewPanel.tsx": `<span class="code-key">export function</span> <span class="code-type">TurnDiffReviewPanel</span>() {\n  <span class="code-key">return</span> &lt;section&gt;Diff review&lt;/section&gt;\n}`,
  "styles.css": `<span class="code-type">.right-panel-slot</span> {\n  min-width: 0;\n  min-height: 0;\n  overflow: hidden;\n  background: var(--panel);\n}`,
  "CLAUDE.md": `# Scry\n\n本地 AI agent 观测与治理桌面 App。\n\n右侧 OverviewPanel 只解释当前对话会话；\n跨会话证据属于分析页。`
};

function FilesSurface() {
  const [selected, setSelected] = useState("OverviewPanel.tsx");
  const [query, setQuery] = useState("");
  return <><SurfaceHeading surface={surfaceCatalog[1]} subtitle="/vibecoding/scry"><button className="icon-button" title="复制路径"><Icon name="copy" size={13}/></button></SurfaceHeading><div className="files-layout"><div className="file-tree"><label className="tree-search"><Icon name="search" size={11}/><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="筛选文件"/></label>{fileTree.filter((item)=>item.name.toLowerCase().includes(query.toLowerCase()) || item.type === "folder").map((item, i) => <button key={`${item.name}-${i}`} className={`tree-row ${selected === item.name ? "active" : ""}`} style={{paddingLeft: 6 + item.depth * 13}} onClick={()=>item.type === "file" && setSelected(item.name)}><Icon name={item.type === "folder" ? "folder" : "file"} size={11}/><span>{item.name}</span></button>)}</div><div className="file-preview"><div className="file-preview-head"><Icon name="file" size={11}/>{selected}</div><pre dangerouslySetInnerHTML={{__html:fileContents[selected] || ""}}></pre></div></div></>;
}

function DiffSurface() {
  const [selected, setSelected] = useState(diffFiles[1]);
  const lines = [
    ["18", " ", "export interface RightSurfacePanelProps {", ""], ["19", "+", "  surfaces: RightSurface[]", "added"], ["20", "+", "  activeSurfaceId: string | null", "added"], ["21", "+", "  onOpenSurface: (kind: SurfaceKind) => void", "added"], ["22", " ", "}", ""], ["23", " ", "", ""], ["24", "-", "export function OverviewPanel(props) {", "removed"], ["25", "+", "export function RightSurfacePanel(props) {", "added"], ["26", "+", "  const active = resolveActiveSurface(props)", "added"], ["27", " ", "  return (", ""], ["28", "+", "    <SurfaceTabs surfaces={props.surfaces} />", "added"], ["29", "+", "    <SurfaceContent surface={active} />", "added"], ["30", " ", "  )", ""]
  ];
  return <><SurfaceHeading surface={surfaceCatalog[2]} subtitle="3 files · +348 −61"><button className="icon-button" title="复制摘要"><Icon name="copy" size={13}/></button></SurfaceHeading><div className="diff-layout"><nav className="diff-nav"><div className="diff-nav-summary">WORKTREE CHANGES<br/><span className="add">+348</span> <span className="del">−61</span></div>{diffFiles.map((file)=><button key={file.path} className={`diff-file ${selected.path === file.path ? "active" : ""}`} onClick={()=>setSelected(file)}><strong>{file.name}</strong><span className="diff-count"><b className="add">+{file.add}</b><b className="del">−{file.del}</b></span></button>)}</nav><div className="diff-code">{lines.map((line,i)=><div key={i} className={`diff-line ${line[3]}`}><span className="diff-ln">{line[0]}</span><span className="diff-sign">{line[1]}</span><span>{line[2]}</span></div>)}</div></div></>;
}

function TerminalSurface() {
  const [cleared, setCleared] = useState(false);
  return <div className="terminal-shell"><div className="terminal-bar"><button className="terminal-tab"><Icon name="terminal" size={12}/>Terminal 1</button><button className="icon-button" title="新建终端"><Icon name="plus" size={14}/></button><div className="terminal-tools"><button className="icon-button" title="分割终端"><Icon name="split" size={14}/></button><button className="icon-button" title="清空" onClick={()=>setCleared(true)}><Icon name="trash" size={14}/></button></div></div><div className="terminal-output">{!cleared ? <><div className="muted">Scry terminal concept · workspace /vibecoding/scry</div><div><span className="prompt">$</span> scry turns summary</div><div className="ok">session: example · turns: 4 · status: active</div><div><span className="prompt">$</span> <span className="muted">▌</span></div></> : <div><span className="prompt">$</span> <span className="muted">▌</span></div>}</div><div className="terminal-concept-note"><Icon name="alert" size={11}/>概念 Surface：生产实现需要新增 PTY 生命周期、权限与 shell 环境隔离。</div></div>;
}

function AgentsSurface() {
  const agents = [
    {name:"repo-inspector", meta:"Codex subagent · 34s", task:"读取 Scry 右栏组件与现有数据契约", status:"运行中", tone:"", w:"72%"},
    {name:"reference-audit", meta:"GitHub source · 18s", task:"核对 t3code Surface tabs 与 empty state", status:"已完成", tone:"done", w:"100%"},
    {name:"browser-check", meta:"等待设计稿", task:"预览 1440×900 与 1024px 窄窗口", status:"等待", tone:"wait", w:"24%"}
  ];
  return <><SurfaceHeading surface={surfaceCatalog[4]} subtitle="当前任务 · 3 个工作单元"></SurfaceHeading><div className="surface-scroll"><div className="agent-list">{agents.map((agent)=><article className="agent-card" key={agent.name}><div className="agent-head"><span className="agent-avatar"><Icon name="agents" size={13}/></span><div className="agent-copy"><strong>{agent.name}</strong><span>{agent.meta}</span></div><span className={`status-pill ${agent.tone}`}><i></i>{agent.status}</span></div><p className="agent-task">{agent.task}</p><div className="agent-meter"><span style={{"--w":agent.w}}></span></div></article>)}</div></div></>;
}

function SurfaceContent({ activeId, onOpen }) {
  if (!activeId) return <EmptySurface onOpen={onOpen}/>;
  if (activeId === "overview") return <OverviewSurface/>;
  if (activeId === "files") return <FilesSurface/>;
  if (activeId === "diff") return <DiffSurface/>;
  if (activeId === "terminal") return <TerminalSurface/>;
  return <AgentsSurface/>;
}

function RightWorkspace({ openIds, activeId, onOpen, onActivate, onClose, onHide, maximized, onMaximize }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    const close = (event) => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <aside className="right-workspace" aria-label="右侧 Surface 工作区" data-screen-label="Scry 右侧 Surface 工作区">
    <div className="surface-topbar"><div className="surface-tabs">{openIds.map((id)=>{ const surface = surfaceCatalog.find((item)=>item.id===id); return <div key={id} className={`surface-tab ${activeId===id ? "active" : ""}`}><button className="tab-close" onClick={()=>onClose(id)} aria-label={`关闭 ${surface.label}`}><Icon name={surface.icon} size={12} className="surface-icon"/><Icon name="close" size={12} className="close-icon"/></button><button style={{border:0,background:"transparent",padding:0,minWidth:0,color:"inherit",cursor:"pointer"}} onClick={()=>onActivate(id)}><span className="label">{surface.label}</span></button>{surface.available === "concept" && <i className="concept-dot" title="概念能力"></i>}</div>;})}</div><div className="surface-actions"><div className="surface-add-wrap" ref={menuRef}><button className={`icon-button ${menuOpen ? "on" : ""}`} onClick={()=>setMenuOpen(!menuOpen)} title="添加 Surface"><Icon name="plus" size={15}/></button>{menuOpen && <div className="surface-menu">{surfaceCatalog.map((surface)=><button className="menu-item" key={surface.id} onClick={()=>{onOpen(surface.id);setMenuOpen(false);}}><Icon name={surface.icon} size={13}/>{surface.label}{surface.available === "concept" && <span>概念</span>}</button>)}</div>}</div><button className={`icon-button ${maximized ? "on" : ""}`} onClick={onMaximize} title={maximized ? "恢复面板" : "最大化面板"}><Icon name={maximized ? "collapse" : "expand"} size={15}/></button><button className="icon-button" onClick={onHide} title="隐藏右侧工作区"><Icon name="panel" size={15}/></button></div></div>
    <div className="surface-body"><SurfaceContent activeId={activeId} onOpen={onOpen}/></div>
  </aside>;
}

function App() {
  const [theme, setTheme] = useState("dark");
  const [panelVisible, setPanelVisible] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [openIds, setOpenIds] = useState(["overview"]);
  const [activeId, setActiveId] = useState("overview");
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const openSurface = (id) => { setOpenIds((current)=>current.includes(id) ? current : [...current,id]); setActiveId(id); };
  const closeSurface = (id) => {
    const index = openIds.indexOf(id);
    const next = openIds.filter((item)=>item!==id);
    setOpenIds(next);
    if (activeId===id) setActiveId(next[Math.min(index,next.length-1)] || null);
  };
  const classes = ["prototype-shell", !panelVisible && "panel-hidden", maximized && "panel-max"].filter(Boolean).join(" ");
  return <div className={classes}>
    <Sidebar theme={theme} onTheme={()=>setTheme(theme === "dark" ? "light" : "dark")}/>
    <MainWorkspace panelVisible={panelVisible} onShowPanel={()=>setPanelVisible(true)}/>
    {panelVisible && <RightWorkspace openIds={openIds} activeId={activeId} onOpen={openSurface} onActivate={setActiveId} onClose={closeSurface} onHide={()=>{setPanelVisible(false);setMaximized(false);}} maximized={maximized} onMaximize={()=>setMaximized(!maximized)}/>}
    <div className="prototype-note">Scry right surface workbench · structural prototype · example data</div>
  </div>;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
