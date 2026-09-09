import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/styles.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/inventory-evidence.css'
import '../../src/renderer/analytics-evidence.css'
import '../../src/renderer/codex-alignment.css'
import { PinnedSummaryHost, usePinnedSummaryVisibility } from '../../src/renderer/components/PinnedSummary'
import { OverviewPanel } from '../../src/renderer/components/OverviewPanel'
import { AssistantTurn } from '../../src/renderer/components/ChatTurn'
import { ModelEffortPicker } from '../../src/renderer/components/Pickers'
import { ViewChrome } from '../../src/renderer/components/ViewChrome'
import { qoderSkillSessionFixture } from '../../src/renderer/__fixtures__/session-capabilities'
import type { Turn } from '../../src/renderer/format'
import type { TraceEvent } from '../../src/shared/trace'
import { SidebarArchiveFixture } from './sidebar-archive-smoke'

const thinkingTurn: Turn = {
  runId: 'thinking-run',
  userText: '这个接口有 mock 能力吗',
  done: true,
  items: [
    {
      id: 'thinking-event',
      runId: 'thinking-run',
      ts: '2026-09-08T00:00:00.000Z',
      kind: 'model',
      stage: 'thinking',
      thinking: "I need to find out about the code's mock capability."
    },
    {
      id: 'answer-event',
      runId: 'thinking-run',
      ts: '2026-09-08T00:00:01.000Z',
      kind: 'model',
      stage: 'text',
      text: '我查一下调用链和配置。'
    }
  ]
}

function Fixture() {
  const [turns, setTurns] = useState<Turn[]>([qoderSkillSessionFixture()])
  const [selection, setSelection] = useState('none')
  const [clicks, setClicks] = useState(0)
  const [panelVisible, setPanelVisible] = useState(false)
  const [model, setModel] = useState('ultimate')
  const [effort, setEffort] = useState('default')
  const pinnedSummary = usePinnedSummaryVisibility(true, panelVisible)
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
    <section id="chrome">
      <ViewChrome
        cwd={null}
        agent={undefined}
        showSummary={pinnedSummary.visible}
        showPanel={panelVisible}
        onToggleSummary={pinnedSummary.toggle}
        onTogglePanel={() => setPanelVisible((current) => !current)}
      />
    </section>
    <output id="selection" data-clicks={clicks}>{selection}</output>
    <section id="pinned">
      <PinnedSummaryHost
        visible={pinnedSummary.visible}
        cwd={null}
        gitDiff={[]}
        turns={turns}
        busy={false}
        temporary={!pinnedSummary.persistent}
        onDismiss={pinnedSummary.dismiss}
        onOpenCall={(_runId, event) => select(event)}
        onOpenAgents={() => undefined}
      />
    </section>
    <section id="thinking"><AssistantTurn turn={thinkingTurn} selectedId={null} onSelect={() => undefined} /></section>
    <section id="model-effort" className="runtime-composer">
      <div className="composer-action-controls">
        <ModelEffortPicker
          modelValue={model}
          modelOptions={[
            { value: '', label: '自动模型' },
            { value: 'ultimate', label: 'Ultimate' },
            { value: 'performance', label: 'Performance' }
          ]}
          effortValue={effort}
          effortOptions={[
            { value: 'default', label: '默认' },
            { value: 'xhigh', label: '极高' },
            { value: 'high', label: '高' },
            { value: 'low', label: '低' },
            { value: 'max', label: '最大' },
            { value: 'medium', label: '中' }
          ]}
          onModelChange={(value) => {
            setModel(value)
            setEffort('default')
          }}
          onEffortChange={setEffort}
        />
      </div>
    </section>
    <SidebarArchiveFixture />
    <section id="overview"><OverviewPanel turns={turns} sessionId={turns[0]?.runId ?? null} busy={turns.some((turn) => !turn.done)} selected={null} onSelect={select} usage={null} stats={null} /></section>
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
