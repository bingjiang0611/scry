import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeUiPointer } from './native-ui-pointer.mjs'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture(endTime) {
  vi.useFakeTimers()
  const frames = []
  let left = 0
  const animation = { pending: true, playState: 'running', effect: { getComputedTiming: () => ({ endTime }) } }
  const element = { getBoundingClientRect: () => ({ x: left, y: 0, left, top: 0, width: 40, height: 40 }),
    contains: () => true, getAnimations: () => [animation], parentElement: null, getRootNode: () => document,
    tagName: 'BUTTON', id: 'target', getAttribute: () => 'location-button', closest: () => null }
  vi.stubGlobal('document', { querySelector: () => element, querySelectorAll: query => document.querySelector(query) ? [document.querySelector(query)] : [],
    elementFromPoint: () => element, getAnimations: () => [animation], hasFocus: () => true, activeElement: element })
  vi.stubGlobal('requestAnimationFrame', callback => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  return { animation, element, move: value => { left = value }, frame: async () => { frames.shift()(); await Promise.resolve() } }
}

describe('native pointer readiness', () => {
  it('uses actual shadow-root hit tests and composed event receipts', async () => {
    const f = fixture(150)
    f.element.getAnimations = () => []
    f.element.contains = node => node === f.element
    const host = { getAnimations: () => [], getRootNode: () => document, parentElement: null }
    const shadow = { host, querySelectorAll: () => [f.element], elementFromPoint: () => f.element }
    host.shadowRoot = shadow
    f.element.getRootNode = () => shadow
    document.querySelectorAll = query => query === '*' ? [host] : []
    document.elementFromPoint = () => host
    let receipt
    document.addEventListener = (_, listener) => { receipt = listener }
    vi.stubGlobal('window', {})
    const pending = nativeUiPointer('.location-button', { timeoutMs: 7000, scroll: false, captureReceipt: true })
    await f.frame(); await f.frame()
    await expect(pending).resolves.toEqual({ x: 20, y: 20 })
    receipt({ isTrusted: true, target: host, composedPath: () => [f.element, shadow, host, document] })
    expect(window.__nativeUiPointerReceipt).toMatchObject({ trusted: true, targetMatched: true })
  })
  it('scopes a shadow selector to its containing remote pane', async () => {
    const f = fixture(150)
    f.element.getAnimations = () => []
    f.element.contains = node => node === f.element
    const host = { getAnimations: () => [], getRootNode: () => document, parentElement: null }
    const shadow = { host, querySelectorAll: query => ['*', '.row'].includes(query) ? [f.element] : [], elementFromPoint: () => f.element }
    host.shadowRoot = shadow
    f.element.getRootNode = () => shadow
    document.querySelectorAll = query => ['*', '#remote file-tree-container'].includes(query) ? [host] : []
    document.elementFromPoint = () => host
    const pending = nativeUiPointer('#remote file-tree-container >>> .row', { timeoutMs: 7000, scroll: false, captureReceipt: false })
    await f.frame(); await f.frame()
    await expect(pending).resolves.toEqual({ x: 20, y: 20 })
  })
  it('matches width-truncated tree labels by their full row path', async () => {
    const f = fixture(150)
    f.element.getAnimations = () => []
    f.element.textContent = 'workbench-co…'
    f.element.getAttribute = attribute => attribute === 'data-item-path' ? 'src/workbench-context.ts' : null
    const pending = nativeUiPointer('[data-item-path]', { text: 'workbench-context.ts', timeoutMs: 7000, scroll: false, captureReceipt: false })
    await f.frame(); await f.frame()
    await expect(pending).resolves.toEqual({ x: 20, y: 20 })
  })
  it('does not dispatch at temporarily stable geometry before a finite transition moves the control', async () => {
    const f = fixture(150)
    let result
    const pending = nativeUiPointer('.location-button', { timeoutMs: 7000, scroll: false, captureReceipt: false })
      .then(value => { result = value })
    await f.frame(); await f.frame()
    expect(result).toBeUndefined()
    f.animation.pending = false; f.animation.playState = 'finished'; f.move(100)
    await f.frame(); await f.frame()
    await pending
    expect(result).toEqual({ x: 120, y: 20 })
  })
  it('does not wait for unrelated finite animations elsewhere on the page', async () => {
    const f = fixture(150)
    f.element.getAnimations = () => []
    const pending = nativeUiPointer('.location-button', { timeoutMs: 7000, scroll: false, captureReceipt: false })
    await f.frame(); await f.frame()
    await expect(pending).resolves.toEqual({ x: 20, y: 20 })
  })
  it('retains a finite-animation failure and its target evidence at the original deadline', async () => {
    const f = fixture(150)
    const pending = nativeUiPointer('.location-button', { timeoutMs: 7000, scroll: false, captureReceipt: false }).catch(error => error)
    await f.frame(); await f.frame()
    await vi.advanceTimersByTimeAsync(7000)
    const error = await pending
    expect(error.message).toContain('Pointer geometry did not settle: .location-button')
    const snapshot = JSON.parse(error.message.split('; snapshot=')[1])
    expect(snapshot).toMatchObject({ readiness: 'finite animation active', target: { tag: 'BUTTON', id: 'target' }, box: [0, 0, 40, 40], focused: true })
  })
  it('reports a missing target without replacing the timeout with a diagnostic exception', async () => {
    const f = fixture(150)
    document.querySelector = () => null
    const pending = nativeUiPointer('.missing', { timeoutMs: 7000, scroll: false, captureReceipt: false }).catch(error => error)
    await f.frame()
    await vi.advanceTimersByTimeAsync(7000)
    const snapshot = JSON.parse((await pending).message.split('; snapshot=')[1])
    expect(snapshot).toMatchObject({ readiness: 'target missing', target: null, box: null, hit: null })
  })
  it('ignores infinite activity animations rather than blocking ordinary controls forever', async () => {
    const f = fixture(Infinity)
    const pending = nativeUiPointer('.location-button', { timeoutMs: 7000, scroll: false, captureReceipt: false })
    await f.frame(); await f.frame()
    await expect(pending).resolves.toEqual({ x: 20, y: 20 })
  })
})
