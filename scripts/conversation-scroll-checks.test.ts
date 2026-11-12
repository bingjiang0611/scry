import { afterEach, expect, it, vi } from 'vitest'
import { exerciseConversationScroll } from './conversation-scroll-checks.mjs'

function fixture() {
  const state = { atLatest: true, scrollHeight: 365, clientHeight: 365, scrollTop: 0 }
  const cdp = { send: vi.fn(async (method: string) => {
    if (method === 'Emulation.setDeviceMetricsOverride') Object.assign(state, { atLatest: false, scrollHeight: 687, scrollTop: 96 })
  }) }
  const evaluate = vi.fn(async (expression: string) => {
    if (expression.includes('getBoundingClientRect')) return { x: 10, y: 30 }
    if (expression.includes('return { top:')) return { top: 0, height: 687, client: 365 }
    if (expression.startsWith('new Promise')) return undefined
    if (expression.includes('scrollTop === 0')) return true
    return { ...state }
  })
  const ready = vi.fn(async (_options: unknown) => undefined)
  const wait = vi.fn(async (probe: () => unknown) => probe())
  return { state, cdp, evaluate, ready, wait, conversationId: 'target' }
}
afterEach(() => vi.restoreAllMocks())

it('waits for the product pin before measuring or issuing native wheel input', async () => {
  const options = fixture()
  let pin!: () => void
  options.ready.mockImplementationOnce(async () => undefined).mockImplementationOnce(() => new Promise<void>(resolve => {
    pin = () => { Object.assign(options.state, { atLatest: true, scrollTop: 322 }); resolve() }
  }))
  const run = exerciseConversationScroll(options)
  await vi.waitFor(() => expect(options.ready).toHaveBeenCalledTimes(2))
  expect(options.cdp.send.mock.calls.map(([method]) => method)).toEqual(['Emulation.setDeviceMetricsOverride'])
  expect(options.ready).toHaveBeenLastCalledWith({ body: expect.stringContaining('scrollTop < 2'), target: expect.stringContaining('"target"') })
  pin()
  await run
  expect(options.cdp.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseWheel' }))
  expect(options.cdp.send).toHaveBeenLastCalledWith('Emulation.clearDeviceMetricsOverride')
})

it('fails on a lost pin instead of shrinking again or repairing it', async () => {
  const options = fixture()
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  options.ready.mockImplementationOnce(async () => undefined).mockRejectedValueOnce(new Error('bottom readiness timed out'))
  await expect(exerciseConversationScroll(options)).rejects.toThrow('bottom readiness timed out')
  expect(options.cdp.send.mock.calls.map(([method]) => method)).toEqual(['Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride'])
  expect(diagnostic).toHaveBeenCalledWith('[scry] transcript scroll geometry', expect.objectContaining({
    expectedConversationId: 'target',
    initial: expect.objectContaining({ atLatest: false, scrollTop: 96 }),
    current: { status: 'fulfilled', value: expect.objectContaining({ atLatest: false, scrollTop: 96 }) }
  }))
})

it('keeps the readiness failure when collecting current geometry also fails', async () => {
  const options = fixture()
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const unavailable = new Error('renderer diagnostic unavailable')
  options.evaluate.mockResolvedValueOnce({ ...options.state }).mockRejectedValue(unavailable)
  options.ready.mockImplementationOnce(async () => undefined).mockRejectedValueOnce(new Error('bottom readiness timed out'))
  await expect(exerciseConversationScroll(options)).rejects.toThrow('bottom readiness timed out')
  expect(diagnostic).toHaveBeenCalledWith('[scry] transcript scroll geometry', expect.objectContaining({
    current: { status: 'rejected', reason: unavailable }
  }))
  expect(options.cdp.send).toHaveBeenLastCalledWith('Emulation.clearDeviceMetricsOverride')
})

it('retains the independent overflow/bottom assertion even if readiness incorrectly returns early', async () => {
  const options = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await expect(exerciseConversationScroll(options)).rejects.toThrow('scrollable transcript follows the bottom')
  expect(options.cdp.send).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything())
  expect(options.cdp.send).toHaveBeenLastCalledWith('Emulation.clearDeviceMetricsOverride')
})
