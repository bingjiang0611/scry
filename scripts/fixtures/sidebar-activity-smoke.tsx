import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from '../../src/renderer/components/Sidebar'
import type { SessionMeta } from '../../src/renderer/env'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

function Fixture() {
  const [phase, setPhase] = useState<'working' | 'attention' | 'recent'>('working')
  const [active, setActive] = useState<string | null>(null)
  const [archived, setArchived] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [bulk, setBulk] = useState(false)
  const [mounted, setMounted] = useState(true)
  const now = Date.now()
  const source: SessionMeta[] = [
    { sessionId: 'layout', providerId: 'claude', preview: '修复商品列表布局', runId: 'run-layout', mtime: now, count: 1 },
    { sessionId: 'webhook', providerId: 'pi', preview: 'Retry failed webhook delivery', runId: 'run-webhook', mtime: now - 60_000, count: 2, pinnedAt: pinned ? 1 : undefined },
    { sessionId: 'tokens', providerId: 'codex', preview: '添加深色模式颜色变量', mtime: now - 300_000, count: 3 }
  ]
  const sessions = source.filter((session) => !archived || session.sessionId !== 'webhook')
  if (bulk) sessions.push(...Array.from({ length: 70 }, (_, index): SessionMeta => ({
    sessionId: `history-${index}`, providerId: 'pi', preview: `历史记录 ${index}`, mtime: 0, count: 1
  })))
  useEffect(() => {
    Object.assign(window, { activityFixture: { setPhase, setBulk, unmount: () => setMounted(false) } })
  }, [])
  return <div className="app" style={{ gridTemplateColumns: '280px 1px 1fr' }}>
    {mounted && <Sidebar id="activity-sidebar" projects={[{ cwd: '/fixture/storefront', name: 'storefront', mtime: 3, sessions }]}
      activeCwd="/fixture/storefront" activeSessionId={active} activeProviderId={active === 'webhook' ? 'pi' : 'claude'}
      runningRunIds={new Set(['run-layout', ...(phase !== 'recent' ? ['run-webhook'] : [])])}
      waitingQuestionRunIds={new Set(phase === 'attention' ? ['run-webhook'] : [])}
      onNewChat={() => setActive(null)} onPick={(_cwd, id) => setActive(id)}
      onTogglePin={() => setPinned((value) => !value)} onArchive={() => setArchived(true)} />}
    <div /><main style={{ padding: 40 }}><h1>会话动态</h1><p>隔离交互夹具 · 无真实 Provider</p>
      <output id="activity-selection">{active ?? 'none'}</output>
      <output id="activity-pinned">{String(pinned)}</output>
    </main>
  </div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
