import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTabIndicator } from './useTabIndicator'

const hooks = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
  refIndex: 0,
  effectIndex: 0
}))

vi.mock('react', () => {
  const effect = (callback: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.effectIndex++
    const previous = hooks.effects[index]
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
    hooks.pending.push(() => {
      previous?.cleanup?.()
      hooks.effects[index] = { deps, cleanup: callback() || undefined }
    })
  }
  return {
    useRef: (value: unknown) => {
      const index = hooks.refIndex++
      return hooks.refs[index] ?? (hooks.refs[index] = { current: value })
    },
    useEffect: effect,
    useLayoutEffect: effect
  }
})
vi.mock('../motion', () => ({
  MOTION: { durBase: 220, easeStruct: 'ease' },
  prefersReducedMotion: () => false,
  subscribeReducedMotion: () => () => {}
}))

let reads: number
let positions: Record<string, number>
let items: Map<string, HTMLElement>
let indicator: HTMLSpanElement
const root = { current: null as HTMLElement | null }
const observers: Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
const animate = vi.fn(() => ({ cancel: vi.fn() }))

function render(selected: string, keys = ['a', 'b']): void {
  hooks.refIndex = hooks.effectIndex = 0
  useTabIndicator(root, selected, items, keys)
  hooks.refs[0].current = indicator
  hooks.pending.splice(0).forEach(effect => effect())
}

beforeEach(() => {
  hooks.refs = []; hooks.effects = []; hooks.pending = []
  observers.length = 0
  reads = 0
  positions = { a: 0, b: 100 }
  animate.mockClear()
  items = new Map(['a', 'b'].map(key => [key, Object.defineProperties({}, {
    offsetLeft: { get: () => { reads++; return positions[key] } },
    offsetWidth: { get: () => { reads++; return 100 } }
  }) as HTMLElement]))
  root.current = { dataset: {} } as HTMLElement
  indicator = { hidden: true, style: {}, animate } as unknown as HTMLSpanElement
  vi.stubGlobal('getComputedStyle', () => ({ transform: 'matrix(100, 0, 0, 1, 0, 0)' }))
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void
    observe = vi.fn()
    disconnect = vi.fn()
    constructor(callback: () => void) { this.callback = callback; observers.push(this) }
  })
})
afterEach(() => {
  hooks.effects.forEach(effect => effect.cleanup?.())
  vi.unstubAllGlobals()
})

describe('useTabIndicator', () => {
  it('does not read geometry or rebuild observers for unrelated rerenders', () => {
    render('a')
    expect(reads).toBe(2)
    expect(observers).toHaveLength(1)
    expect(observers[0].observe).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 10; i++) render('a', ['a', 'b'])
    expect(reads).toBe(2)
    expect(observers).toHaveLength(1)
    expect(observers[0].disconnect).not.toHaveBeenCalled()
  })

  it('animates selection only; collection changes and resize jump directly', () => {
    render('a')
    render('b')
    expect(animate).toHaveBeenCalledExactlyOnceWith(expect.any(Array), expect.objectContaining({ duration: 220 }))
    expect(observers).toHaveLength(1)
    positions.b = 140
    observers[0].callback()
    expect(indicator.style.transform).toBe('translateX(140px) scaleX(100)')
    expect(animate).toHaveBeenCalledTimes(1)
    positions.b = 0
    render('b', ['b', 'a'])
    expect(indicator.style.transform).toBe('translateX(0px) scaleX(100)')
    expect(animate).toHaveBeenCalledTimes(1)
    expect(observers).toHaveLength(2)
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
    items.delete('b')
    render('a', ['a'])
    expect(animate).toHaveBeenCalledTimes(1)
    expect(observers).toHaveLength(3)
    expect(observers[2].observe).toHaveBeenCalledTimes(2)
  })
})
