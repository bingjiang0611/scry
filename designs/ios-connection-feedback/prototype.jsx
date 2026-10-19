import '../scry-ios-remote/design-canvas-v5.jsx'
import { copy as c } from './constants/copy.js'

const { useState, useEffect, useRef } = React
const { DesignCanvas, DCSection, DCArtboard } = window
document.title = c.pageTitle

function Icon({ name, size = 22 }) {
  const paths = {
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
    folder: <path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3V8h18"/>,
    compose: <><path d="M20 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7M15 4l4 4M10 13l-1 4 4-1L22 7l-4-4z"/></>,
    down: <path d="m7 9 5 5 5-5"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.2"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    laptop: <><rect x="4" y="4" width="16" height="12" rx="2"/><path d="M2 20h20"/></>
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function IconButton({ icon, label, onClick, className = '' }) {
  return <button className={`icon-button ${className}`} aria-label={label} onClick={onClick}><Icon name={icon}/></button>
}

function Phone({ alternative = false, initialFailure = false, note }) {
  const [state, setState] = useState(initialFailure ? 'failure' : 'success')
  const [scenario, setScenario] = useState(initialFailure ? 'failure' : 'success')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(false)
  const [sheet, setSheet] = useState(null)
  const [technical, setTechnical] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(true)
  const [lastUpdated, setLastUpdated] = useState(initialFailure ? '03:16' : '03:21')
  const [pull, setPull] = useState(0)
  const start = useRef(null)
  const content = useRef(null)
  const refreshTimer = useRef(null)
  const toastTimer = useRef(null)
  const sheetRef = useRef(null)
  useEffect(() => () => { clearTimeout(refreshTimer.current); clearTimeout(toastTimer.current) }, [])

  useEffect(() => {
    if (!sheet) return
    const previous = document.activeElement
    sheetRef.current?.querySelector('button')?.focus()
    return () => previous?.focus()
  }, [sheet])

  function refresh() {
    if (busy) return
    setSheet(null)
    setToast(false)
    setBusy(true)
    clearTimeout(toastTimer.current)
    refreshTimer.current = setTimeout(() => {
      setBusy(false)
      const outcome = scenario === 'unverified' ? 'success' : scenario
      setState(outcome)
      if (outcome === 'success') {
        setLastUpdated('03:21')
        setToast(true)
        toastTimer.current = setTimeout(() => setToast(false), 2600)
      }
    }, 850)
  }

  function chooseScenario(value) {
    setScenario(value)
    if (value === 'unverified') {
      setState('unverified')
      setToast(false)
      setLastUpdated('03:16')
    }
  }

  const stale = state !== 'success'
  const rows = [c.pinOne, c.pinTwo, c.taskOne, c.taskTwo, c.taskThree]
  const visible = title => title.toLowerCase().includes(query.toLowerCase())
  const openTask = () => setSheet('preview')
  function trapFocus(e) {
    if (e.key === 'Escape') { setSheet(null); return }
    if (e.key !== 'Tab') return
    const nodes = [...sheetRef.current.querySelectorAll('button, summary, [href], input, select')].filter(n => n.getClientRects().length)
    const first = nodes[0], last = nodes[nodes.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  return <div className="specimen">
    <div className="phone">
      <div className="phone-content" inert={sheet ? '' : undefined}>
        <div className="statusbar"><strong>{c.time}</strong><div className="island"/><span className="signal"><i/><i/><i/><i/></span><b>{c.cellular}</b><span className="battery"/></div>
        <header className={`app-header ${alternative ? 'has-subtitle' : ''}`}>
          <IconButton icon="menu" label={c.menu} onClick={() => setSheet('menu')}/>
          <div className="header-title"><h2>{c.remote}</h2>{alternative && <span>{c.lastUpdated(lastUpdated)}</span>}</div>
          <IconButton icon="refresh" label={busy ? c.refreshing : c.refresh} className={busy ? 'rotating' : ''} onClick={refresh}/>
          <IconButton icon="more" label={c.more} onClick={() => setSheet('menu')}/>
        </header>
        <div className="notice-slot" aria-live="polite">
          {state === 'failure' && <div className="failure-notice"><Icon name="info" size={19}/><div className="failure-copy"><strong>{c.failed}</strong><span>{c.stale(lastUpdated)}</span></div><button className="text-button" disabled={busy} onClick={refresh}>{busy ? c.refreshing : c.retry}</button><button className="detail-hit" aria-label={c.details} onClick={() => setSheet('connection')}><Icon name="more" size={20}/></button></div>}
          {state === 'unverified' && <button className="unverified" onClick={refresh}><Icon name="refresh" size={14}/>{c.unverified}</button>}
        </div>
        <div className="list" ref={content}
          onTouchStart={e => { start.current = content.current.scrollTop === 0 ? e.touches[0].clientY : null }}
          onTouchMove={e => { if (start.current !== null) setPull(Math.min(72, Math.max(0, e.touches[0].clientY - start.current))) }}
          onTouchEnd={() => { if (pull > 52) refresh(); setPull(0); start.current = null }}>
          {(busy || pull > 16) && state !== 'failure' && <div className="refresh-progress" role="status"><Icon name="refresh" size={16}/><span>{busy ? c.refreshing : c.pull}</span></div>}
          {(!query || [c.pinOne, c.pinTwo].some(visible)) && <section>
            <button className="section-title disclosure" aria-expanded={expanded} aria-label={expanded ? c.collapse : c.expand} onClick={() => setExpanded(!expanded)}>{c.pinned}<span className={expanded ? '' : 'collapsed'}><Icon name="down" size={15}/></span></button>
            {expanded && [c.pinOne, c.pinTwo].filter(visible).map(title => <button key={title} className="session-row" onClick={openTask}>{title}</button>)}
          </section>}
          {(!query || [c.taskOne, c.taskTwo, c.taskThree].some(visible)) && <section className="projects"><h3 className="section-title">{c.projects}</h3>
            {(!query || [c.taskOne, c.taskTwo].some(visible)) && <><div className="project-row"><Icon name="folder" size={23}/><strong>{c.projectOne}</strong><IconButton icon="compose" label={c.compose(c.projectOne)} onClick={openTask}/></div>
            {[c.taskOne, c.taskTwo].filter(visible).map(title => <button key={title} className="session-row indented" onClick={openTask}><span>{title}</span>{title === c.taskTwo && <small className={stale ? 'stale-state' : ''}>{stale ? c.lastRunning : c.running}</small>}</button>)}</>}
            {(!query || visible(c.taskThree)) && <><div className="project-row second"><Icon name="folder" size={23}/><strong>{c.projectTwo}</strong><IconButton icon="compose" label={c.compose(c.projectTwo)} onClick={openTask}/></div><button className="session-row indented long" onClick={openTask}>{c.taskThree}</button></>}
          </section>}
          {query && !rows.some(visible) && <p className="empty">{c.noResults}</p>}
        </div>
        {toast && <div className="toast" role="status"><span className="success-icon"><Icon name="check" size={14}/></span>{c.refreshed}</div>}
        <div className="dock"><label className="search"><Icon name="search"/><input placeholder={c.search} aria-label={c.search} value={query} onChange={e => setQuery(e.target.value)}/></label><button className="new-task" aria-label={c.newTask} onClick={openTask}><Icon name="plus" size={28}/></button></div>
        <div className="home-indicator"/>
      </div>
      {sheet && <div className="scrim" onClick={() => setSheet(null)}>
        <div className="sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-label={sheet === 'connection' ? c.connectionTitle : c.menu} onKeyDown={trapFocus} onClick={e => e.stopPropagation()}>
          <div className="grabber"/>
          {sheet === 'menu' ? <><button className="menu-row" onClick={refresh}><Icon name="refresh"/>{c.menuRefresh}</button><button className="menu-row" onClick={() => setSheet('connection')}><Icon name="laptop"/>{c.menuConnection}<span>{c.paired}</span></button><button className="menu-row cancel" onClick={() => setSheet(null)}>{c.menuCancel}</button></> : <>
            <div className="sheet-heading"><h3>{sheet === 'preview' ? c.remote : c.connectionTitle}</h3><IconButton icon="close" label={c.dismiss} onClick={() => setSheet(null)}/></div>
            {sheet === 'preview' ? <p className="explanation">{c.taskPreview}</p> : <>
              <dl><div><dt>{c.hostLabel}</dt><dd>{c.hostName}</dd></div><div><dt>{c.pairingLabel}</dt><dd>{c.paired}</dd></div><div><dt>{c.refreshTimeLabel}</dt><dd>{lastUpdated}</dd></div><div><dt>{c.requestLabel}</dt><dd>{busy ? c.refreshing : state === 'failure' ? c.requestFailed : state === 'unverified' ? c.requestUnverified : c.requestSuccess}</dd></div></dl>
              <p className="explanation">{state === 'failure' ? c.failureExplanation : state === 'unverified' ? c.unverifiedExplanation : c.successExplanation}</p>
              {state === 'failure' && <div className="technical"><button className="technical-toggle" aria-expanded={technical} onClick={() => setTechnical(!technical)}>{c.technical}<Icon name="down" size={15}/></button>{technical && <><pre>{c.rawError}</pre><small>{c.source}</small></>}</div>}
              <button className="sheet-primary" disabled={busy} onClick={refresh}>{state === 'failure' ? c.retry : c.refresh}</button>
            </>}
          </>}
        </div>
      </div>}
    </div>
    <div className="demo-controls"><label><span>{c.scenario}</span><select aria-label={c.scenario} value={scenario} disabled={busy} onChange={e => chooseScenario(e.target.value)}><option value="success">{c.scenarioSuccess}</option><option value="failure">{c.scenarioFailure}</option><option value="unverified">{c.scenarioUnverified}</option></select></label><button disabled={busy} onClick={refresh}>{busy ? c.refreshing : c.trigger}</button></div>
    <p className="board-note">{note}</p>
  </div>
}

function App() {
  return <><div className="page-heading"><div><p className="eyebrow">{c.eyebrow}</p><h1>{c.pageTitle}</h1><p className="lead">{c.lead}</p></div><div className="prototype-badge"><span/>{c.prototypeNotice}</div></div>
    <main><DesignCanvas style={{ background: '#e9e8e3', height: '100%', width: '100%' }}><DCSection id="connection-directions" title={c.section} subtitle={c.sectionNote} gap={46}>
      <DCArtboard id="quiet" label={c.boardA} width={390} height={944}><Phone note={c.stableNote}/></DCArtboard>
      <DCArtboard id="failure" label={c.boardError} width={390} height={944}><Phone initialFailure note={c.failureNote}/></DCArtboard>
      <DCArtboard id="timestamp" label={c.boardB} width={390} height={944}><Phone alternative note={c.alternateNote}/></DCArtboard>
    </DCSection></DesignCanvas></main>
    <footer><strong>{c.rulesTitle}</strong><div className="rule-grid">{c.rules.map(([title, body]) => <p key={title}><b>{title}</b><span>{body}</span></p>)}</div><p className="boundary">{c.boundary}</p><small>{c.approval}</small></footer>
  </>
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>)
