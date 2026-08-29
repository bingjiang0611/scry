import { describe, expect, it, vi } from 'vitest'
import { TerminalOutputBridge } from './terminal-output'

describe('TerminalOutputBridge', () => {
  it('retains startup output until the renderer owns the terminal id', () => {
    const batches: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => batches.push(events[0].data),
      sendExit: vi.fn(),
      closeTerminal: vi.fn(),
      flushBytes: 10
    })
    bridge.data({ id: 't', data: 'prompt' })
    expect(batches).toEqual([])
    bridge.ready('t')
    expect(batches).toEqual(['prompt'])
    bridge.ack('t', 6)
    bridge.close()
  })

  it('delivers an exit that occurs before renderer ready even when no output was produced', () => {
    const exits: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: vi.fn(),
      sendExit: (event) => exits.push(event.id),
      closeTerminal: vi.fn()
    })
    bridge.started('t')
    bridge.exit({ id: 't', code: 1, signal: null })
    expect(exits).toEqual([])
    bridge.ready('t')
    expect(exits).toEqual(['t'])
  })

  it('sends final buffered output before exit and waits for its acknowledgement', () => {
    const calls: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => calls.push(`data:${events[0].data}`),
      sendExit: () => calls.push('exit'),
      closeTerminal: vi.fn(),
      flushBytes: 3,
      highWaterBytes: 3,
      maxBufferBytes: 20
    })
    bridge.ready('t')
    bridge.data({ id: 't', data: 'abc' })
    bridge.data({ id: 't', data: 'def' })
    bridge.exit({ id: 't', code: 0, signal: null })
    expect(calls).toEqual(['data:abc'])
    bridge.ack('t', 3)
    expect(calls).toEqual(['data:abc', 'data:def'])
    bridge.ack('t', 3)
    expect(calls).toEqual(['data:abc', 'data:def', 'exit'])
  })

  it('bounds each IPC batch by available credit', () => {
    const bytes: number[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => bytes.push(Buffer.byteLength(events[0].data)),
      sendExit: vi.fn(),
      closeTerminal: vi.fn(),
      flushBytes: 4,
      highWaterBytes: 5,
      maxBufferBytes: 20
    })
    bridge.data({ id: 't', data: 'abcdefghij' })
    bridge.ready('t')
    expect(bytes).toEqual([4])
    bridge.ack('t', 4)
    expect(bytes).toEqual([4, 4])
    bridge.ack('t', 4)
    expect(bytes).toEqual([4, 4, 2])
    bridge.close()
  })

  it('handles split surrogate pairs without phantom buffered bytes', () => {
    const calls: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => calls.push(events[0].data),
      sendExit: () => calls.push('exit'),
      closeTerminal: vi.fn(),
      flushBytes: 8,
      highWaterBytes: 8
    })
    bridge.data({ id: 't', data: '\uD83D' })
    bridge.data({ id: 't', data: '\uDE00' })
    bridge.ready('t')
    bridge.exit({ id: 't', code: 0, signal: null })
    expect(calls).toEqual(['😀'])
    bridge.ack('t', 4)
    expect(calls).toEqual(['😀', 'exit'])
  })

  it('does not exceed credit for a multibyte character', () => {
    const calls: string[] = []
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: (events) => calls.push(events[0].data),
      sendExit: vi.fn(),
      closeTerminal: vi.fn(),
      flushBytes: 5,
      highWaterBytes: 5
    })
    bridge.ready('t')
    bridge.data({ id: 't', data: 'abcd' })
    bridge.data({ id: 't', data: '你' })
    expect(calls).toEqual(['abcd'])
    bridge.ack('t', 4)
    expect(calls).toEqual(['abcd', '你'])
    bridge.close()
  })

  it('closes only the noisy terminal instead of growing its backlog without bound', () => {
    const closeTerminal = vi.fn()
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: vi.fn(),
      sendExit: vi.fn(),
      closeTerminal,
      flushBytes: 100,
      highWaterBytes: 3,
      maxBufferBytes: 5
    })
    bridge.data({ id: 'noisy', data: '123456' })
    expect(closeTerminal).toHaveBeenCalledWith('noisy')
    expect(bridge.snapshot('noisy').bufferedBytes).toBe(0)
    expect(() => bridge.ack('other', -1)).toThrow('无效')
    bridge.close()
  })
})
