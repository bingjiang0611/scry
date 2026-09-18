import { describe, expect, it, vi } from 'vitest'
import { TerminalOutputBridge } from './terminal-output'

describe('TerminalOutputBridge', () => {
  it('retains startup output until the renderer owns the terminal id', () => {
    const batches: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => batches.push(events[0].data),
      sendExit: vi.fn(),
      pauseTerminal: vi.fn(),
      resumeTerminal: vi.fn(),
      flushBytes: 10
    })
    bridge.data({ id: 't', data: 'prompt' })
    expect(batches).toEqual([])
    bridge.ready('t', bridge.started('t'))
    expect(batches).toEqual(['prompt'])
    bridge.ack('t', bridge.snapshot('t').ownershipEpoch, 6)
    bridge.close()
  })

  it('delivers an exit that occurs before renderer ready even when no output was produced', () => {
    const exits: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: vi.fn(),
      sendExit: (event) => exits.push(event.id),
      pauseTerminal: vi.fn(),
      resumeTerminal: vi.fn()
    })
    bridge.started('t')
    bridge.exit({ id: 't', code: 1, signal: null })
    expect(exits).toEqual([])
    bridge.ready('t', bridge.started('t'))
    expect(exits).toEqual(['t'])
  })

  it('sends final buffered output before exit and waits for its acknowledgement', () => {
    const calls: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => calls.push(`data:${events[0].data}`),
      sendExit: () => calls.push('exit'),
      pauseTerminal: vi.fn(),
      resumeTerminal: vi.fn(),
      flushBytes: 3,
      highWaterBytes: 3,
      maxBufferBytes: 20
    })
    bridge.ready('t', bridge.started('t'))
    bridge.data({ id: 't', data: 'abc' })
    bridge.data({ id: 't', data: 'def' })
    bridge.exit({ id: 't', code: 0, signal: null })
    expect(calls).toEqual(['data:abc'])
    bridge.ack('t', bridge.snapshot('t').ownershipEpoch, 3)
    expect(calls).toEqual(['data:abc', 'data:def'])
    bridge.ack('t', bridge.snapshot('t').ownershipEpoch, 3)
    expect(calls).toEqual(['data:abc', 'data:def', 'exit'])
  })

  it('bounds each IPC batch by available credit', () => {
    const bytes: number[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => bytes.push(Buffer.byteLength(events[0].data)),
      sendExit: vi.fn(),
      pauseTerminal: vi.fn(),
      resumeTerminal: vi.fn(),
      flushBytes: 4,
      highWaterBytes: 5,
      maxBufferBytes: 20
    })
    bridge.data({ id: 't', data: 'abcdefghij' })
    bridge.ready('t', bridge.started('t'))
    expect(bytes).toEqual([4])
    bridge.ack('t', bridge.snapshot('t').ownershipEpoch, 4)
    expect(bytes).toEqual([4, 4])
    bridge.ack('t', bridge.snapshot('t').ownershipEpoch, 4)
    expect(bytes).toEqual([4, 4, 2])
    bridge.close()
  })

  it('handles split surrogate pairs without phantom buffered bytes', () => {
    const calls: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => calls.push(events[0].data),
      sendExit: () => calls.push('exit'),
      pauseTerminal: vi.fn(),
      resumeTerminal: vi.fn(),
      flushBytes: 8,
      highWaterBytes: 8
    })
    bridge.data({ id: 't', data: '\uD83D' })
    bridge.data({ id: 't', data: '\uDE00' })
    expect(bridge.snapshot('t').bufferedBytes).toBe(4)
    bridge.ready('t', bridge.started('t'))
    bridge.exit({ id: 't', code: 0, signal: null })
    expect(calls).toEqual(['😀'])
    bridge.ack('t', bridge.snapshot('t').ownershipEpoch, 4)
    expect(calls).toEqual(['😀', 'exit'])
  })

  it('does not exceed credit for a multibyte character', () => {
    const calls: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => calls.push(events[0].data),
      sendExit: vi.fn(),
      pauseTerminal: vi.fn(),
      resumeTerminal: vi.fn(),
      flushBytes: 5,
      highWaterBytes: 5
    })
    bridge.ready('t', bridge.started('t'))
    bridge.data({ id: 't', data: 'abcd' })
    bridge.data({ id: 't', data: '你' })
    expect(calls).toEqual(['abcd'])
    bridge.ack('t', bridge.snapshot('t').ownershipEpoch, 4)
    expect(calls).toEqual(['abcd', '你'])
    bridge.close()
  })

  it('tracks backlog bytes incrementally across partial flushes', () => {
    const calls: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => calls.push(events[0].data),
      sendExit: vi.fn(),
      pauseTerminal: vi.fn(),
      resumeTerminal: vi.fn(),
      flushBytes: 4,
      highWaterBytes: 4,
      maxBufferBytes: 32
    })
    bridge.data({ id: 't', data: 'ab' })
    bridge.data({ id: 't', data: '你cd' })
    expect(bridge.snapshot('t')).toMatchObject({ bufferedBytes: 7, inFlightBytes: 0 })

    bridge.ready('t', bridge.started('t'))
    expect(calls).toEqual(['ab'])
    expect(bridge.snapshot('t')).toMatchObject({ bufferedBytes: 5, inFlightBytes: 2 })
    bridge.ack('t', bridge.snapshot('t').ownershipEpoch, 2)
    expect(calls).toEqual(['ab', '你c'])
    expect(bridge.snapshot('t')).toMatchObject({ bufferedBytes: 1, inFlightBytes: 4 })
    bridge.close()
  })

  it('fences stale renderer acknowledgements and resumes from a fresh ownership epoch', () => {
    const sent: Array<{ ownershipEpoch: number; data: string }> = []
    const pauseTerminal = vi.fn()
    const resumeTerminal = vi.fn()
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => sent.push(events[0]),
      sendExit: vi.fn(),
      pauseTerminal,
      resumeTerminal,
      flushBytes: 3,
      highWaterBytes: 3,
      maxBufferBytes: 5
    })
    const firstEpoch = bridge.started('t')
    bridge.ready('t', firstEpoch)
    bridge.data({ id: 't', data: 'abcdef' })
    expect(pauseTerminal).toHaveBeenCalledWith('t')
    expect(sent).toEqual([{ id: 't', ownershipEpoch: firstEpoch, data: 'abc' }])

    bridge.detachRenderer()
    expect(resumeTerminal).toHaveBeenCalledWith('t')
    bridge.data({ id: 't', data: 'recording-only' })
    expect(bridge.ack('t', firstEpoch, 3)).toBe(false)

    const secondEpoch = bridge.attach('t')
    expect(secondEpoch).toBeGreaterThan(firstEpoch)
    bridge.data({ id: 't', data: 'new' })
    expect(bridge.ready('t', secondEpoch)).toBe(true)
    expect(sent.at(-1)).toEqual({ id: 't', ownershipEpoch: secondEpoch, data: 'new' })
    expect(bridge.ack('t', firstEpoch, 3)).toBe(false)
    expect(bridge.snapshot('t').inFlightBytes).toBe(3)
    expect(bridge.ack('t', secondEpoch, 3)).toBe(true)
    expect(bridge.snapshot('t').inFlightBytes).toBe(0)
  })

  it('pauses only the noisy PTY and delivers every byte before its natural exit', () => {
    const pauseTerminal = vi.fn()
    const resumeTerminal = vi.fn()
    const sendExit = vi.fn()
    const output: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => output.push(events[0].data),
      sendExit, pauseTerminal, resumeTerminal,
      flushBytes: 100, highWaterBytes: 3, maxBufferBytes: 5
    })
    bridge.data({ id: 'noisy', data: '123456' })
    expect(pauseTerminal).toHaveBeenCalledExactlyOnceWith('noisy')
    expect(bridge.snapshot('noisy')).toMatchObject({ bufferedBytes: 6, paused: true })
    bridge.ready('other', bridge.started('other'))
    bridge.data({ id: 'other', data: 'ok' })
    bridge.exit({ id: 'other', code: 0, signal: null })
    expect(output).toEqual(['ok'])
    bridge.ack('other', bridge.snapshot('other').ownershipEpoch, 2)
    bridge.ready('noisy', bridge.started('noisy'))
    bridge.exit({ id: 'noisy', code: 0, signal: null })
    bridge.ack('noisy', bridge.snapshot('noisy').ownershipEpoch, 3)
    expect(resumeTerminal).not.toHaveBeenCalled()
    expect(sendExit).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'noisy' }))
    bridge.ack('noisy', bridge.snapshot('noisy').ownershipEpoch, 3)
    expect(resumeTerminal).toHaveBeenCalledExactlyOnceWith('noisy')
    expect(output).toEqual(['ok', '123', '456'])
    expect(sendExit).toHaveBeenCalledWith({ id: 'noisy', code: 0, signal: null, ownershipEpoch: 1 })
    expect(() => bridge.ack('other', bridge.snapshot('other').ownershipEpoch, -1)).toThrow('无效')
    bridge.close()
  })
})
