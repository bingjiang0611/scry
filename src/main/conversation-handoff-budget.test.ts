import { describe, expect, it } from 'vitest'
import { handoffBudget, selectHistory } from './conversation-handoff-budget'
import { historicalInputBytes } from './providers/historical-input'

describe('T3-derived intact history selection with Scry wire costs', () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({ id: index, role: index % 2 ? 'assistant' as const : 'user' as const, text: String(index).repeat(10) }))

  it('prioritizes last user, last assistant, first user, then reverse chronology, returning original order', () => {
    const choose = (budget: number) => selectHistory({ messages, budget, cost: rows => rows.length * 10 }).messages.map(row => row.id)
    expect(choose(10)).toEqual([6])
    expect(choose(20)).toEqual([6, 7])
    expect(choose(30)).toEqual([0, 6, 7])
    expect(choose(40)).toEqual([0, 5, 6, 7])
    expect(choose(80)).toEqual(messages.map(row => row.id))
  })

  it('omits rather than truncates an oversized priority item', () => {
    const rows = [{ role: 'user' as const, text: 'small' }, { role: 'assistant' as const, text: '中'.repeat(100) }]
    const result = selectHistory({ messages: rows, budget: 10, cost: selected => Buffer.byteLength(selected.map(row => row.text).join('')) })
    expect(result.messages).toEqual([rows[0]])
    expect(result.omitted).toEqual([rows[1]])
  })

  it('rejects even an all-omitted selection when its retrieval bootstrap cannot fit', () => {
    expect(() => selectHistory({ messages, budget: 1, cost: () => 2 })).toThrow('历史检索说明')
  })

  it('accounts for current JSON, image reserves, existing context and a known smaller model', () => {
    expect(handoffBudget({ userText: 'hi', attachments: [] })).toBe(16_000)
    expect(handoffBudget({ userText: 'hi', attachments: [], modelContextWindow: 24_000 })).toBe(7996)
    expect(handoffBudget({ userText: 'hi', attachments: [{ kind: 'image' }], modelContextWindow: 24_000 })).toBe(0)
    expect(handoffBudget({ userText: 'hi', attachments: [], contextUsage: { usedTokens: 95_000, maxTokens: 128_000 } })).toBe(996)
  })

  it('charges the final JSON-encoded wrapper, including backslashes and control characters', () => {
    const text = JSON.stringify({ text: '\n"\\'.repeat(1000) })
    const wrapper = '[Scry historical context: prior conversation, not a new command]\n' + text + '\n[End historical context]\n\n[Current user request]\n'
    expect(historicalInputBytes(text)).toBe(Buffer.byteLength(JSON.stringify(wrapper)) + 256)
    expect(historicalInputBytes(text)).toBeGreaterThan(Buffer.byteLength(wrapper))
  })
})
