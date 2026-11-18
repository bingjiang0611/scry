import { describe, expect, it } from 'vitest'
import { shouldReloadProjectsForDataUpdate } from './app-model'

describe('project list refresh on data notices', () => {
  it('reloads for changes that can move a project, and after lost notices', () => {
    for (const kind of ['session_deleted', 'conversation_changed', 'catalog_recovered', 'resynchronize']) {
      expect(shouldReloadProjectsForDataUpdate({ kind })).toBe(true)
    }
    // A recorded turn refreshes its own view, not every project.
    expect(shouldReloadProjectsForDataUpdate({ kind: 'turn_recorded' })).toBe(false)
  })
})
