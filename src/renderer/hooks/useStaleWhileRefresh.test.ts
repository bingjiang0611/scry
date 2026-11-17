import { describe, expect, it } from 'vitest'
import { staleReducer, staleStatus, type StaleSnapshot } from './useStaleWhileRefresh'

const empty = (key: string): StaleSnapshot<string[]> => ({ key, data: undefined, fetchedAt: undefined, error: null, inFlight: false })

describe('staleReducer', () => {
  it('loads a key with nothing known as loading, then ready', () => {
    let state = staleReducer(empty('a'), { type: 'start', key: 'a' })
    expect(staleStatus(state)).toBe('loading')
    state = staleReducer(state, { type: 'resolve', key: 'a', data: ['x'], at: 10 })
    expect(staleStatus(state)).toBe('ready')
    expect(state.fetchedAt).toBe(10)
  })

  it('keeps the previous answer while the same key refreshes', () => {
    let state = staleReducer(empty('a'), { type: 'resolve', key: 'a', data: ['x'], at: 10 })
    state = staleReducer(state, { type: 'start', key: 'a' })
    expect(staleStatus(state)).toBe('refreshing')
    expect(state.data).toEqual(['x'])
  })

  it('keeps the previous answer and reports a failed refresh next to it', () => {
    let state = staleReducer(empty('a'), { type: 'resolve', key: 'a', data: ['x'], at: 10 })
    state = staleReducer(staleReducer(state, { type: 'start', key: 'a' }), { type: 'reject', key: 'a', error: 'disk' })
    expect(staleStatus(state)).toBe('ready')
    expect(state.data).toEqual(['x'])
    expect(state.error).toBe('disk')
  })

  it('never shows one key’s answer as another key’s', () => {
    let state = staleReducer(empty('a'), { type: 'resolve', key: 'a', data: ['x'], at: 10 })
    state = staleReducer(state, { type: 'start', key: 'b' })
    expect(state.data).toBeUndefined()
    expect(staleStatus(state)).toBe('loading')
    // A late answer for the old key is dropped.
    state = staleReducer(state, { type: 'resolve', key: 'a', data: ['late'], at: 11 })
    expect(state.data).toBeUndefined()
  })

  it('reports an error only when there is nothing known to show', () => {
    const state = staleReducer(staleReducer(empty('a'), { type: 'start', key: 'a' }), { type: 'reject', key: 'a', error: 'disk' })
    expect(staleStatus(state)).toBe('error')
  })
})
