import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectCdp, rendererEvaluator } from './electron-security-cdp.mjs'

/**
 * A renderer that has already gone away: the socket opens, then answers nothing. This is the
 * shape the side-chat restart leaves behind when the old window is closed and the new one is
 * reached over a second connection.
 */
class QuietSocket {
  constructor() {
    this.readyState = 0
    this.sent = []
    queueMicrotask(() => { this.readyState = 1; this.onopen?.() })
  }

  send(data) { this.sent.push(data) }

  close() { this.readyState = 3; this.onclose?.() }
}

afterEach(() => vi.unstubAllGlobals())

describe('CDP client whose renderer is gone', () => {
  it('rejects the requests that were in flight when it closes', async () => {
    vi.stubGlobal('WebSocket', QuietSocket)
    const cdp = connectCdp('ws://fixture')
    const inFlight = cdp.send('Runtime.evaluate', { expression: '1 + 1' })
    cdp.close()
    await expect(inFlight).rejects.toThrow('CDP WebSocket 已关闭')
  })

  it('rejects a later request instead of queueing it forever', async () => {
    vi.stubGlobal('WebSocket', QuietSocket)
    const cdp = connectCdp('ws://fixture')
    cdp.close()
    await expect(cdp.send('Runtime.evaluate', { expression: 'performance.timeOrigin' }))
      .rejects.toThrow('CDP WebSocket 已关闭')
  })

  it('keeps the evaluator bound to the client it was built from', async () => {
    const closed = { send: async () => { throw new Error('CDP WebSocket 已关闭') } }
    await expect(rendererEvaluator(closed)('1 + 1')).rejects.toThrow('CDP WebSocket 已关闭')
    const restarted = { send: async () => ({ result: { value: 2 } }) }
    await expect(rendererEvaluator(restarted)('1 + 1')).resolves.toBe(2)
    await expect(rendererEvaluator({ send: async () => ({ exceptionDetails: { text: 'boom' } }) })('1 + 1'))
      .rejects.toThrow('boom')
  })
})
