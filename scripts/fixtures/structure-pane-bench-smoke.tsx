import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ChatTranscriptTurns } from '../../src/renderer/components/ChatView'
import { OverviewPanel } from '../../src/renderer/components/OverviewPanel'
import type { Turn } from '../../src/renderer/format'
import { animatePaneChange } from '../../src/renderer/pane-motion'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/codex-alignment.css'
import './structure-pane-bench.css'

const noop = () => {}
const turns: Turn[] = Array.from({ length: 300 }, (_, index) => ({
  runId: `pane-bench-${index}`, userText: `History question ${index}`, done: true,
  items: [{ id: `answer-${index}`, runId: `pane-bench-${index}`, ts: '', kind: 'model', stage: 'text',
    text: `## Answer ${index}\n\n${'A genuine variable-height **Markdown** paragraph. '.repeat(15 + index % 10)}` }]
}))
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))

function Fixture() {
  const [mode, setMode] = useState<'V' | 'F'>('V')
  const [open, setOpen] = useState(true)
  const openRef = useRef(true)
  useEffect(() => {
    Object.assign(window, { paneExperiment: async (nextMode: 'V' | 'F') => {
      flushSync(() => { setMode(nextMode); setOpen(true); openRef.current = true })
      await document.fonts.ready
      await frame()
      await frame()
      const transcript = document.querySelector<HTMLElement>('.chat-transcript')!
      const visibleTranscript = { height: transcript.clientHeight, scrollHeight: transcript.scrollHeight }
      if (visibleTranscript.height < 300 || visibleTranscript.scrollHeight <= visibleTranscript.height) throw new Error('Benchmark requires a visible, scrollable long transcript')
      const samples = []
      for (let index = 0; index < 10; index++) {
        let previous = await frame()
        const intervals: number[] = []
        let raf = 0
        const tick = (now: number) => { intervals.push(now - previous); previous = now; raf = requestAnimationFrame(tick) }
        raf = requestAnimationFrame(tick)
        const target = !openRef.current
        const commit = () => { setOpen(target); openRef.current = target }
        try {
          if (nextMode === 'V') {
            document.documentElement.dataset.vt = 'pane'
            const transition = document.startViewTransition(() => flushSync(commit))
            try { await transition.finished }
            finally { delete document.documentElement.dataset.vt }
          } else {
            animatePaneChange(commit)
            await Promise.all(document.getAnimations().filter(animation => animation.id === 'scry-pane').map(animation => animation.finished))
          }
        } finally { cancelAnimationFrame(raf) }
        if (intervals.length < 10) throw new Error('Pane animation was not observed for enough frames')
        samples.push({ open: target, intervals, over25: intervals.filter(value => value > 25).length })
      }
      return { mode: nextMode, loadedTurns: turns.length, viewport: [innerWidth, innerHeight], visibleTranscript, samples }
    } })
  }, [])
  return <main className={`app app-shell right-panel-surface${open ? '' : ' right-panel-hidden'}`} style={{ gridTemplateColumns: `230px 4px minmax(0, 1fr) ${open ? '4px 360px' : '0px 0px'}`, height: '100vh', overflow: 'hidden' }}>
    <aside id="sidebar-pane" className="sidebar">Pane experiment</aside>
    <div className="sidebar-resizer" />
    <section id="main-pane" className="main-area has-main-content">
      <header>Pane benchmark</header>
      <div className="main-content" style={{ viewTransitionName: mode === 'V' ? 'page' : 'none' }}>
        <div className="body chat-body"><div className="chat chat-transcript" style={{ overflow: 'auto' }}>
          <ChatTranscriptTurns turns={turns} selectedId={null} onTurnRef={noop} onSelect={noop} pendingQuestions={[]} />
        </div></div>
      </div>
    </section>
    <div className="panel-resizer" />
    <aside id="right-surface-pane" className="right-panel-slot" style={{ overflow: 'hidden', minWidth: 0 }}>
      <OverviewPanel turns={turns} selected={null} usage={null} stats={null} onSelect={noop} />
    </aside>
  </main>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
