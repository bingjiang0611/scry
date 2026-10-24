import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
  cleanups: [] as Array<(() => void) | undefined>
}))

vi.mock('react', () => ({
  useRef: (current: unknown) => {
    const existing = harness.refs[harness.refIndex]
    const ref = existing ?? { current }
    if (!existing) harness.refs.push(ref)
    harness.refIndex++
    return ref
  },
  useEffect: (effect: () => (() => void) | void) => { harness.cleanups.push(effect() ?? undefined) },
  useLayoutEffect: (effect: () => (() => void) | void) => { harness.cleanups.push(effect() ?? undefined) }
}))

import { useFlipList } from './useFlipList'

function nodes(count: number, tops: number[], log: string[]) {
  return Array.from({ length: count }, (_, index) => {
    const animation = {
      cancel: vi.fn(() => log.push(`cancel:${index}`)),
      onfinish: null as (() => void) | null
    } as unknown as Animation
    return {
      dataset: { motionKey: `row-${index}` },
      get offsetTop() { log.push(`read:${index}`); return tops[index] ?? index * 20 },
      animate: vi.fn(() => { log.push(`write:${index}`); return animation })
    } as unknown as HTMLElement
  })
}

let currentNodes: HTMLElement[] = []
let log: string[] = []
let reducedListener: ((event: { matches: boolean }) => void) | undefined
const mediaQuery = {
  matches: false,
  addEventListener: vi.fn((_type: string, listener: (event: { matches: boolean }) => void) => { reducedListener = listener }),
  removeEventListener: vi.fn()
}
beforeEach(() => {
  harness.refs = []; harness.refIndex = 0; harness.cleanups = []
  log = []
  mediaQuery.matches = false
  reducedListener = undefined
  vi.stubGlobal('window', { matchMedia: () => mediaQuery })
  vi.stubGlobal('getComputedStyle', () => ({ transform: 'none' }))
  vi.stubGlobal('DOMMatrixReadOnly', class {
    m42: number
    constructor(value: string) { this.m42 = Number(value.match(/,\s*(-?\d+)\)$/)?.[1] ?? 0) }
  })
})
afterEach(() => { harness.cleanups.forEach(cleanup => cleanup?.()); vi.unstubAllGlobals() })

function render(revision: unknown, budget?: number): void {
  harness.refIndex = 0
  useFlipList({ current: { querySelectorAll: () => currentNodes } } as unknown as { current: HTMLElement }, revision, budget)
}

describe('useFlipList', () => {
  it('reads every position before cancelling or writing animations', () => {
    currentNodes = nodes(2, [0, 20], log)
    render('first')
    log.length = 0
    currentNodes = nodes(2, [20, 0], log)
    render('reorder')
    log.length = 0
    currentNodes = nodes(2, [40, 20], log)
    render('second-reorder')
    expect(log.slice(0, 2)).toEqual(['read:0', 'read:1'])
    expect(log.some(entry => entry.startsWith('write:'))).toBe(true)
    expect(log.findIndex(entry => entry.startsWith('cancel:'))).toBeGreaterThanOrEqual(2)
  })

  it('continues an interrupted row from its computed translation', () => {
    currentNodes = nodes(2, [0, 20], log)
    render('first')
    currentNodes = nodes(2, [20, 0], log)
    render('reorder')
    log.length = 0
    const transforms = ['matrix(1, 0, 0, 1, 0, 6)', 'none']
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => ({ transform: transforms[currentNodes.indexOf(element)] }))
    currentNodes = nodes(2, [24, 20], log)
    render('interrupted')
    expect(log).toContain('cancel:0')
    expect(currentNodes[0].animate).toHaveBeenCalledWith(
      [{ transform: 'translateY(2px)', opacity: 1 }, { transform: 'translateY(0)', opacity: 1 }],
      expect.objectContaining({ id: 'scry-list-reorder' })
    )
  })

  it('does not animate geometry changes under reduced motion', () => {
    currentNodes = nodes(2, [0, 20], log)
    render('first')
    mediaQuery.matches = true
    currentNodes = nodes(2, [20, 0], log)
    render('reduced-reorder')
    expect(currentNodes.every(node => (node.animate as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true)
  })

  it('cancels active transforms when the media query changes to reduced motion', () => {
    currentNodes = nodes(2, [0, 20], log)
    render('first')
    currentNodes = nodes(2, [20, 0], log)
    render('reorder')
    log.length = 0
    mediaQuery.matches = true
    expect(reducedListener).toBeTypeOf('function')
    reducedListener?.({ matches: true })
    expect(log).toEqual(['cancel:0', 'cancel:1'])
  })

  it('allows the activity budget while keeping its existing 123-node bound', () => {
    currentNodes = nodes(123, Array.from({ length: 123 }, (_, index) => index * 20), log)
    render('activity-initial', 123)
    log.length = 0
    currentNodes = nodes(123, Array.from({ length: 123 }, (_, index) => (122 - index) * 20), log)
    render('activity-reorder', 123)
    expect(log.filter(entry => entry.startsWith('read:'))).toHaveLength(123)
    expect(currentNodes[0].animate).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ id: 'scry-list-reorder', duration: 300 }))
    log.length = 0
    currentNodes = nodes(124, Array.from({ length: 124 }, (_, index) => index), log)
    render('activity-over-budget', 123)
    expect(log.filter(entry => entry.startsWith('read:'))).toHaveLength(0)
    expect(log.filter(entry => entry.startsWith('cancel:'))).toHaveLength(122)
  })

  it('does not read geometry for oversized lists and seeds resumed rows without arrivals', () => {
    const oversized = nodes(41, Array.from({ length: 41 }, (_, index) => index), log)
    currentNodes = oversized
    render('oversized')
    expect(log.filter(entry => entry.startsWith('read:'))).toHaveLength(0)
    currentNodes = nodes(2, [0, 20], log)
    render('resume')
    expect(currentNodes.every(node => (node.animate as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true)
  })
})
