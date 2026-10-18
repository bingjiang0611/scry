import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Icon } from '../../src/renderer/components/primitives/Icon'
import { InteractivePreview } from './InteractivePreview'
import { copy } from './copy'

type CanvasProps = { children?: React.ReactNode; id?: string; title?: string; subtitle?: string; gap?: number; label?: string; width?: number; height?: number; minScale?: number; maxScale?: number }
const { DesignCanvas, DCSection, DCArtboard, DCPostIt } = window as unknown as Record<string, React.ComponentType<CanvasProps>>

type Direction = 'A' | 'B' | 'C'

function Sidebar() {
  return <aside className="app-sidebar">
    <div className="traffic"><i /><i /><i /><b>Scry</b></div>
    <button className="side-action"><Icon name="plus" />新建会话</button>
    <div className="side-search"><Icon name="search" />搜索会话</div>
    <div className="side-rule" />
    <button className="side-nav"><Icon name="chart" />用量分析</button>
    <button className="side-nav"><Icon name="cube" />MCP</button>
    <button className="side-nav"><Icon name="terminal" />Meta Prompts</button>
    <div className="side-section">项目</div>
    <div className="side-project"><span className="dot" /><span>Scry · mac2</span></div>
    <div className="side-project"><Icon name="folder" /><span>vibecoding</span></div>
    <div className="side-spacer" />
    <div className="side-foot"><button className="side-nav"><Icon name="settings" />设置</button></div>
  </aside>
}

function Button({ children, kind = '', disabled = false, onClick }: { children: React.ReactNode; kind?: string; disabled?: boolean; onClick?: () => void }) {
  return <button type="button" className={`btn ${kind}`} disabled={disabled} onClick={onClick}>{children}</button>
}

function SettingsRail() {
  return <nav className="settings-rail" aria-label="设置分区">
    <button className="settings-tab"><Icon name="settings" />外观</button>
    <button className="settings-tab"><Icon name="archive" />已存档会话</button>
    <button className="settings-tab active"><Icon name="globe" />远程访问</button>
  </nav>
}

function HostList({ compact = false }: { compact?: boolean }) {
  const [expanded, setExpanded] = useState(true)
  const [connected, setConnected] = useState(true)
  return <ul className="host-list">
    <li className="host-row">
      <div className="host-main">
        <button className="host-id btn subtle" style={{ justifyContent: 'start', padding: 0 }} onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />
          <span className="host-copy" style={{ textAlign: 'left' }}><b>mac2</b><code>bing@192.168.1.21:22</code></span>
        </button>
        <span className={`state ${connected ? 'ok' : ''}`}><i />{connected ? '已连接' : '未连接'}</span>
        <span className="row-actions"><Button onClick={() => setConnected(!connected)}>{connected ? '断开' : '连接'}</Button></span>
      </div>
      {expanded && !compact && <div className="host-details">
        <div className="detail-line"><span>主机指纹</span><code>9A:47:2C:60:8D:B5:11:C8…</code><Button kind="subtle"><Icon name="edit" />编辑地址</Button></div>
        <div className="project-line"><Icon name="folder" /><span className="host-copy"><b>scry</b><code>/Users/bing/IdeaProjects/scry</code></span><Button>新建会话</Button></div>
      </div>}
    </li>
  </ul>
}

