import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import type { Turn } from '../format'
import { TURN_FLOW_COPY } from '../constants/copy'
import { AssistantTurn } from './ChatTurnAssistant'

const items: TraceEvent[] = Array.from({ length: 101 }, (_, index) => ({
  id: `text-${index}`,
  runId: 'large-turn',
  ts: '2026-01-01T00:00:00.000Z',
  kind: 'model',
  stage: 'text',
  text: index === 0 ? 'earliest archived evidence' : index === 100 ? 'latest archived evidence' : `middle ${index}`
}))
const turn: Turn = { runId: 'large-turn', userText: 'large turn', done: true, items }
const render = (value: Turn, selectedId: string | null = null) => renderToStaticMarkup(
  <AssistantTurn turn={value} selectedId={selectedId} onSelect={() => {}} />
)

describe('large completed turn flow window', () => {
  it('renders the recent evidence first with an explicit earlier-activity control', () => {
    const html = render(turn)
    expect(html).toContain(TURN_FLOW_COPY.showEarlier(85))
    expect(html).not.toContain('earliest archived evidence')
    expect(html).toContain('latest archived evidence')
  })

  it('reveals the full flow when an earlier event is selected', () => {
    const html = render(turn, 'text-0')
    expect(html).toContain('earliest archived evidence')
    expect(html).not.toContain(TURN_FLOW_COPY.showEarlier(85))
  })

  it('never windows an active turn', () => {
    const html = render({ ...turn, done: false })
    expect(html).toContain('earliest archived evidence')
    expect(html).not.toContain(TURN_FLOW_COPY.showEarlier(85))
  })

  it('bounds a large completed model response behind an explicit reveal control', () => {
    const text = `${'visible '.repeat(1_000)}HIDDEN_TAIL${' hidden'.repeat(4_000)}`
    const html = render({
      runId: 'large-text',
      userText: 'large text',
      done: true,
      items: [{ id: 'large-text-event', runId: 'large-text', ts: '2026-01-01T00:00:00.000Z', kind: 'model', stage: 'text', text }]
    })
    expect(html).toContain('visible')
    expect(html).not.toContain('HIDDEN_TAIL')
    expect(html).toContain('显示完整回复')
  })
})
