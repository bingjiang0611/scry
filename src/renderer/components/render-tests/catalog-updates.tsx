import * as shared from './shared'
const { describe, it, expect, shouldReloadProjectsForDataUpdate } = shared

describe('catalog data update policy', () => {
  it('reloads projects after session deletion or logical metadata changes', () => {
    expect(shouldReloadProjectsForDataUpdate({ kind: 'session_deleted' })).toBe(true)
    expect(shouldReloadProjectsForDataUpdate({ kind: 'conversation_changed' })).toBe(true)
    expect(shouldReloadProjectsForDataUpdate({ kind: 'catalog_recovered' })).toBe(true)
    expect(shouldReloadProjectsForDataUpdate({ kind: 'turn_recorded' })).toBe(false)
    expect(shouldReloadProjectsForDataUpdate({})).toBe(false)
  })
})