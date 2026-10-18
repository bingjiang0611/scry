import React, { useState } from 'react'
import { Icon } from '../../src/renderer/components/primitives/Icon'

type Host = { name: string; address: string; connected: boolean }
type Scenario = 'default' | 'empty' | 'unknown' | 'pending' | 'dormant' | 'disabled' | 'long'
type Sheet = 'add' | 'edit' | 'pair' | 'invite' | 'remove' | 'revoke' | null
const sampleHost = { name: 'mac2', address: 'bing@192.168.1.21:22', connected: true }
const fingerprint = '9A47 2C60 8DB5 11C8 309F B34D 221A 98BC'

export function InteractivePreview() {
  const [hosts, setHosts] = useState<Host[]>([sampleHost])
  const [scenario, setScenario] = useState<Scenario>('default')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [ssh, setSsh] = useState(true)
  const [authorized, setAuthorized] = useState(true)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [user, setUser] = useState('bing')
  const [hostname, setHostname] = useState('')
  const [port, setPort] = useState('22')
  const [invitation, setInvitation] = useState('')
  const [tab, setTab] = useState('remote')
  const [open, setOpen] = useState(true)

  function changeScenario(value: Scenario) {
    setScenario(value)
    setHosts(value === 'empty' ? [] : value === 'long' ? [{ name: '研发工作站 · Very-long-hostname-development-2026', address: 'developer@engineering-workstation.example.internal:22022', connected: true }, { name: 'linux-dev', address: 'dev@10.0.1.82:22', connected: false }, { name: 'mac2', address: 'bing@192.168.1.21:22', connected: true }] : [{ ...sampleHost }])
    setExpanded(null)
    setPending(value === 'pending')
    setAuthorized(value !== 'empty')
    setSsh(value !== 'disabled')
    setSheet(null)
    setNotice('')
  }

  function beginAdd() {
    setName(''); setUser(''); setHostname(''); setPort('22'); setInvitation(''); setSheet('add')
  }

  function beginEdit() {
    const host = hosts[expanded ?? 0]
    const [sshUser, hostPort] = host.address.split('@')
    const [sshHost, sshPort] = hostPort.split(':')
    setName(host.name); setUser(sshUser); setHostname(sshHost); setPort(sshPort); setSheet('edit')
  }

  function submitForm(event: React.FormEvent) {
    event.preventDefault()
    const host = { name: name || hostname, address: `${user}@${hostname}:${port}`, connected: false }
    if (sheet === 'add') {
      setHosts([...hosts, host]); setNotice('设计演示：已添加主机。真实配对仍需远端批准。')
    } else {
      setHosts(hosts.map((item, index) => index === expanded ? host : item)); setNotice('地址已保存；请手动重新连接。远端任务不会因此停止。')
    }
    setSheet(null)
  }

  const mobileUnavailable = scenario === 'disabled'
  const relayDormant = scenario === 'dormant'
  const unknown = scenario === 'unknown'

  return <div className="preview-page">
    <header className="preview-toolbar"><div><b>远程访问 · 推荐稿 A</b><span>独立设计演示 · 所有状态为样例，不建立真实连接</span></div><a href="./remote-access-settings.html">查看方案对照 ↗</a></header>
    <nav className="scenario-controls" aria-label="设计状态切换">
      {([['default', '默认'], ['empty', '空列表'], ['unknown', '状态未知'], ['pending', '待确认'], ['dormant', '中继休眠'], ['disabled', '手机未启用'], ['long', '多主机 / 长内容']] as const).map(([value, label]) => <button key={value} aria-pressed={scenario === value} onClick={() => changeScenario(value)}>{label}</button>)}
    </nav>
    {!open ? <div className="preview-closed"><p>会话上下文保留，未发送任何内容。</p><button className="btn" onClick={() => setOpen(true)}>打开设置 · 远程访问</button></div> : <section className="settings preview-settings" aria-label="设置">
      <header className="settings-head"><b>设置</b><button aria-label="关闭设置" onClick={() => setOpen(false)}><Icon name="x" /></button></header>
      <div className="settings-shell"><nav className="settings-rail" aria-label="设置分区">{([['appearance', 'settings', '外观'], ['archived', 'archive', '已存档会话'], ['remote', 'globe', '远程访问']] as const).map(([value, icon, label]) => <button key={value} className={`settings-tab ${tab === value ? 'active' : ''}`} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}><Icon name={icon} />{label}</button>)}<div className="rail-spacer" /></nav>
      <main className="pane">{tab !== 'remote' ? <div className="pane-body"><h2>{tab === 'appearance' ? '外观' : '已存档会话'}</h2><p className="muted">这两个页面保留原实现。本设计稿只展开远程访问。</p><button className="btn" onClick={() => setTab('remote')}>返回远程访问</button></div> : <>
        <div className="pane-head"><div><h2>远程访问</h2></div><button className="btn primary" onClick={beginAdd}><Icon name="plus" />添加主机</button></div>
        <div className="pane-body">
          {notice && <div className="preview-notice" role="status">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><Icon name="x" /></button></div>}
          <section className="section"><div className="section-title"><h3>我连接的主机</h3>{!unknown && hosts.length > 0 && <span className="numeric">{hosts.filter(host => host.connected).length} / {hosts.length} 台已连接</span>}</div>
            {unknown && <div className="preview-alert" role="alert"><span><Icon name="alert" />无法确认连接状态 · 读取失败</span><button className="btn" onClick={() => changeScenario('default')}>重试读取（演示）</button></div>}
            {hosts.length === 0 ? <div className="preview-empty"><Icon name="server" /><b>还没有添加主机</b><p>在另一台电脑的 Scry 中生成 SSH 邀请，再在这里添加。</p><button className="btn" onClick={beginAdd}><Icon name="plus" />添加主机</button></div> : <ul className="host-list">{hosts.map((host, index) => <li className="host-row" key={index}>
              <div className="host-main"><button className="host-id host-select" aria-expanded={expanded === index} onClick={() => setExpanded(expanded === index ? null : index)}><span className="host-icon"><Icon name="server" /></span><span className="host-copy"><b title={host.name}>{host.name}</b><code title={host.address}>{host.address}</code></span></button><span className={`state ${unknown ? 'unknown' : host.connected ? 'ok' : ''}`}><i />{unknown ? '状态未知' : host.connected ? '已连接' : '未连接'}</span><div className="row-actions"><button className="btn" disabled={unknown} onClick={() => setHosts(hosts.map((item, current) => current === index ? { ...item, connected: !item.connected } : item))}>{host.connected ? '断开' : '连接'}</button><button className="btn subtle" aria-label={`${expanded === index ? '收起' : '展开'} ${host.name} 的详情`} onClick={() => setExpanded(expanded === index ? null : index)}><Icon name={expanded === index ? 'chevronUp' : 'chevronDown'} /></button></div></div>
              {expanded === index && <div className="host-details"><div className="detail-line"><span>主机指纹</span><code title={fingerprint}>{fingerprint}</code><button className="btn subtle" onClick={beginEdit}><Icon name="edit" />编辑地址</button></div><div className="project-line"><Icon name="folder" /><span className="host-copy"><b>scry</b><code>/Users/bing/IdeaProjects/scry</code></span><button className="btn" disabled={unknown || !host.connected} onClick={() => { setOpen(false); setNotice('设计演示：执行位置已预填，未发送消息。') }}>新建会话</button></div><div className="host-remove"><span>只移除本机连接，不撤销远端授权。</span><button className="btn subtle danger" onClick={() => setSheet('remove')}>移除主机</button></div></div>}
            </li>)}</ul>}
          </section>
          <div className="section-rule" />
          <section className="section"><div className="section-title"><h3>允许其他设备访问本机</h3></div>
            <div className="access-grid">
              <article className="access-card"><div className="access-head"><span className="access-icon"><Icon name="server" /></span><span className="access-copy"><b>Scry 桌面</b><span>通过 SSH 访问</span></span><span className={`status-pill ${ssh ? '' : 'off'}`}>{ssh ? '已启用' : '未启用'}</span></div><p>生成新邀请会使旧的未完成邀请失效。</p><div className="access-actions"><button className="btn" onClick={() => { setSsh(true); setSheet('invite') }}>{ssh ? '生成 SSH 邀请' : '启用并生成邀请'}</button>{ssh && <button className="btn subtle" onClick={() => { setSsh(false); setNotice('设计演示：SSH 入站已关闭，出站主机连接不受影响。') }}>关闭</button>}</div></article>
              <article className="access-card"><div className="access-head"><span className="access-icon"><Icon name="laptop" /></span><span className="access-copy"><b>手机</b><span>通过加密中继访问</span></span><span className={`status-pill ${mobileUnavailable ? 'off' : relayDormant ? 'dormant' : ''}`}>{mobileUnavailable ? '未启用' : relayDormant ? '中继休眠' : '中继在线'}</span></div><p>{mobileUnavailable ? '手机中继未启用，桌面 SSH 仍可单独使用。' : relayDormant ? '尚未连接中继，手机暂时无法接入。' : '扫描配对码，然后在这台 Mac 核对指纹。'}</p><button className="btn" disabled={mobileUnavailable} onClick={() => setSheet('pair')}>生成配对码</button></article>
            </div>
            {pending && <div className="pending-device"><header><span className="state warn"><i />等待确认</span><b>新的 iPhone</b></header><p>请先核对手机上显示的公钥指纹。</p><code>{fingerprint}</code><div><button className="btn primary" onClick={() => { setPending(false); setAuthorized(true); setNotice('设计演示：设备已授权。真实授权需宿主确认。') }}>指纹一致，确认</button><button className="btn" onClick={() => setPending(false)}>取消配对</button></div></div>}
            <div className="authorized-section"><div className="section-title"><h4>已授权访问本机</h4></div>{authorized ? <div className="device"><span className="access-icon"><Icon name="laptop" /></span><b>Bing 的 iPhone</b><span>已授权</span><button onClick={() => setSheet('revoke')}>吊销授权</button></div> : <p className="muted">暂无已授权设备。</p>}</div>
          </section>
        </div>
      </>}
      </main></div>
    </section>}
    {sheet && <div className="sheet-backdrop" onClick={() => setSheet(null)}><section className="preview-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setSheet(null) }}><header><h2 id="sheet-title">{sheet === 'add' ? '添加主机' : sheet === 'edit' ? '编辑连接地址' : sheet === 'pair' ? '配对手机' : sheet === 'invite' ? 'SSH 邀请' : sheet === 'remove' ? '移除主机' : '吊销设备授权'}</h2><button aria-label="关闭弹窗" onClick={() => setSheet(null)}><Icon name="x" /></button></header>
      {sheet === 'add' || sheet === 'edit' ? <form onSubmit={submitForm}><p className="muted">{sheet === 'add' ? '粘贴远端 Scry 生成的邀请。真实配对需在远端确认。' : '保留配对和指纹。保存后断开连接，需手动重连；不停止远端任务。'}</p><label>显示名称<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如 mac2" /></label><label>主机名 / IP<input required value={hostname} onChange={event => setHostname(event.target.value)} placeholder="192.168.1.21" /></label><div className="form-grid"><label>SSH 用户名<input required value={user} onChange={event => setUser(event.target.value)} /></label><label>端口<input required type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} /></label></div>{sheet === 'add' && <label>邀请字符串<textarea required rows={3} value={invitation} onChange={event => setInvitation(event.target.value)} placeholder="粘贴完整 SSH 邀请" /></label>}<footer><button type="button" className="btn" onClick={() => setSheet(null)}>取消</button><button type="submit" className="btn primary">{sheet === 'add' ? '开始配对（演示）' : '保存地址'}</button></footer></form> : sheet === 'pair' ? <div><p className="muted">{relayDormant ? '尚未连接中继，手机暂时无法接入。' : '用 Scry 手机 App 扫码。配对码约 2 分钟内有效。'}</p><div className="qr-schematic"><Icon name="grid" /><b>{relayDormant ? '一次性口令区域' : '二维码显示区域'}</b><span>仅布局示意 · 不可用于真实配对</span></div><p className="muted">主机指纹</p><code className="full-fingerprint">{fingerprint}</code><details><summary>无法扫描？查看文本码</summary><p className="muted">设计示意：实际显示宿主返回的完整文本码。</p></details><footer><button className="btn" onClick={() => setSheet(null)}>关闭</button><button className="btn primary" onClick={() => { setPending(true); setSheet(null) }}>演示扫码后的待确认状态</button></footer></div> : sheet === 'invite' ? <div><p className="muted">邀请包含短时 secret，仅交给预期的 Scry 桌面客户端。</p><div className="invite-schematic">完整邀请字符串显示区域<br /><span>设计示意，不含可用凭据</span></div><footer><button className="btn" onClick={() => setSheet(null)}>关闭</button><button className="btn primary" onClick={() => setNotice('设计演示：真实实现复制完整宿主邀请。此稿不写入剪贴板。') }><Icon name="copy" />复制邀请（演示）</button></footer></div> : <div><p className="muted">{sheet === 'remove' ? '只删除本机保存的连接，不撤销该主机上的设备授权。' : '此设备将不能继续访问本机。重新使用需再次配对。'}</p><footer><button className="btn" onClick={() => setSheet(null)}>取消</button><button className="btn danger" onClick={() => { if (sheet === 'remove') setHosts(hosts.filter((_, index) => index !== expanded)); else setAuthorized(false); setSheet(null) }}>确认{sheet === 'remove' ? '移除' : '吊销'}</button></footer></div>}
    </section></div>}
  </div>
}
