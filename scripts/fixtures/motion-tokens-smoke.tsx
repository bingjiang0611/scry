import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/analytics-evidence.css'
import '../../src/renderer/inventory-evidence.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/codex-alignment.css'
import { SidebarActivity } from '../../src/renderer/components/SidebarActivity'
import { AssistantTurn } from '../../src/renderer/components/ChatTurn'
import { OverviewPanel } from '../../src/renderer/components/OverviewPanel'
import type { ActivityEntry } from '../../src/renderer/sidebar-activity'
import type { ProjectMeta, SessionMeta } from '../../src/renderer/env'
import { qoderSkillSessionFixture } from '../../src/renderer/__fixtures__/session-capabilities'
import { ComposerProjectFixture } from './composer-project-smoke'

const project: ProjectMeta = { cwd: '/fixture/motion', name: 'motion', mtime: 1, sessions: [] }
const session: SessionMeta = {
  sessionId: 'motion-session', providerId: 'pi', preview: 'Motion fixture task', runId: 'motion-run', mtime: 1, count: 1
}

function Fixture() {
  const [group, setGroup] = useState<'working' | 'attention'>('working')
  const [selected, setSelected] = useState<string | null>(null)
  const turns = useMemo(() => [qoderSkillSessionFixture()], [])
  const entries: ActivityEntry[] = [
    { key: 'motion-session', kind: 'session', project, session, group },
    { key: 'motion-stationary', kind: 'session', project, session: { ...session, sessionId: 'motion-stationary' }, group: 'attention' }
  ]

  useEffect(() => {
    Object.assign(window, {
      motionFixture: {
        reorder: () => setGroup((current) => current === 'working' ? 'attention' : 'working')
      }
    })
  }, [])

  return <main id="motion-fixture">
    <section id="motion-sidebar" className="sidebar">
      <SidebarActivity entries={entries} renderEntry={(entry) => (
        <div className="sb-sess-row">
          <button type="button" className="sb-sess" data-provider="pi" onClick={() => setSelected(entry.key)}>
            <span className="sb-session-main"><span className="sb-sesstext">Motion fixture task</span></span>
          </button>
        </div>
      )} />
      <output id="motion-selection">{selected ?? 'none'}</output>
    </section>
    <section id="motion-tool" className="chat-body">
      <AssistantTurn turn={turns[0]} selectedId={null} onSelect={() => {}} />
    </section>
    <section id="motion-analysis">
      <OverviewPanel turns={turns} selected={null} usage={null} stats={null} onSelect={() => {}} />
    </section>
    <section id="motion-composer"><ComposerProjectFixture /></section>
    <div id="motion-instant" />
    <div id="motion-none" style={{ transition: 'none' }} />
    <button id="motion-micro" className="btn" type="button" />
  </main>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
