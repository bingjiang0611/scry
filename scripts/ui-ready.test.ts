import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { createUiReady, reloadUi } from './ui-ready.mjs'

it('requires a new document, loaded body, visible panel and the exact target together', async () => {
  const state = { epoch: 1, mounted: false, authoritative: false, visible: false, target: 'other' }
  const probe = (expression: string) => runInNewContext(expression, {
    performance: { timeOrigin: state.epoch },
    document: {
      readyState: 'complete', body: {},
      querySelector: (selector: string) => {
        if (selector === '#body') return state.mounted && state.authoritative ? {} : null
        if (selector === '#panel') return { checkVisibility: () => state.visible }
        if (selector === '#session') return { dataset: { id: state.target } }
        throw new Error(`Unexpected selector ${selector}`)
      }
    }
  })
  const wait = vi.fn(async (expression: string, _timeoutMs?: number) => {
    expect(probe(expression)).toBe(false) // old document
    state.epoch = 2
    expect(probe(expression)).toBe(false) // body not mounted
    state.mounted = true
    expect(probe(expression)).toBe(false) // preview is not authoritative
    state.authoritative = true
    expect(probe(expression)).toBe(false) // hidden retained panel
    state.visible = true
    expect(probe(expression)).toBe(false) // wrong session
    state.target = 'wanted'
    expect(probe(expression)).toBe(true)
    state.visible = false
    expect(probe(expression)).toBe(false) // no stale stage can count as ready
  })
  await createUiReady(wait)({
    documentEpoch: 1, body: "document.querySelector('#body') != null", panel: '#panel',
    target: "document.querySelector('#session')?.dataset.id === 'wanted'", timeoutMs: 30000
  })
  expect(wait).toHaveBeenCalledOnce()
  expect(wait.mock.calls[0][1]).toBe(30000)
})

it('rejects missing bootstrap state, and does not require authoritative data in loading-state tests', async () => {
  const wait = vi.fn(async (expression: string) => {
    expect(runInNewContext(expression, { document: { readyState: 'complete', body: null } })).toBe(false)
    expect(runInNewContext(expression, { document: { readyState: 'loading', body: {} } })).toBe(false)
    expect(runInNewContext(expression, { document: { readyState: 'complete', body: {} } })).toBe(true)
  })
  await createUiReady(wait)()
  expect(wait.mock.calls[0]).toHaveLength(1) // retain the harness's default deadline
})

it('propagates timeout and renderer crash evidence without retry or repair actions', async () => {
  const crash = new Error('renderer SIGSEGV; original stack')
  const wait = vi.fn().mockRejectedValue(crash)
  await expect(createUiReady(wait)({ panel: '#panel' })).rejects.toBe(crash)
  expect(wait).toHaveBeenCalledOnce()
})

function cdpFixture() {
  const listeners = new Set<(event: { method: string }) => void>()
  return {
    cdp: {
      send: vi.fn(async () => ({})),
      on: (listener: (event: { method: string }) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    emit: (method: string) => { for (const listener of listeners) listener({ method }) },
    listeners
  }
}

it('does not start readiness in the old context when reload only acknowledges dispatch', async () => {
  const { cdp, emit, listeners } = cdpFixture()
  const ready = vi.fn(async () => undefined)
  const pending = reloadUi(cdp, ready, { documentEpoch: 1, target: 'restored', timeoutMs: 30000 }, { ignoreCache: true })
  await vi.waitFor(() => expect(cdp.send).toHaveBeenCalledWith('Page.reload', { ignoreCache: true }))
  expect(ready).not.toHaveBeenCalled()
  emit('Page.loadEventFired')
  await pending
  expect(ready).toHaveBeenCalledWith({ documentEpoch: 1, target: 'restored', timeoutMs: expect.any(Number) })
  expect(ready.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(30000)
  expect(listeners.size).toBe(0)
})

it('waits for actual bottom following after resize without scrolling on the test behalf', async () => {
  const scroller = { scrollHeight: 687, clientHeight: 365, scrollTop: 96, scrollTo: vi.fn() }
  const wait = vi.fn(async (expression: string) => {
    const context = { document: { readyState: 'complete', body: {}, querySelector: () => scroller } }
    expect(runInNewContext(expression, context)).toBe(false)
    // A delayed ResizeObserver pin, not a fixed number of frames in the test.
    scroller.scrollTop = 322
    expect(runInNewContext(expression, context)).toBe(true)
  })
  await createUiReady(wait)({ body: "(() => { const el = document.querySelector('.chat'); return el && el.scrollHeight - el.clientHeight - el.scrollTop < 2 })()" })
  expect(scroller.scrollTo).not.toHaveBeenCalled()
  expect(wait).toHaveBeenCalledOnce()
})

it('reports a renderer crash during reload, without readiness retry or a leaked listener', async () => {
  const { cdp, emit, listeners } = cdpFixture()
  const ready = vi.fn()
  const pending = reloadUi(cdp, ready, { documentEpoch: 1 })
  await vi.waitFor(() => expect(cdp.send).toHaveBeenCalledWith('Page.reload', {}))
  emit('Inspector.targetCrashed')
  await expect(pending).rejects.toThrow('Renderer crashed during reload')
  expect(ready).not.toHaveBeenCalled()
  expect(listeners.size).toBe(0)
})