function AccessCards() {
  const [invite, setInvite] = useState(false)
  const [pairing, setPairing] = useState(false)
  return <div className="access-grid">
    <article className="access-card">
      <div className="access-head"><span className="access-icon"><Icon name="server" /></span><span className="access-copy"><b>{copy.desktop}</b></span><span className="status-pill">已启用</span></div>
      <div className="access-actions"><Button onClick={() => setInvite(!invite)}>生成 SSH 邀请</Button><Button kind="subtle danger">关闭</Button></div>
      {invite && <div className="code-box"><b>完整 SSH 邀请显示区域（设计示意）</b><small>短时有效 · 仅发送给预期设备</small></div>}
    </article>
    <article className="access-card">
      <div className="access-head"><span className="access-icon"><Icon name="laptop" /></span><span className="access-copy"><b>{copy.phone}</b></span><span className="status-pill">中继在线</span></div>
      <div className="access-actions"><Button onClick={() => setPairing(!pairing)}>生成配对码</Button></div>
      {pairing && <div className="code-box"><b>扫码区域（设计示意，不可配对）</b><small>实际显示宿主返回的二维码 · 约 2 分钟内有效</small></div>}
      <div className="devices"><div className="device"><Icon name="laptop" /><b>Bing 的 iPhone</b><button>{copy.revoke}</button></div></div>
    </article>
  </div>
}

function DirectionA() {
  return <>
    <div className="pane-head"><div><h2>远程访问</h2></div><Button kind="primary"><Icon name="plus" />添加主机</Button></div>
    <div className="pane-body">
      <section className="section"><div className="section-title"><h3>{copy.outbound}</h3></div><HostList /></section>
      <div className="section-rule" />
      <section className="section"><div className="section-title"><h3>{copy.inbound}</h3></div><AccessCards /></section>
    </div>
  </>
}

function DirectionB() {
  const [selected, setSelected] = useState('mac2')
  return <div className="master-layout">
    <aside className="master-list">
      <div className="master-label">其他主机</div>
      <button className={`master-item ${selected === 'mac2' ? 'active' : ''}`} onClick={() => setSelected('mac2')}><Icon name="server" /><span className="master-item-copy"><b>mac2</b><span>已连接</span></span></button>
      <button className="master-item"><Icon name="plus" /><span className="master-item-copy"><b>添加主机</b><span>使用 SSH 邀请</span></span></button>
      <div className="master-label">这台 Mac</div>
      <button className={`master-item ${selected === 'desktop' ? 'active' : ''}`} onClick={() => setSelected('desktop')}><Icon name="server" /><span className="master-item-copy"><b>Scry 桌面</b><span>SSH 已启用</span></span></button>
      <button className={`master-item ${selected === 'mobile' ? 'active' : ''}`} onClick={() => setSelected('mobile')}><Icon name="laptop" /><span className="master-item-copy"><b>手机</b><span>1 台已授权</span></span></button>
    </aside>
    <main className="master-detail">
      <h2>{selected === 'mac2' ? 'mac2' : selected === 'desktop' ? 'Scry 桌面' : '手机'}</h2>
      <p>{selected === 'mac2' ? 'bing@192.168.1.21:22' : selected === 'desktop' ? '通过 SSH 访问这台 Mac' : '通过加密中继访问这台 Mac'}</p>
      {selected === 'mac2' ? <>
        <div className="state ok"><i />已连接</div>
        <div className="detail-group"><h3>连接</h3><div className="detail-block"><div className="detail-row"><span>主机地址</span><code>bing@192.168.1.21:22</code><Button>编辑</Button></div><div className="detail-row"><span>主机指纹</span><code>9A:47:2C:60:8D:B5:11:C8…</code><span /></div></div></div>
        <div className="detail-group"><h3>项目</h3><div className="detail-block"><div className="detail-row"><span>scry</span><code>/Users/bing/IdeaProjects/scry</code><Button>新建会话</Button></div></div></div>
        <div className="detail-group"><Button>断开</Button> <Button kind="subtle danger">移除主机</Button></div>
      </> : <AccessCards />}
    </main>
  </div>
}

