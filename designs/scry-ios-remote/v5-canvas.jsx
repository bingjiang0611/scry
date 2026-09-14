import './design-canvas-v5.jsx'

const { useState } = React
const { DesignCanvas, DCSection, DCArtboard, DCPostIt } = window

const sessions = [
  { project: 'vibecoding', title: '修复远程会话归档', time: '刚刚', state: 'done', provider: 'Qoder' },
  { project: 'storefront', title: '检查结算页回归', time: '12m', state: 'running', provider: 'Codex' },
  { project: 'notes', title: '整理发布说明', time: '2h', state: 'idle', provider: 'Claude' }
]

function Icon({ name, size = 20 }) {
  const paths = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="m5 12 7-7 7 7M12 5v14"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
    folder: '<path d="M3 7.5h7l2 2h9v9.5H3z"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
    shield: '<path d="M12 3 5 6v5c0 4.5 2.9 8 7 10 4.1-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
    bolt: '<path d="m13 2-8 12h7l-1 8 8-12h-7z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    device: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.5-1.2.9-1.9-2.1-2.1-1.9.9-1.2-.5-.7-2h-3l-.7 2-1.2.5-1.9-.9-2.1 2.1.9 1.9-.5 1.2-2 .7v3l2 .7.5 1.2-.9 1.9 2.1 2.1 1.9-.9 1.2.5.7 2h3l.7-2 1.2-.5 1.9.9 2.1-2.1-.9-1.9.5-1.2z"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    inbox: '<path d="M4 4h16v16H4zM4 14h5l2 2h2l2-2h5"/>',
    link: '<path d="M10 13a4 4 0 0 0 5.7.1l2.2-2.2a4 4 0 0 0-5.7-5.7L11 6.4M14 11a4 4 0 0 0-5.7-.1l-2.2 2.2a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
    doc: '<path d="M6 3h8l4 4v14H6zM14 3v5h5"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>'
  }
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" dangerouslySetInnerHTML={{__html: paths[name] || paths.more}} />
}

function Dot({ state }) { return <span className={`state-dot ${state}`} /> }
function IconButton({ icon, label, onClick, primary=false }) { return <button className={`icon-btn ${primary?'primary':''}`} aria-label={label} onClick={onClick}><Icon name={icon}/></button> }
function Provider({ children }) { return <span className="provider">{children}</span> }

function Shell({ direction, children, route, setRoute }) {
  return <div className={`phone dir-${direction.toLowerCase()}`}>
    <div className="safe-cap" />
    {children}
    {route === 'menu' && <MenuSheet setRoute={setRoute}/>}
  </div>
}

function MenuSheet({ setRoute }) {
  return <div className="overlay" onClick={() => setRoute('home')}>
    <div className="sheet" onClick={e=>e.stopPropagation()}>
      <div className="grabber"/>
      <button className="sheet-row" onClick={() => setRoute('pair')}><Icon name="link"/>连接 Mac<span>已配对</span><Icon name="chevron"/></button>
      <button className="sheet-row" onClick={() => setRoute('settings')}><Icon name="gear"/>设置<span></span><Icon name="chevron"/></button>
      <div className="sheet-foot">凭据与执行保留在你的 Mac</div>
    </div>
  </div>
}

function Header({ title, subtitle, back, onBack, onMenu, action }) {
  return <header className="topbar">
    {back ? <IconButton icon="back" label="返回" onClick={onBack}/> : <IconButton icon="menu" label="菜单" onClick={onMenu}/>}
    <div className="title-block"><strong>{title}</strong>{subtitle && <span>{subtitle}</span>}</div>
    {action || <IconButton icon="more" label="更多" onClick={onMenu}/>}
  </header>
}

