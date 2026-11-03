import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopLanes, laneForRequest, replayableRequest, type DesktopLaneChannel, type DesktopLaneEndpoint } from './desktop-lane'
import { fakeLaneConnector } from './desktop-lane-fixtures'
import { setPerformanceRecordingSink, type PerformanceSample } from '../performance-timing'

const endpoint: DesktopLaneEndpoint = { path: 'run-1', caPEM: 'ca', certPEM: 'cert', keyPEM: 'key' }

afterEach(() => {
  setPerformanceRecordingSink(null)
  vi.useRealTimers()
})

// A channel whose replies the test scripts per frame.
function scriptedChannel(reply: (request: Record<string, unknown>) => string | Error | Promise<string | Error>) {
  const frames: Record<string, unknown>[] = []
  let closed: Error | undefined
  let pending: Promise<string | Error> | undefined
  const listeners = new Set<(reason: Error) => void>()
  const close = (reason: Error): void => {
    if (closed) return
    closed = reason
    for (const listener of listeners) listener(reason)
  }
  const channel: DesktopLaneChannel = {
    send: async frame => { const request = JSON.parse(frame) as Record<string, unknown>; frames.push(request); pending = Promise.resolve(reply(request)) },
    receive: async () => {
      const value = await pending!
      if (value instanceof Error) { close(value); throw value }
      return value
    },
    destroy: () => close(new Error('desktop_lane_closed')),
    onClose: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  return { channel, frames, closed: () => closed !== undefined }
}

describe('desktop lane routing', () => {
  it('keeps writes on control and moves long reads to their own lanes', () => {
    for (const op of ['submit', 'stop', 'answerQuestion', 'resolveIntent', 'attachmentChunk', 'sessionAction', 'sessionDelete', 'sessionFork']) {
      expect(laneForRequest({ op })).toBe('control')
      expect(replayableRequest({ op })).toBe(false)
    }
    expect(laneForRequest({ op: 'watch' })).toBe('watch')
    expect(laneForRequest({ op: 'liveRuns' })).toBe('status')
    expect(laneForRequest({ op: 'desktop', query: { kind: 'info' } })).toBe('control')
    expect(laneForRequest({ op: 'desktop', query: { kind: 'trace' } })).toBe('bulk')
    expect(laneForRequest({ op: 'historyPage' })).toBe('bulk')
    expect(replayableRequest({ op: 'poll' })).toBe(true)
  })
})

describe('DesktopLanes', () => {
  it('reuses one channel and pays one handshake for consecutive requests', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    const handler = vi.fn(async ({ request }: { request: unknown }) => ({ echo: (request as { op: string }).op }))
    const connect = vi.fn(fakeLaneConnector(handler))
    const lanes = new DesktopLanes(connect)
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'providers' }, replayable: true })).resolves.toEqual({ echo: 'providers' })
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'projects' }, replayable: true })).resolves.toEqual({ echo: 'projects' })
    expect(connect).toHaveBeenCalledTimes(1)
    // The keep-alive marker is transport framing and is not part of the reply.
    expect(handler.mock.calls.map(([call]) => call.request)).toEqual([{ op: 'providers' }, { op: 'projects' }])
    // A new channel shows its handshake stage; a reused one goes straight to the write.
    expect(samples.map(sample => sample.name)).toEqual(['remote.client.request', 'remote.client.request'])
    expect(samples.map(sample => sample.checkpoints.map(point => point.stage))).toEqual([
      ['connect_started', 'secure_connected', 'request_written', 'first_byte', 'response_parsed'],
      ['connect_started', 'request_written', 'first_byte', 'response_parsed']
    ])
    expect(samples.map(sample => sample.counters)).toEqual([
      { 'op.providers': 1, 'lane.control': 1, reused: 0 },
      { 'op.projects': 1, 'lane.control': 1, reused: 1 }
    ])
    lanes.closeAll()
  })

  it('does not let a pending watch delay control work', async () => {
    let releaseWatch!: () => void
    const watchGate = new Promise<void>(resolve => { releaseWatch = resolve })
    const lanes = new DesktopLanes(fakeLaneConnector(async ({ request }) => {
      if ((request as { op: string }).op === 'watch') await watchGate
      return { ok: (request as { op: string }).op }
    }))
    const watch = lanes.request('watch', 'c1', { endpoint, request: { op: 'watch' }, replayable: true })
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'stop' }, replayable: false })).resolves.toEqual({ ok: 'stop' })
    releaseWatch()
    await expect(watch).resolves.toEqual({ ok: 'watch' })
    lanes.closeAll()
  })

  it('rejects a reply without the keep-alive marker instead of falling back to one-shot', async () => {
    const script = scriptedChannel(() => '{"ok":true}')
    const connect = vi.fn(async () => script.channel)
    const lanes = new DesktopLanes(connect)
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'providers' }, replayable: true })).rejects.toThrow('desktop_protocol_mismatch')
    // A failed request still ends its trace, as an error.
    expect(samples.map(sample => sample.outcome)).toEqual(['error'])
    expect(script.frames).toHaveLength(1)
    expect(script.closed()).toBe(true)
  })

  it('retries a channel that never opened at most twice', async () => {
    const connect = vi.fn(async (): Promise<DesktopLaneChannel> => { throw new Error('connect_refused') })
    const lanes = new DesktopLanes(connect)
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'submit' }, replayable: false })).rejects.toThrow('connect_refused')
    expect(connect).toHaveBeenCalledTimes(3)
  })

  it('replays a lost read once and never replays a lost write', async () => {
    const read = scriptedChannel(() => new Error('reply_lost'))
    const second = scriptedChannel(() => '{"keepAlive":true,"cursor":1}')
    const connect = vi.fn().mockResolvedValueOnce(read.channel).mockResolvedValueOnce(second.channel)
    const lanes = new DesktopLanes(connect)
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'poll' }, replayable: true })).resolves.toEqual({ cursor: 1 })
    expect(read.frames.length + second.frames.length).toBe(2)

    const write = scriptedChannel(() => new Error('reply_lost'))
    const writes = new DesktopLanes(vi.fn(async () => write.channel))
    // The original diagnostic survives; the caller keeps the outcome unknown.
    await expect(writes.request('control', 'c1', { endpoint, request: { op: 'submit' }, replayable: false })).rejects.toThrow('reply_lost')
    expect(write.frames).toHaveLength(1)
  })

  it('cancels a read without failing the requests queued behind it', async () => {
    let calls = 0
    const lanes = new DesktopLanes(fakeLaneConnector(async () => {
      calls++
      if (calls === 1) return await new Promise(() => undefined)
      return { ok: true }
    }))
    const controller = new AbortController()
    const watch = lanes.request('watch', 'c1', { endpoint, request: { op: 'watch' }, replayable: true, signal: controller.signal })
    const next = lanes.request('watch', 'c1', { endpoint, request: { op: 'watch' }, replayable: true })
    // Abort once the first read is on the wire.
    await vi.waitFor(() => expect(calls).toBe(1))
    controller.abort()
    await expect(watch).rejects.toThrow('desktop_lane_cancelled')
    await expect(next).resolves.toEqual({ ok: true })
    // The cancelled read was not replayed.
    expect(calls).toBe(2)
    lanes.closeAll()
  })

  it('fails queued work on a closed connection before writing it', async () => {
    let release!: () => void
    const handler = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve }); return { ok: true } })
    const lanes = new DesktopLanes(fakeLaneConnector(handler))
    const first = lanes.request('control', 'c1', { endpoint, request: { op: 'stop' }, replayable: false })
    const queued = lanes.request('control', 'c1', { endpoint, request: { op: 'submit' }, replayable: false })
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    lanes.closeConnection('c1')
    release()
    // The write already on the wire keeps its real outcome.
    await expect(first).resolves.toEqual({ ok: true })
    await expect(queued).rejects.toThrow('desktop_not_connected')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('closes an idle channel after 20 s and times out a silent watch after 40 s', async () => {
    vi.useFakeTimers()
    const idle = scriptedChannel(() => '{"keepAlive":true}')
    const lanes = new DesktopLanes(vi.fn(async () => idle.channel))
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'providers' }, replayable: true })).resolves.toEqual({})
    await vi.advanceTimersByTimeAsync(19_999)
    expect(idle.closed()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(idle.closed()).toBe(true)

    const silent = scriptedChannel(() => new Promise<string>(() => undefined))
    const watch = new DesktopLanes(vi.fn(async () => silent.channel))
    const pending = watch.request('watch', 'c1', { endpoint, request: { op: 'watch' }, replayable: false })
    const outcome = expect(pending).rejects.toThrow('desktop_lane_timeout')
    await vi.advanceTimersByTimeAsync(40_000)
    await outcome
  })
})
