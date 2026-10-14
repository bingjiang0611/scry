import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatTranscriptTurns } from './ChatView'
import type { Turn } from '../format'

const noop = () => {}
const turns = (count: number): Turn[] => Array.from({ length: count }, (_, index) => ({
  runId: `turn-${index}`, userText: `Question ${index}`, done: true,
  items: [{ id: `event-${index}`, runId: `turn-${index}`, ts: '', kind: 'model', stage: 'text', text: `Answer ${index}` }]
}))

const countMatches = (html: string, pattern: RegExp): number => [...html.matchAll(pattern)].length

describe('initial transcript window', () => {
  it('retains every short-history body without windowing', () => {
    const html = renderToStaticMarkup(<ChatTranscriptTurns turns={turns(20)} selectedId={null} onSelect={noop} />)
    expect(countMatches(html, /data-run-id="turn-/g)).toBe(20)
    expect(countMatches(html, /class="turn-user"/g)).toBe(20)
    expect(html).not.toContain('data-virtualized')
  })

  it.each(['text', 'text_delta'])('windows a text-heavy 20-turn history without dropping its jump targets (%s)', stage => {
    const history = turns(20).map(turn => ({
      ...turn, items: turn.items.map(event => ({ ...event, stage, text: '## Section\n\nA **completed** answer.\n\n'.repeat(60) }))
    }))
    const html = renderToStaticMarkup(<ChatTranscriptTurns turns={history} selectedId={null} onSelect={noop} />)
    expect(countMatches(html, /data-run-id="turn-/g)).toBe(20)
    expect(countMatches(html, /data-virtualized="true"/g)).toBe(16)
    expect(countMatches(html, /class="turn-user"/g)).toBe(4)
  })

  it('keeps short history mounted at the text budget and windows it only above that budget', () => {
    const history: Turn[] = turns(5).map(turn => ({ ...turn, items: [] }))
    const event = turns(1)[0].items[0]
    history[0] = { ...history[0], items: [{ ...event, text: 'x'.repeat(32 * 1024) }] }
    const atBudget = renderToStaticMarkup(<ChatTranscriptTurns turns={history} selectedId={null} onSelect={noop} />)
    expect(atBudget).not.toContain('data-virtualized')
    history[0] = { ...history[0], items: [{ ...event, text: 'x'.repeat(32 * 1024 + 1) }] }
    const aboveBudget = renderToStaticMarkup(<ChatTranscriptTurns turns={history} selectedId={null} onSelect={noop} />)
    expect(countMatches(aboveBudget, /data-virtualized="true"/g)).toBe(1)
  })

  it('retains all bodies for at most four heavy turns because the initial tail already fits them', () => {
    const history = turns(4).map(turn => ({ ...turn, items: turn.items.map(event => ({ ...event, text: 'x'.repeat(40_000) })) }))
    expect(renderToStaticMarkup(<ChatTranscriptTurns turns={history} selectedId={null} onSelect={noop} />)).not.toContain('data-virtualized')
  })

  it('windows the first 40-turn history page but retains every jump target', () => {
    const html = renderToStaticMarkup(<ChatTranscriptTurns turns={turns(40)} selectedId={null} onSelect={noop} />)
    expect(countMatches(html, /data-run-id="turn-/g)).toBe(40)
    expect(countMatches(html, /data-virtualized="true"/g)).toBe(36)
    expect(countMatches(html, /class="turn-user"/g)).toBe(4)
    expect(html).toContain('第 1 / 40 轮：Question 0')
  })

  it.each([20, 40])('keeps active, focused, selected and pending-question turns mounted outside the initial tail (%i turns)', count => {
    const history = turns(count).map(turn => ({
      ...turn, items: turn.items.map(event => ({ ...event, text: '**Answer** '.repeat(200) }))
    }))
    history[0] = { ...history[0], done: false }
    const html = renderToStaticMarkup(<ChatTranscriptTurns turns={history} selectedId="event-1"
      focusedTurnRunId="turn-2" onSelect={noop}
      pendingQuestions={[{ runId: 'turn-3', questionId: 'question', questions: [] }]} />)
    expect(countMatches(html, /data-run-id="turn-/g)).toBe(count)
    expect(countMatches(html, /data-virtualized="true"/g)).toBe(count - 8)
    expect(countMatches(html, /class="turn-user"/g)).toBe(8)
  })
})
