import { describe, expect, it } from 'vitest'
import { scrySessionId } from './session-id'

describe('scrySessionId', () => {
  it('is stable and isolates provider, cwd and external id', () => {
    const first = scrySessionId('codex', '/repo', 'session-1')
    expect(scrySessionId('codex', '/repo', 'session-1')).toBe(first)
    expect(scrySessionId('qoder', '/repo', 'session-1')).not.toBe(first)
    expect(scrySessionId('codex', '/other', 'session-1')).not.toBe(first)
  })
})
