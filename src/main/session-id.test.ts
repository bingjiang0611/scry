import { describe, expect, it } from 'vitest'
import { archiveSessionId, scrySessionId } from './session-id'

describe('scrySessionId', () => {
  it('is stable and isolates provider, cwd and external id', () => {
    const first = scrySessionId('codex', '/repo', 'session-1')
    expect(scrySessionId('codex', '/repo', 'session-1')).toBe(first)
    expect(scrySessionId('qoder', '/repo', 'session-1')).not.toBe(first)
    expect(scrySessionId('codex', '/other', 'session-1')).not.toBe(first)
  })
})

describe('archiveSessionId', () => {
  it('never substitutes the local run id for a managed Provider session', () => {
    expect(archiveSessionId(true, undefined, 'run-local')).toBeUndefined()
    expect(archiveSessionId(true, 'provider-session', 'run-local')).toBe('provider-session')
    expect(archiveSessionId(false, undefined, 'run-local')).toBe('run-local')
  })
})