function Composer({ compact=false, placeholder='给 Mac 一项任务…', showProvider=true }) {
  const [text,setText]=useState('')
  const [showAttach,setShowAttach]=useState(false)
  const [files,setFiles]=useState([])
  const [control,setControl]=useState(null)
  const [permission,setPermission]=useState('默认审批')
  const [effort,setEffort]=useState('高')
  const addFiles=(event)=>{ setFiles([...files,...Array.from(event.target.files||[]).map(file=>file.name)].slice(0,4)); setShowAttach(false) }
  return <div className={`composer ${compact?'compact':''}`}>
    {files.length>0 && <div className="attachment-chips">{files.map(name=><span key={name}><Icon name="doc" size={13}/>{name}<button onClick={()=>setFiles(files.filter(f=>f!==name))}>×</button></span>)}</div>}
    <textarea value={text} onChange={e=>setText(e.target.value)} placeholder={placeholder}/>
    <div className="composer-actions">
      <IconButton icon="plus" label="添加图片或文件" onClick={()=>setShowAttach(!showAttach)}/>
      <button className="access" onClick={()=>setControl(control==='permission'?null:'permission')}><Icon name="shield" size={16}/> {permission}</button>
      <span className="grow"/>
      <button className="effort" onClick={()=>setControl(control==='effort'?null:'effort')}>◉ {effort}</button>
      {showProvider&&<Provider>Qoder</Provider>}
      <IconButton icon="arrow" label="发送" primary onClick={()=>setText('')}/>
    </div>
    {control==='permission' && <div className="control-menu permission-menu"><b>权限</b>{['默认审批','自动审查','完全访问'].map(item=><button key={item} onClick={()=>{setPermission(item);setControl(null)}}><span>{item}</span>{permission===item&&<Icon name="check"/>}</button>)}</div>}
    {control==='effort' && <div className="control-menu effort-menu"><b>Effort</b>{['低','中','高','极高'].map(item=><button key={item} onClick={()=>{setEffort(item);setControl(null)}}><span>{item}</span>{effort===item&&<Icon name="check"/>}</button>)}</div>}
    {showAttach && <div className="attach-menu">
      <label><Icon name="plus"/><span><b>照片图库</b><small>上传 JPG、PNG、GIF 或 WebP</small></span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={addFiles}/></label>
      <label><Icon name="doc"/><span><b>选择文件</b><small>上传文本、代码或文档</small></span><input type="file" multiple onChange={addFiles}/></label>
    </div>}
  </div>
}

function Conversation({ direction, setRoute }) {
  return <div className="screen">
    <Header title="修复远程会话归档" subtitle="vibecoding · Qoder" back onBack={()=>setRoute('home')} action={<IconButton icon="more" label="会话选项" onClick={()=>setRoute('menu')}/>}/>
    <main className="conversation">
      <div className="message user">手机发起的对话，在 Mac 上看不到内容。请定位并修复。</div>
      <div className="agent-head"><Dot state="done"/><b>Qoder</b><span>已完成 · 8 秒</span></div>
      <div className="answer">
        <p>已找到原因：续聊时 Provider 不会再次上报会话 ID，旧逻辑因此留下了无法打开的临时会话。</p>
        <p>现在会直接复用真实会话身份，并把本轮内容归档到同一段对话。</p>
      </div>
      <button className="evidence-row"><Icon name="check" size={16}/><span>运行证据</span><b>已归档</b><Icon name="chevron" size={16}/></button>
      {direction==='C' && <div className="run-card"><span className="eyebrow">RUN RECEIPT</span><b>recorded → dispatched → settled</b><span>2,041 tokens · 0 tools · Mac verified</span></div>}
    </main>
    <footer className="bottom-compose"><Composer compact placeholder="继续这段对话…"/></footer>
  </div>
}

