import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from '../../src/renderer/components/Sidebar'
import { MetaPromptsView } from '../../src/renderer/components/MetaPromptsView'
import { appendMetaPrompt } from '../../src/renderer/meta-prompts'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

function Fixture() {
  const [view, setView] = useState<'chat' | 'prompts'>('prompts')
  const [draft, setDraft] = useState('原有任务，不要覆盖')
  const [sends, setSends] = useState(0)
  return <div className="app" id="meta-fixture" data-sends={sends}>
    <Sidebar projects={[]} activeCwd={null} onNewChat={() => setView('chat')} onPick={() => {}} onTogglePin={() => {}} onArchive={() => {}} onAnalytics={() => {}} onLlmPerformance={() => {}} onSkills={() => {}} onMcp={() => {}} onMetaPrompts={() => setView('prompts')} metaPromptsActive={view === 'prompts'} />
    <div />
    <div className="main-area">
      {view === 'prompts' ? <><div className="aux-view-topbar" /><MetaPromptsView onBack={() => setView('chat')} onInsert={body => { setDraft(current => appendMetaPrompt(current, body)); setView('chat') }} /></> : <div className="fixture-chat"><label>当前草稿<textarea aria-label="当前草稿" value={draft} onChange={event => setDraft(event.target.value)} /></label><button onClick={() => setSends(current => current + 1)}>发送</button></div>}
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
