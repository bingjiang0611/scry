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

  it('windows the first 40-turn history page but retains every jump target', () => {
    const html = renderToStaticMarkup(<ChatTranscriptTurns turns={turns(40)} selectedId={null} onSelect={noop} />)
    expect(countMatches(html, /data-run-id="turn-/g)).toBe(40)
    expect(countMatches(html, /data-virtualized="true"/g)).toBe(36)
    expect(countMatches(html, /class="turn-user"/g)).toBe(4)
    expect(html).toContain('第 1 / 40 轮：Question 0')
  })

  it('keeps active, focused, selected and pending-question turns mounted outside the initial tail', () => {
    const history = turns(40)
    history[0] = { ...history[0], done: false }
    const html = renderToStaticMarkup(<ChatTranscriptTurns turns={history} selectedId="event-1"
      focusedTurnRunId="turn-2" onSelect={noop}
      pendingQuestions={[{ runId: 'turn-3', questionId: 'question', questions: [] }]} />)
    expect(countMatches(html, /data-run-id="turn-/g)).toBe(40)
    expect(countMatches(html, /data-virtualized="true"/g)).toBe(32)
    expect(countMatches(html, /class="turn-user"/g)).toBe(8)
  })
})