function NewTask({ direction, setRoute, initialProject='vibecoding' }) {
  const [picker,setPicker]=useState(null)
  const [project,setProject]=useState(initialProject)
  const [provider,setProvider]=useState('Qoder · Ultimate')
  const [folderPath,setFolderPath]=useState(null)
  const providers=['Qoder · Ultimate','Codex · GPT-5','Claude · Sonnet']
  const folders=!folderPath ? ['vibecoding','storefront','notes']
    : folderPath==='vibecoding' ? ['apps','designs','src']
    : folderPath==='vibecoding/src' ? ['main','renderer','shared'] : []
  const parentFolder=folderPath?.includes('/') ? folderPath.split('/').slice(0,-1).join('/') : null
  return <div className="screen">
    <Header title="新任务" subtitle={direction==='C'?'配置与派发':'Studio Mac'} back onBack={()=>setRoute('home')}/>
    <main className={`new-task ${direction==='C'?'form':''}`}>
      <div className="context-stack">
        <button><Icon name="laptop"/><span><small>主机</small>Studio Mac</span><Dot state="done"/></button>
        <button onClick={()=>{setFolderPath(project);setPicker('project')}}><Icon name="folder"/><span><small>工作目录</small>{project}</span><Icon name="chevron"/></button>
        <button onClick={()=>setPicker('provider')}><Icon name="bolt"/><span><small>Provider</small>{provider}</span><Icon name="chevron"/></button>
      </div>
    </main>
    <footer className="bottom-compose"><Composer placeholder="描述任务，或粘贴错误信息…" showProvider={false}/></footer>
    {picker && <div className="overlay" onClick={()=>setPicker(null)}><div className="sheet picker-sheet" onClick={e=>e.stopPropagation()}><div className="grabber"/><h3>{picker==='project'?'选择文件夹':'选择 Provider'}</h3><p>{picker==='project'?'可浏览 Mac 已授权项目内的任意文件夹':'仅显示主机当前可用的 Provider'}</p>{picker==='project' ? <>
      {folderPath&&<button className="folder-back" onClick={()=>setFolderPath(parentFolder)}>‹ {parentFolder?.split('/').at(-1)||'已授权项目'}</button>}
      {folderPath&&<div className="folder-current"><b>{folderPath.split('/').at(-1)}</b><small>/{folderPath}</small><button onClick={()=>{setProject(folderPath);setPicker(null)}}>选择此文件夹</button></div>}
      <small className="folder-label">{folderPath?'子文件夹':'已授权项目'}</small>
      {folders.length ? folders.map(choice=>{const path=folderPath?`${folderPath}/${choice}`:choice;return <button key={path} className="picker-row folder-row" onClick={()=>setFolderPath(path)}><Icon name="folder"/><span>{choice}<small>/{path}</small></span>{project===path&&<Icon name="check"/>}<Icon name="chevron"/></button>}) : <div className="folder-empty">此文件夹没有子文件夹</div>}
    </> : providers.map(choice=><button key={choice} className="picker-row" onClick={()=>{setProvider(choice);setPicker(null)}}><span>{choice}</span>{provider===choice&&<Icon name="check"/>}</button>)}</div></div>}
  </div>
}

function Pair({ setRoute }) {
  return <div className="screen quiet-screen">
    <Header title="连接 Mac" back onBack={()=>setRoute('home')}/>
    <main className="pair-body">
      <div className="pair-mark"><Icon name="laptop" size={34}/><span><Icon name="device" size={26}/></span></div>
      <h2>让 iPhone 安全连接 Scry</h2>
      <p>在 Mac 的 Scry 中打开“连接 iPhone”，然后扫描一次性配对码。</p>
      <ol><li><b>1</b><span>扫描 Mac 上显示的二维码</span></li><li><b>2</b><span>核对两端设备指纹</span></li><li><b>3</b><span>在 Mac 上确认访问权限</span></li></ol>
      <div className="privacy-note"><Icon name="shield" size={18}/>中继只传输端到端加密字节，凭据不会离开你的设备。</div>
    </main>
    <footer className="pair-actions"><button className="primary-wide">扫描配对码</button><button onClick={()=>setRoute('home')}>稍后连接</button></footer>
  </div>
}

function Settings({ setRoute }) {
  return <div className="screen">
    <Header title="设置" back onBack={()=>setRoute('home')}/>
    <main className="settings">
      <section><h3>连接</h3><button><Icon name="laptop"/><span><b>Studio Mac</b><small>已配对 · 当前可达</small></span><Dot state="done"/><Icon name="chevron"/></button></section>
      <section><h3>远程体验</h3><button><Icon name="shield"/><span><b>默认权限</b><small>完全访问</small></span><Icon name="chevron"/></button><button><Icon name="inbox"/><span><b>后台通知</b><small>运行完成与需要操作时提醒</small></span><span className="toggle on"/></button></section>
      <section><h3>关于</h3><button><Icon name="doc"/><span><b>隐私与安全</b><small>端到端加密与设备权限</small></span><Icon name="chevron"/></button></section>
    </main>
  </div>
}