function DirectionC() {
  return <>
    <div className="pane-head"><div><h2>远程访问</h2><p>先设置这台 Mac 如何被访问，再管理其他主机。</p></div></div>
    <div className="pane-body">
      <section className="local-hero"><div><h3>允许访问这台 Mac</h3><p>桌面 SSH 和手机中继均已启用。已授权 1 台设备。</p><div className="access-actions"><Button>生成桌面邀请</Button><Button>配对新设备</Button></div></div><div className="local-visual"><Icon name="server" /></div></section>
      <div className="host-summary"><div className="summary-box"><b>2</b><span>访问方式</span></div><div className="summary-box"><b>1</b><span>授权设备</span></div><div className="summary-box"><b>0</b><span>等待确认</span></div></div>
      <section className="section"><div className="section-title"><h3>我连接的主机</h3><Button kind="primary"><Icon name="plus" />添加主机</Button></div><HostList compact /></section>
      <p className="safety-note"><Icon name="lock" />配对时请核对设备指纹。邀请只发送给预期设备。</p>
    </div>
  </>
}

function SettingsMock({ direction }: { direction: Direction }) {
  return <div className="screen"><Sidebar /><main className="main-ghost"><div className="ghost-top" /><div className="ghost-copy"><b>会话内容</b><span>设置打开时保持在当前上下文</span></div><div className="overlay"><section className="settings"><header className="settings-head"><b>设置</b><button aria-label="关闭"><Icon name="x" /></button></header><div className="settings-shell"><SettingsRail /><div className="pane">{direction === 'A' ? <DirectionA /> : direction === 'B' ? <DirectionB /> : <DirectionC />}</div></div></section></div></main></div>
}

function LocationEntry() {
  return <div className="screen screen--crop"><Sidebar /><main className="main-ghost"><div className="ghost-top" /><div className="location-popover"><div className="location-head">执行位置</div><div className="location-host"><Icon name="laptop" /><span><b>这台 Mac</b><span>/Users/bing/IdeaProjects/scry</span></span><span className="state ok"><i />本机</span></div><div className="location-host"><Icon name="server" /><span><b>mac2</b><span>已连接 · 3 个项目</span></span><span className="state ok"><i /></span></div><button className="location-manage"><Icon name="settings" />管理远程访问…</button></div><div className="annotation"><b>入口统一</b><br />原「管理主机…」改名，并直接打开「设置 → 远程访问」。</div></main></div>
}

function App() {
  return <>
    <div className="design-note"><h1>远程访问设置 · 结构提案</h1><p><b>目标：</b>删除侧栏「主机」一级入口，把低频管理集中到设置。三稿对比信息结构。<a href="./preview.html">打开推荐稿 A 的完整交互预览 ↗</a>。这里只演示本地状态，不建立真实连接。画布支持滚轮缩放与拖动，双击/展开可聚焦单稿。</p></div>
    <DesignCanvas minScale={0.42} maxScale={1.15}>
      <DCSection id="directions" title="三个信息结构方向" subtitle="同一内容与状态；区别不只是换色" gap={54}>
        <DCArtboard id="a" label="A · 分区单栏（推荐）" width={1120} height={760}><SettingsMock direction="A" /></DCArtboard>
        <DCArtboard id="b" label="B · 列表—详情" width={1120} height={760}><SettingsMock direction="B" /></DCArtboard>
        <DCArtboard id="c" label="C · 本机优先" width={1120} height={760}><SettingsMock direction="C" /></DCArtboard>
        <DCPostIt title="推荐 A" width={250}>沿用设置页单层结构。出站在前、入站在后；主机少时不浪费空间，也不制造第二套导航。</DCPostIt>
      </DCSection>
      <DCSection id="entry" title="配套入口变化" subtitle="侧栏删除「主机」；执行位置菜单负责跳转" gap={54}>
        <DCArtboard id="entry-location" label="LocationPicker · 管理远程访问" width={670} height={520}><LocationEntry /></DCArtboard>
        <DCPostIt title="不删除能力" width={235}>会话创建仍从执行位置菜单和远程项目分组进入；这里只移动“管理入口”，不削弱连接与会话能力。</DCPostIt>
      </DCSection>
    </DesignCanvas>
  </>
}

createRoot(document.getElementById('root')!).render(window.location.pathname.endsWith('/preview.html') ? <InteractivePreview /> : <App />)
