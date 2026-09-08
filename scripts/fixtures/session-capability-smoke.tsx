import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PinnedSummary } from '../../src/renderer/components/PinnedSummary'
import { OverviewPanel } from '../../src/renderer/components/OverviewPanel'
import { qoderSkillSessionFixture } from '../../src/renderer/__fixtures__/session-capabilities'
import type { Turn } from '../../src/renderer/format'
import type { TraceEvent } from '../../src/shared/trace'

function Fixture() {
  const [turns, setTurns] = useState<Turn[]>([qoderSkillSessionFixture()])
  const [selection, setSelection] = useState('none')
  const [clicks, setClicks] = useState(0)
  const select = (event: TraceEvent) => {
    setClicks((value) => value + 1)
    setSelection(JSON.stringify({ id: event.id, kind: event.kind, tool: event.tool, source: (event.input as { source?: string } | undefined)?.source ?? null }))
  }
  return <>
    <button id="empty" onClick={() => setTurns([])}>新会话</button>
    <button id="pending" onClick={() => setTurns([qoderSkillSessionFixture('pending-run', 'pending')])}>读取中</button>
    <button id="success" onClick={() => setTurns([qoderSkillSessionFixture('pending-run', 'success')])}>收到成功结果</button>
    <button id="failed" onClick={() => setTurns([qoderSkillSessionFixture('failed-run', 'failed')])}>另一个失败会话</button>
    <button id="multi" onClick={() => setTurns([qoderSkillSessionFixture('run-1'), qoderSkillSessionFixture('run-2')])}>两轮历史</button>
    <output id="selection" data-clicks={clicks}>{selection}</output>
    <section id="pinned"><PinnedSummary cwd={null} gitDiff={[]} turns={turns} busy={false} temporary={false} onDismiss={() => undefined} onOpenCall={(_runId, event) => select(event)} onOpenAgents={() => undefined} /></section>
    <section id="overview"><OverviewPanel turns={turns} sessionId={turns[0]?.runId ?? null} busy={turns.some((turn) => !turn.done)} selected={null} onSelect={select} usage={null} stats={null} /></section>
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