function HomeA({ setRoute }) {
  const [pinnedOpen,setPinnedOpen]=useState(true)
  return <div className="screen">
    <Header title="远程" subtitle={<><Dot state="done"/> Studio Mac</>} onMenu={()=>setRoute('menu')}/>
    <main className="home home-a reference-list">
      <button className="list-heading collapsible" onClick={()=>setPinnedOpen(!pinnedOpen)}>已置顶 <span>{pinnedOpen?'⌄':'›'}</span></button>
      {pinnedOpen && <div className="plain-sessions">
        <button onClick={()=>setRoute('chat')}>Run ai-radar scrape</button>
        <button onClick={()=>setRoute('chat')}>设计 AI 评价折叠沉底标记</button>
        <button onClick={()=>setRoute('chat')}>完成需求 84850862 开发</button>
        <button onClick={()=>setRoute('chat')}>定位评价需求接口及缺失数据</button>
        <button onClick={()=>setRoute('chat')}>排查商家后台</button>
        <button onClick={()=>setRoute('chat')}>88vip</button>
        <button onClick={()=>setRoute('chat')}>增加天猫商家星级筛选</button>
      </div>}
      <div className="list-heading">项目</div>
      <div className="project-group">
        <div className="project-title"><Icon name="folder"/><b>rate-native</b><button aria-label="在 rate-native 新建任务" onClick={()=>setRoute('new-rate')}><Icon name="doc"/></button></div>
        <button className="project-session" onClick={()=>setRoute('chat')}>$rate-workflow https://project.aone.alib...</button>
        <button className="project-session" onClick={()=>setRoute('chat')}>开始处理 Aone 工单 85591443</button>
        <button className="project-session" onClick={()=>setRoute('chat')}>复盘技术方案指标</button>
      </div>
      <div className="project-group compact-project"><div className="project-title"><Icon name="folder"/><b>vibecoding</b><button onClick={()=>setRoute('new')}><Icon name="doc"/></button></div></div>
    </main>
    <footer className="home-dock"><button className="search-pill"><Icon name="search"/>搜索会话</button><IconButton icon="plus" label="新任务" primary onClick={()=>setRoute('new')}/></footer>
  </div>
}

function HomeB({ setRoute }) {
  return <div className="screen">
    <Header title="Scry" subtitle={<><Dot state="done"/> Studio Mac</>} onMenu={()=>setRoute('menu')} action={<button className="avatar" onClick={()=>setRoute('settings')}>B</button>}/>
    <main className="home home-b">
      <div className="welcome"><span className="eyebrow">MAC IS READY</span><h2>下一步做什么？</h2><Composer compact placeholder="给 Studio Mac 一项任务…"/></div>
      <div className="section-heading"><span>最近</span><button>查看全部</button></div>
      <div className="recent-list">{sessions.map(s=><button key={s.title} onClick={()=>setRoute('chat')}><span className="mini-icon"><Icon name="chat" size={17}/></span><span><b>{s.title}</b><small>{s.project} · {s.time}</small></span><Icon name="chevron" size={17}/></button>)}</div>
    </main>
  </div>
}

