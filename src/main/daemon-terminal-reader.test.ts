import { describe, expect, it, vi } from 'vitest'
import { DaemonTerminalReader } from './daemon-terminal-reader'
import type { DesktopTerminalEvents } from '../shared/desktop-workbench'

// The App side of P3-terminal: a notice drains the daemon's queue by cursor onto the
// window's own channels; one reader at a time; a window that cannot receive drops it.

const data = (id: string, text: string) => ({ kind: 'data' as const, events: [{ id, ownershipEpoch: 1, data: text }] })

describe('DaemonTerminalReader', () => {
  it('reads every page after the notice and delivers them in order on main\'s channels', async () => {
    const pages: DesktopTerminalEvents[] = [
      { cursor: 's:2', events: [data('t1', 'a'), { kind: 'recordingError', event: { id: 't1', message: 'm' } }] },
      { cursor: 's:3', events: [{ kind: 'exit', event: { id: 't1', ownershipEpoch: 1, code: 0, signal: null } }] },
      { cursor: 's:3', events: [] }
    ]
    const read = vi.fn(async (_cursor: string | undefined) => pages.shift()!)
    const sent: Array<[string, unknown]> = []
    const reader = new DaemonTerminalReader({ read, send: (channel, payload) => sent.push([channel, payload]), canSend: () => true })
    reader.notice()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 's:2', 's:3'])
    expect(sent.map(([channel]) => channel)).toEqual(['terminal:data', 'terminal:recordingError', 'terminal:exit'])
    expect(sent[0]![1]).toEqual([{ id: 't1', ownershipEpoch: 1, data: 'a' }])
  })

  it('reads once more for a notice that came during a read, never twice at once', async () => {
    let release: (() => void) | undefined
    let inFlight = 0
    let maxInFlight = 0
    const pages: DesktopTerminalEvents[] = [{ cursor: 's:1', events: [data('t1', 'a')] }, { cursor: 's:1', events: [] }, { cursor: 's:2', events: [data('t1', 'b')] }, { cursor: 's:2', events: [] }]
    const read = vi.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (read.mock.calls.length === 1) await new Promise<void>((resolve) => { release = resolve })
      inFlight -= 1
      return pages.shift()!
    })
    const sent: unknown[] = []
    const reader = new DaemonTerminalReader({ read, send: (_channel, payload) => sent.push(payload), canSend: () => true })
    reader.notice()
    reader.notice()
    reader.notice()
    release?.()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4))
    expect(maxInFlight).toBe(1)
    expect(sent).toHaveLength(2)
  })

  it('drops output for a window that cannot receive, and keeps the cursor after a failed read', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('daemon_not_running'))
      .mockResolvedValueOnce({ cursor: 's:1', events: [data('t1', 'a')] })
      .mockResolvedValueOnce({ cursor: 's:1', events: [] })
    const send = vi.fn()
    const warn = vi.fn()
    const reader = new DaemonTerminalReader({ read, send, canSend: () => false, onWarn: warn })
    reader.notice()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    reader.notice()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    expect(read.mock.calls[1]![0]).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })
})
