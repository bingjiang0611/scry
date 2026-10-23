import { afterEach, describe, expect, it, vi } from 'vitest'
import { animatePaneChange, cancelPaneMotion } from './pane-motion'

const flush = vi.hoisted(() => ({ active: false }))
vi.mock('react-dom', () => ({ flushSync: vi.fn((commit: () => void) => {
  flush.active = true
  try { commit() } finally { flush.active = false }
}) }))
afterEach(() => { cancelPaneMotion(); vi.unstubAllGlobals() })

describe('pane layout commit', () => {
  it.each(['no document', 'hidden', 'no animate'])('uses flushSync with %s without reading layout', mode => {
    const readLayout = vi.fn()
    vi.stubGlobal('Element', mode === 'no animate' ? class {} : class { animate() {} })
    vi.stubGlobal('document', mode === 'no document' ? undefined : { hidden: mode === 'hidden', querySelectorAll: readLayout })
    const commit = vi.fn(() => { expect(flush.active).toBe(true) })
    animatePaneChange(commit)
    expect(commit).toHaveBeenCalledOnce()
    expect(readLayout).not.toHaveBeenCalled()
  })
  it('uses flushSync for the real animated path and reads the final layout after commit', () => {
    let width = 0
    const animate = vi.fn(() => ({ id: '', cancel: vi.fn(), finished: new Promise<void>(() => {}) }))
    const pane = { id: 'right-surface-pane', inert: false, animate,
      getBoundingClientRect: () => ({ x: 800, left: 800, top: 0, width, height: 800 }) }
    vi.stubGlobal('Element', class { animate() {} })
    vi.stubGlobal('document', { hidden: false, querySelectorAll: () => [pane] })
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
    animatePaneChange(() => { expect(flush.active).toBe(true); width = 240 })
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateX(240px)', opacity: 0 }, { transform: 'translateX(0px)', opacity: 1 }],
      expect.objectContaining({ duration: 300 })
    )
  })
})
