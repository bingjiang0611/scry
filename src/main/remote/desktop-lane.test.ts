import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopLanes, laneForRequest, laneNotSent, replayableRequest, type DesktopLaneChannel, type DesktopLaneEndpoint } from './desktop-lane'
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
    // The App's event feed holds a long poll of its own; nothing may queue behind it.
    expect(laneForRequest({ op: 'appEvents' })).toBe('events')
    // Marking a session viewed is short and must not queue behind a bulk read.
    expect(laneForRequest({ op: 'attentionViewed' })).toBe('control')
    expect(replayableRequest({ op: 'attentionViewed' })).toBe(true)
    expect(laneForRequest({ op: 'desktop', query: { kind: 'info' } })).toBe('control')
    expect(laneForRequest({ op: 'desktop', query: { kind: 'trace' } })).toBe('bulk')
    expect(laneForRequest({ op: 'historyPage' })).toBe('bulk')
    expect(replayableRequest({ op: 'poll' })).toBe(true)
  })

  it('treats a workbench write as a write, whichever surface carries it', () => {
    // A lost reply to PTY input, a file write or a Git mutation must not send it again:
    // the host may already have typed, written or pushed. A push or merge can hold its
    // lane for the whole 30 s timeout, so workbench writes have a lane of their own and
    // a stop or an answer on control never waits behind one.
    for (const [surface, method] of [['terminal', 'terminalWrite'], ['terminal', 'terminalClose'], ['workspace', 'workspaceWrite'], ['sourceControl', 'mutate']]) {
      const request = { op: 'desktopWorkbench', query: { surface, cwd: '/w', method, args: [] } }
      expect(replayableRequest(request), method).toBe(false)
      expect(laneForRequest(request), method).toBe('workbench')
    }
    expect(laneForRequest({ op: 'desktopWorkbench' })).toBe('workbench')
    for (const op of ['stop', 'answerQuestion']) expect(laneForRequest({ op })).toBe('control')
    // A request without a method is not proven to be a read.
    expect(replayableRequest({ op: 'desktopWorkbench' })).toBe(false)
    for (const [surface, method] of [['terminal', 'terminalEvents'], ['workspace', 'workspaceReadPage'], ['sourceControl', 'read']]) {
      const request = { op: 'desktopWorkbench', query: { surface, cwd: '/w', method, args: [] } }
      expect(replayableRequest(request), method).toBe(true)
      expect(laneForRequest(request), method).toBe('bulk')
    }
  })
})

describe('terminal lane (P3-terminal)', () => {
  it('keeps typing and terminal output off the lanes long reads and pushes hold', () => {
    for (const method of ['start', 'write', 'resize', 'ready', 'ack', 'close', 'attach', 'active']) {
      expect(laneForRequest({ op: 'terminal', method }), method).toBe('terminal')
    }
    expect(laneForRequest({ op: 'terminalFeed', method: 'read' })).toBe('terminal')
    // A recording page can be 512 KiB: it reads on bulk, behind nothing a keystroke waits for.
    for (const method of ['recordingList', 'recordingRead']) expect(laneForRequest({ op: 'terminal', method })).toBe('bulk')
    // Input is never replayed; reading the feed again from the same cursor is harmless.
    expect(replayableRequest({ op: 'terminal', method: 'write' })).toBe(false)
    expect(replayableRequest({ op: 'terminalFeed', method: 'read' })).toBe(true)
  })
})

describe('mcp lane', () => {
  it('gives MCP its own long lane, and replays only the guard scan', () => {
    for (const method of ['mcpSnapshot', 'testMcp', 'reauthenticateMcp', 'mcpGuardScan']) expect(laneForRequest({ op: 'mcp', method }), method).toBe('mcp')
    expect(replayableRequest({ op: 'mcp', method: 'mcpGuardScan' })).toBe(true)
    for (const method of ['mcpSnapshot', 'testMcp', 'reauthenticateMcp']) expect(replayableRequest({ op: 'mcp', method }), method).toBe(false)
  })
})

describe('DesktopLanes send failures', () => {
  // A channel whose writes fail the way `socket.write` does: the callback reports an
  // error, so the bytes may or may not have reached the host.
  function writeFailingChannel() {
    const frames: string[] = []
    const channel: DesktopLaneChannel = {
      send: async frame => { frames.push(frame); throw new Error('write_eio') },
      receive: async () => await new Promise<string>(() => undefined),
      destroy: () => undefined,
      onClose: () => () => undefined
    }
    return { channel, frames }
  }

  it('never re-sends a write when the write callback reports an error', async () => {
    const failing = writeFailingChannel()
    const connect = vi.fn(async () => failing.channel)
    const lanes = new DesktopLanes(connect)
    // The outcome is unproven, so the caller keeps it unknown and reconciles by intent.
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'sessionFork' }, replayable: false })).rejects.toThrow('write_eio')
    // One attempt, one frame: a second fork would have been a second real fork.
    expect(connect).toHaveBeenCalledTimes(1)
    expect(failing.frames).toHaveLength(1)
  })

  it('still replays a read once when the write callback reports an error', async () => {
    const failing = writeFailingChannel()
    const healthy = scriptedChannel(() => '{"keepAlive":true,"cursor":2}')
    const connect = vi.fn().mockResolvedValueOnce(failing.channel).mockResolvedValueOnce(healthy.channel)
    const lanes = new DesktopLanes(connect)
    await expect(lanes.request('bulk', 'c1', { endpoint, request: { op: 'historyPage' }, replayable: true })).resolves.toEqual({ cursor: 2 })
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('re-sends a write whose frame was refused before any write', async () => {
    const refused: DesktopLaneChannel = {
      send: async () => { throw laneNotSent(new Error('desktop_lane_closed')) },
      receive: async () => await new Promise<string>(() => undefined),
      destroy: () => undefined,
      onClose: () => () => undefined
    }
    const healthy = scriptedChannel(() => '{"keepAlive":true,"sessionAction":true}')
    const connect = vi.fn().mockResolvedValueOnce(refused).mockResolvedValueOnce(healthy.channel)
    const lanes = new DesktopLanes(connect)
    await expect(lanes.request('control', 'c1', { endpoint, request: { op: 'sessionAction' }, replayable: false })).resolves.toEqual({ sessionAction: true })
    expect(connect).toHaveBeenCalledTimes(2)
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

  it('cancels a queued read without dropping the exchange in front of it', async () => {
    let release!: () => void
    let calls = 0
    const connect = vi.fn(fakeLaneConnector(async () => {
      calls++
      const seq = calls
      if (seq === 1) await new Promise<void>((resolve) => { release = resolve })
      return { seq }
    }))
    const lanes = new DesktopLanes(connect)
    // Same lane: the second call queues behind the first instead of owning a channel.
    const first = lanes.request('watch', 'c1', { endpoint, request: { op: 'watch' }, replayable: true })
    await vi.waitFor(() => expect(calls).toBe(1))
    const controller = new AbortController()
    const queued = lanes.request('watch', 'c1', { endpoint, request: { op: 'watch' }, replayable: true, signal: controller.signal })
    // The queued read has not been written yet, so its cancellation owns no channel.
    controller.abort()
    await expect(queued).rejects.toThrow('desktop_lane_cancelled')
    release()
    // The in-flight read keeps its channel: one handshake for the whole lane.
    await expect(first).resolves.toEqual({ seq: 1 })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(calls).toBe(1)
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
