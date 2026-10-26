import { describe, expect, it } from 'vitest'
import {
  SESSION_SELECTION_STORAGE_KEY,
  parseStoredSessionSelection,
  persistSessionSelection,
  readStoredSessionSelection
} from './session-restore'

const storageOf = (initial: Record<string, string> = {}): Storage => {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  } as Storage
}

const selection = {
  cwd: '/workspace/app',
  sessionId: 'session-1',
  providerId: 'pi' as const,
  externalSessionId: 'provider-session-1',
  agentProfileId: 'pi:default'
}

describe('stored session selection', () => {
  it('round-trips the session the user was looking at', () => {
    const storage = storageOf()
    persistSessionSelection(selection, storage)
    expect(readStoredSessionSelection(storage)).toEqual(selection)
  })

  it('keeps the workspace-only state when the user was on a new conversation', () => {
    const storage = storageOf()
    persistSessionSelection({ cwd: '/workspace/app', sessionId: null, providerId: 'claude' }, storage)
    expect(readStoredSessionSelection(storage)).toEqual({ cwd: '/workspace/app', sessionId: null, providerId: 'claude', externalSessionId: undefined, agentProfileId: undefined })
  })

  it('clears the record instead of leaving a stale session behind', () => {
    const storage = storageOf({ [SESSION_SELECTION_STORAGE_KEY]: JSON.stringify(selection) })
    persistSessionSelection(null, storage)
    expect(storage.getItem(SESSION_SELECTION_STORAGE_KEY)).toBeNull()
    expect(readStoredSessionSelection(storage)).toBeNull()
  })

  it('refuses records it cannot re-open honestly', () => {
    expect(parseStoredSessionSelection(null)).toBeNull()
    expect(parseStoredSessionSelection('{')).toBeNull()
    expect(parseStoredSessionSelection('[]')).toBeNull()
    expect(parseStoredSessionSelection(JSON.stringify({ sessionId: 'a', providerId: 'pi' }))).toBeNull()
    expect(parseStoredSessionSelection(JSON.stringify({ cwd: '/w', providerId: 'nope' }))).toBeNull()
    // legacy_unknown 会话不可重新选择，不能成为恢复目标。
    expect(parseStoredSessionSelection(JSON.stringify({ cwd: '/w', providerId: 'legacy_unknown' }))).toBeNull()
  })

  it('survives storage read/write rejection', () => {
    expect(readStoredSessionSelection({ getItem: () => { throw new Error('denied') } })).toBeNull()
    expect(() => persistSessionSelection(selection, {
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') }
    })).not.toThrow()
  })
})
