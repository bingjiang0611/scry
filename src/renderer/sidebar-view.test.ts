import { describe, expect, it } from 'vitest'
import { SIDEBAR_VIEW_STORAGE_KEY, persistSidebarView, readStoredSidebarView } from './sidebar-view'

const storageOf = (initial: Record<string, string> = {}): Storage => {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value)
  } as Storage
}

describe('sidebar view persistence', () => {
  it('restores the tab the user left on instead of always defaulting to projects', () => {
    const storage = storageOf()
    persistSidebarView('activity', storage)
    expect(storage.getItem(SIDEBAR_VIEW_STORAGE_KEY)).toBe('activity')
    expect(readStoredSidebarView(storage)).toBe('activity')
  })

  it('defaults to projects for missing, unknown or unreadable storage', () => {
    expect(readStoredSidebarView(storageOf())).toBe('projects')
    expect(readStoredSidebarView(storageOf({ [SIDEBAR_VIEW_STORAGE_KEY]: 'nonsense' }))).toBe('projects')
    expect(readStoredSidebarView(undefined)).toBe('projects')
    expect(readStoredSidebarView({ getItem: () => { throw new Error('denied') } })).toBe('projects')
  })

  it('does not fail the tab switch when storage rejects the write', () => {
    expect(() => persistSidebarView('activity', { setItem: () => { throw new Error('denied') } })).not.toThrow()
  })
})
