import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from '../../src/renderer/components/Sidebar'
import { MetaPromptsView } from '../../src/renderer/components/MetaPromptsView'
import { ModalCloseButton } from '../../src/renderer/components/primitives/ModalCloseButton'
import { MODAL_COPY } from '../../src/renderer/constants/copy'
import { appendMetaPrompt } from '../../src/renderer/meta-prompts'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/codex-alignment.css'

const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window)
const heldFrames: FrameRequestCallback[] = []
let holdModalFrame = false
window.requestAnimationFrame = (callback) => {
  if (holdModalFrame) {
    heldFrames.push(callback)
    return heldFrames.length
  }
  return nativeRequestAnimationFrame(callback)
}
Object.assign(window, {
  __holdModalFrame: () => { holdModalFrame = true },
  __releaseModalFrame: () => new Promise<void>((resolve) => {
    holdModalFrame = false
    const callbacks = heldFrames.splice(0)
    nativeRequestAnimationFrame((timestamp) => {
      for (const callback of callbacks) callback(timestamp)
      resolve()
    })
  })
})

function CloseButtons() {
  const [closed, setClosed] = useState(0)
  const [submitted, setSubmitted] = useState(0)
  const close = () => setClosed(count => count + 1)
  return <form className="modal" id="close-buttons" data-closed={closed} data-submitted={submitted} onSubmit={event => { event.preventDefault(); setSubmitted(count => count + 1) }}>
    <div className="modal-head">
      <ModalCloseButton id="close-enabled" ref={node => { node?.focus() }} className="capabilities-close" aria-label={MODAL_COPY.close} onClick={close} />
      <ModalCloseButton id="close-disabled" disabled aria-label={MODAL_COPY.closeSettings} onClick={close} />
      <ModalCloseButton id="close-glyph" aria-label={MODAL_COPY.closeRename} onClick={close}>×</ModalCloseButton>
    </div>
  </form>
}

function Fixture() {
  const [view, setView] = useState<'chat' | 'prompts' | 'close-buttons'>('prompts')
  Object.assign(window, { __showModalCloseButtons: () => setView('close-buttons') })
  const [draft, setDraft] = useState('原有任务，不要覆盖')
  const [sends, setSends] = useState(0)
  return <div className="app" id="meta-fixture" data-sends={sends}>
    <Sidebar projects={[]} activeCwd={null} onNewChat={() => setView('chat')} onPick={() => {}} onTogglePin={() => {}} onArchive={() => {}} onAnalytics={() => {}} onLlmPerformance={() => {}} onSkills={() => {}} onMcp={() => {}} onMetaPrompts={() => setView('prompts')} metaPromptsActive={view === 'prompts'} />
    <div />
    <div className="main-area">
      {view === 'close-buttons' ? <CloseButtons /> : view === 'prompts' ? <><div className="aux-view-topbar" /><MetaPromptsView onBack={() => setView('chat')} onInsert={body => { setDraft(current => appendMetaPrompt(current, body)); setView('chat') }} /></> : <div className="fixture-chat"><label>当前草稿<textarea aria-label="当前草稿" value={draft} onChange={event => setDraft(event.target.value)} /></label><button onClick={() => setSends(current => current + 1)}>发送</button></div>}
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
