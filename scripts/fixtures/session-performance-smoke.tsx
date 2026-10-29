import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from '../../src/renderer/components/Sidebar'
import { ChatTranscriptTurns } from '../../src/renderer/components/ChatView'
import { useEventCallback } from '../../src/renderer/hooks/useEventCallback'
import { useChatNavigation } from '../../src/renderer/hooks/useChatNavigation'
import { observeChatBottomLayout, scrollChatToBottomIfNeeded } from '../../src/renderer/chat-scroll'
import type { Turn } from '../../src/renderer/format'
import type { ProjectMeta } from '../../src/renderer/env'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/codex-alignment.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/components/background-work.css'

// Count actual production Sidebar executions, not DOM mutations or SSR calls.
const measuredSidebar = Sidebar as typeof Sidebar & { type: (props: ComponentProps<typeof Sidebar>) => ReactNode }
const sidebarRender = measuredSidebar.type
measuredSidebar.type = (props) => {
  document.body.dataset.sidebarRenders = String(Number(document.body.dataset.sidebarRenders ?? 0) + 1)
  return sidebarRender(props)
}

const noop = () => {}
const asyncNoop = async () => {}
const projects: ProjectMeta[] = [{
  cwd: '/fixture', name: 'Performance fixture', mtime: 1, sessions: Array.from({ length: 277 }, (_, index) => ({
    sessionId: `session-${index}`, providerId: 'pi', agentProfileId: 'pi-fixture',
    runId: `run-${index}`, preview: `Question ${index}`, mtime: index + 1, count: 1
  }))
}]
const canvas = document.createElement('canvas')
canvas.width = 80
canvas.height = 40
canvas.getContext('2d')!.fillRect(0, 0, 80, 40)
const image = { kind: 'image' as const, name: 'fixture.png', mimeType: 'image/png' as const,
  dataBase64: canvas.toDataURL('image/png').split(',')[1] }
const turns: Turn[] = Array.from({ length: 120 }, (_, index) => ({
  runId: `turn-${index}`, userText: index === 69 ? 'long prompt '.repeat(160) : `History question ${index}`, done: true,
  attachments: index === 2 ? [image] : undefined,
  items: [{ id: `answer-${index}`, runId: `turn-${index}`, ts: '', kind: 'model', stage: 'text',
    text: `## Answer ${index}\n\n${'A genuine variable-height paragraph. '.repeat(15 + index % 10)}` },
  { id: `tool-${index}`, runId: `turn-${index}`, ts: '', kind: 'tool', stage: 'tool:Read',
    tool: 'Read', toolUseId: `call-${index}`, filePath: '/fixture/file.txt' }]
}))

const heavyTurns = turns.slice(-20).map(turn => ({
  ...turn,
  items: turn.items.map(event => event.kind === 'model'
    ? { ...event, text: `${event.text}\n\n${'A completed **Markdown** paragraph. '.repeat(180)}` }
    : event)
}))

function Fixture() {
  const [tick, setTick] = useState(0)
  const [historyLimit, setHistoryLimit] = useState(40)
  const [heavy, setHeavy] = useState(false)
  const [running, setRunning] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState('session-0')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(false)
  const navigation = useChatNavigation(scrollRef, true, heavy ? heavyTurns.length : historyLimit)
  const jump = (eventId?: string): void => {
    followLatest.current = false
    setSelectedId(eventId ?? 'answer-10')
    navigation.navigate('turn-10', eventId)
  }
  const onPick = useEventCallback((_cwd: string, sessionId: string) => {
    document.body.dataset.pickedTick = String(tick)
    setActiveSessionId(sessionId)
  })
  const runningRunIds = useMemo(() => new Set(running ? Array.from({ length: 8 }, (_, index) => `run-${index}`) : []), [running])
  useEffect(() => observeChatBottomLayout(scrollRef.current!, () => followLatest.current), [])
  return <>
    <header style={{ height: 50, display: 'flex', gap: 12 }}>
      <button id="stream" onClick={() => setTick(value => value + 1)}>Stream {tick}</button>
      <button id="load-older" onClick={() => setHistoryLimit(value => Math.min(120, value + 40))}>Load older</button>
      <button id="running" onClick={() => setRunning(value => !value)}>Running</button>
      <button id="jump" onClick={() => jump()}>Jump to prompt</button>
      <button id="jump-event" onClick={() => jump('tool-10')}>Jump to event</button>
      <button id="follow" onClick={() => { navigation.cancel(); followLatest.current = true; scrollChatToBottomIfNeeded(scrollRef.current, true) }}>Follow latest</button>
      <button id="clear-selection" onClick={() => { setSelectedId(null); navigation.cancel() }}>Clear selection</button>
      <button id="short-history" onClick={() => { setHeavy(false); setHistoryLimit(4) }}>Short 4</button>
      <button id="short-heavy" onClick={() => setHeavy(true)}>Heavy 20</button>
      <button id="reset-history" onClick={() => { setHeavy(false); setHistoryLimit(40) }}>Reset history</button>
    </header>
    <main style={{ display: 'flex', height: 600 }}>
      <div style={{ width: 260, flexShrink: 0, display: 'flex' }}>
        <Sidebar projects={projects} activeCwd="/fixture" activeProviderId="pi" activeAgentProfileId="pi-fixture"
          activeSessionId={activeSessionId} runningRunIds={runningRunIds}
          onNewChat={noop} onPick={onPick} onTogglePin={noop} onArchive={noop} onRenameSession={asyncNoop} />
      </div>
      <div className="body chat-body" style={{ height: 600, flex: 1, minWidth: 0 }}>
        <div ref={scrollRef} className="chat chat-transcript" style={{ height: 600, overflow: 'auto' }}>
          <ChatTranscriptTurns turns={heavy ? heavyTurns : turns.slice(-historyLimit)} selectedId={selectedId} focusedTurnRunId={navigation.focusedTurnRunId}
            onSelect={setSelectedId} pendingQuestions={[]} />
        </div>
      </div>
    </main>
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
