function ScryEvidencePrototype() {
  const [theme, setTheme] = React.useState(() => localStorage.getItem('scry-evidence-theme') || 'dark')
  const [active, setActive] = React.useState('welcome')
  const [modal, setModal] = React.useState(null)
  const [displayState, setDisplayState] = React.useState('ready')

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('scry-evidence-theme', theme)
  }, [theme])

  const selectSurface = (id) => {
    if (id === 'skills' || id === 'mcp') {
      setModal(id)
      return
    }
    setModal(null)
    setActive(id === 'overview' ? 'chat' : id)
  }

  return (
    <div className="prototype-root">
      <PrototypeBar active={modal || (active === 'chat' ? 'chat' : active)} theme={theme} displayState={displayState} onSurface={selectSurface} onTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} onState={setDisplayState} />
      <div className="prototype-stage">
        <ScryWindow active={active} modal={modal} displayState={displayState} onNavigate={selectSurface} onOpenModal={setModal} onCloseModal={() => setModal(null)} />
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<ScryEvidencePrototype />)
