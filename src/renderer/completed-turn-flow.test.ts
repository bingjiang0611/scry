import { describe, expect, it } from 'vitest'
import { completedModelText } from './completed-turn-flow'

describe('completedModelText', () => {
  it('bounds the initial markdown parse for a large completed response', () => {
    const text = 'x'.repeat(30_000)
    expect(completedModelText(text, { completed: true, expanded: false })).toEqual({
      text: 'x'.repeat(8_000),
      hiddenCharacters: 22_000
    })
  })

  it('does not split a surrogate pair at the preview boundary', () => {
    const text = `${'x'.repeat(7_999)}😀${'y'.repeat(24_000)}`
    const preview = completedModelText(text, { completed: true, expanded: false })
    expect(preview.text).toBe('x'.repeat(7_999))
    expect(preview.text.length + preview.hiddenCharacters).toBe(text.length)
  })

  it('keeps running, short, and explicitly expanded responses complete', () => {
    const text = 'x'.repeat(30_000)
    expect(completedModelText(text, { completed: false, expanded: false })).toEqual({ text, hiddenCharacters: 0 })
    expect(completedModelText('short', { completed: true, expanded: false })).toEqual({ text: 'short', hiddenCharacters: 0 })
    expect(completedModelText(text, { completed: true, expanded: true })).toEqual({ text, hiddenCharacters: 0 })
  })
})