function HomeC({ setRoute }) {
  return <div className="screen with-tabs">
    <Header title="工作队列" subtitle="Studio Mac" onMenu={()=>setRoute('menu')} action={<IconButton icon="plus" label="新任务" primary onClick={()=>setRoute('new')}/>}/>
    <main className="home home-c">
      <div className="metrics"><div><b>1</b><span>需要处理</span></div><div><b>1</b><span>运行中</span></div><div><b>12</b><span>本周完成</span></div></div>
      <div className="queue-group attention"><h3><Dot state="attention"/>需要处理</h3><button onClick={()=>setRoute('chat')}><span><b>检查结算页回归</b><small>storefront · 等待批准</small></span><time>12m</time></button></div>
      <div className="queue-group"><h3><Dot state="running"/>正在运行</h3><button onClick={()=>setRoute('chat')}><span><b>生成发布说明</b><small>notes · Qoder</small></span><time>2m</time></button></div>
      <div className="queue-group"><h3>最近完成</h3><button onClick={()=>setRoute('chat')}><span><b>修复远程会话归档</b><small>vibecoding · 已验证</small></span><time>刚刚</time></button></div>
    </main>
    <nav className="tabs"><button className="active"><Icon name="chat"/><span>会话</span></button><button><Icon name="inbox"/><span>运行</span></button><button onClick={()=>setRoute('settings')}><Icon name="device"/><span>设备</span></button></nav>
  </div>
}

function DirectionPhone({ direction }) {
  const [route,setRoute]=useState('home')
  let content
  if(route==='chat') content=<Conversation direction={direction} setRoute={setRoute}/>
  else if(route==='new' || route==='new-rate') content=<NewTask direction={direction} setRoute={setRoute} initialProject={route==='new-rate'?'rate-native':'vibecoding'}/>
  else if(route==='pair') content=<Pair setRoute={setRoute}/>
  else if(route==='settings') content=<Settings setRoute={setRoute}/>
  else if(direction==='A') content=<HomeA setRoute={setRoute}/>
  else if(direction==='B') content=<HomeB setRoute={setRoute}/>
  else content=<HomeC setRoute={setRoute}/>
  return <Shell direction={direction} route={route} setRoute={setRoute}>{content}</Shell>
}

function DecisionCard({title,accent,points,risk}) {
  return <div className="decision-card" style={{'--accent':accent}}><span className="eyebrow">DIRECTION</span><h2>{title}</h2><ul>{points.map(p=><li key={p}>{p}</li>)}</ul><div className="tradeoff"><b>取舍</b>{risk}</div></div>
}

function App(){
  return <DesignCanvas>
    <DCSection id="directions" title="Scry Remote v5 · 三个结构方向" subtitle="同一任务、同一状态，比较信息结构而不是换皮。点开任一会话、新建按钮或菜单可查看流程。">
      <DCArtboard id="codex-refined" label="A · Codex Refined · 推荐" width={390} height={844}><DirectionPhone direction="A"/></DCArtboard>
      <DCArtboard id="chat-first" label="B · Chat First" width={390} height={844}><DirectionPhone direction="B"/></DCArtboard>
      <DCArtboard id="work-queue" label="C · Work Queue" width={390} height={844}><DirectionPhone direction="C"/></DCArtboard>
      <DCPostIt top={110} left={1325} width={220} rotate={1}>先看结构：A 最贴近 Codex；B 发起任务最快；C 最适合高频审批和运行管理。</DCPostIt>
    </DCSection>
    <DCSection id="decision" title="决策摘要" subtitle="三套都保留真实连接与运行语义；选定后再补齐全量状态并落地 SwiftUI。">
      <DCArtboard id="a-notes" label="A · 为什么推荐" width={340} height={360}><DecisionCard title="Codex Refined" accent="#2867e8" points={['无底栏，内容最安静','项目成为上下文，不再重复会话','证据折叠在回复下方','新任务上下文靠近输入']} risk="多主机与审批入口需要放进菜单或状态筛选。"/></DCArtboard>
      <DCArtboard id="b-notes" label="B · 最短路径" width={340} height={360}><DecisionCard title="Chat First" accent="#111827" points={['首页即输入','历史结构极简','最接近通用 AI 对话习惯','首次使用学习成本低']} risk="项目与运行状态被弱化，不利于远程管理多个任务。"/></DCArtboard>
      <DCArtboard id="c-notes" label="C · 最强控制" width={340} height={360}><DecisionCard title="Work Queue" accent="#6d4aff" points={['待处理优先','运行与设备独立入口','状态扫描效率最高','适合重度远程用户']} risk="导航更重，更像工程控制台，和 Codex 的轻量感距离最大。"/></DCArtboard>
    </DCSection>
  </DesignCanvas>
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>)
