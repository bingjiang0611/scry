function ScryAnalyticsPrototype() {
  const [theme, setTheme] = React.useState(() => localStorage.getItem('scry-analytics-prototype-theme') || 'dark')
  const [activeChapterId, setActiveChapterId] = React.useState('field')
  const [selectedDay, setSelectedDay] = React.useState('08-05')
  const [selectedProvider, setSelectedProvider] = React.useState('claude')
  const [methodOpen, setMethodOpen] = React.useState(false)

  const activeChapter = scryAnalyticsSample.chapters.find((chapter) => chapter.id === activeChapterId) || scryAnalyticsSample.chapters[0]

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('scry-analytics-prototype-theme', theme)
  }, [theme])

  React.useEffect(() => {
    const root = document.getElementById('analytics-scroll')
    if (!root) return undefined
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (visible?.target?.id) setActiveChapterId(visible.target.id)
    }, { root, threshold: [0.3, 0.55, 0.75] })
    scryAnalyticsSample.chapters.forEach((chapter) => {
      const element = document.getElementById(chapter.id)
      if (element) observer.observe(element)
    })
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (!methodOpen) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setMethodOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [methodOpen])

  const goToChapter = (id) => {
    setActiveChapterId(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'auto', block: 'start' })
  }

  return (
    <div className="prototype-root">
      <PrototypeControls
        theme={theme}
        methodOpen={methodOpen}
        selectedProvider={selectedProvider}
        onTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
        onMethod={() => setMethodOpen((current) => !current)}
        onClearProvider={() => setSelectedProvider(null)}
      />
      <section className="prototype-stage">
        <div className="scry-window" data-screen-label="Scry Analytics Narrative">
          <WindowTitlebar />
          <div className="scry-body">
            <ScrySidebar />
            <AnalyticsContent
              activeChapter={activeChapter}
              selectedDay={selectedDay}
              selectedProvider={selectedProvider}
              onChapter={goToChapter}
              onDay={setSelectedDay}
              onProvider={setSelectedProvider}
              onClearProvider={() => setSelectedProvider(null)}
            />
          </div>
        </div>
      </section>
      {methodOpen && <MethodPanel onClose={() => setMethodOpen(false)} />}
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<ScryAnalyticsPrototype />)
