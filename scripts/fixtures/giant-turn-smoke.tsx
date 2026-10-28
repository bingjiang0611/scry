import { createRoot } from 'react-dom/client'
import type { TraceEvent } from '@shared/trace'
import type { Turn } from '../../src/renderer/format'
import { AssistantTurn } from '../../src/renderer/components/ChatTurnAssistant'
import '../../src/renderer/styles.css'

const items: TraceEvent[] = Array.from({ length: 101 }, (_, index) => ({
  id: `text-${index}`,
  runId: 'giant-turn-smoke',
  ts: '2026-01-01T00:00:00.000Z',
  kind: 'model',
  stage: 'text',
  text: index === 0 ? 'earliest giant turn evidence' : index === 100 ? 'latest giant turn evidence' : `middle ${index}`
}))
const turn: Turn = { runId: 'giant-turn-smoke', userText: 'giant turn smoke', done: true, items }

createRoot(document.getElementById('root')!).render(
  <main className="chat-body">
    <AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} />
  </main>
)
