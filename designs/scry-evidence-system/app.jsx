function ScryEvidencePrototype() {
  const [theme, setTheme] = React.useState(() => localStorage.getItem('scry-evidence-theme') || 'dark')
  const [active, setActive] = React.useState(() => localStorage.getItem('scry-evidence-surface') || 'chat')
  const [modal, setModal] = React.useState(null)
  const [displayState, setDisplayState] = React.useState('ready')
  const [dataState, setDataState] = React.useState('loading')
  const [sessionOptions, setSessionOptions] = React.useState([])
  const [selectedSessionId, setSelectedSessionId] = React.useState('')
  const [dataEpoch, setDataEpoch] = React.useState(0)
  const requestSequence = React.useRef(0)
  const hasLiveSnapshot = React.useRef(false)

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('scry-evidence-theme', theme)
  }, [theme])

  React.useEffect(() => {
    localStorage.setItem('scry-evidence-surface', active)
  }, [active])

  const loadLiveData = React.useCallback(async (sessionId = '') => {
    const sequence = ++requestSequence.current
    setDataState('loading')
    try {
      const response = await fetch(`/api/snapshot${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (sequence !== requestSequence.current) return
      Object.assign(window.sampleData, payload)
      setSessionOptions(payload.sessionOptions || [])
      setSelectedSessionId(payload.meta?.selectedSessionId || '')
      hasLiveSnapshot.current = true
      setDataState('ready')
      setDataEpoch((value) => value + 1)
    } catch (error) {
      if (sequence !== requestSequence.current) return
      console.error('[scry-evidence] live data unavailable', error)
      setDataState(hasLiveSnapshot.current ? 'stale' : 'error')
    }
  }, [])

  React.useEffect(() => { loadLiveData() }, [loadLiveData])

  const selectSurface = (id) => {
    if (id === 'skills' || id === 'mcp') {
      setModal(id)
      return
    }
    setModal(null)
    setActive(id === 'overview' ? 'chat' : id)
  }

  return (
    <div className="prototype-root" data-live-epoch={dataEpoch}>
      <PrototypeBar active={modal || (active === 'chat' ? 'chat' : active)} theme={theme} displayState={displayState} dataState={dataState} sessionOptions={sessionOptions} selectedSessionId={selectedSessionId} onSession={loadLiveData} onRefresh={() => loadLiveData(selectedSessionId)} onSurface={selectSurface} onTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} onState={setDisplayState} />
      <div className="prototype-stage">
        <ScryWindow active={active} modal={modal} displayState={displayState} dataEpoch={dataEpoch} onNavigate={selectSurface} onOpenModal={setModal} onCloseModal={() => setModal(null)} onSession={loadLiveData} />
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<ScryEvidencePrototype />)
