import { describe, expect, it, vi } from 'vitest'
import { handleTerminalFeed } from './host-local-ops'

// terminalFeed carries the App's terminal output and lifetime (P3-terminal.md). A paired
// device on the network endpoint has no such handlers and gets unsupported_op.
describe('terminalFeed op', () => {
  it('is absent on the network endpoint', async () => {
    await expect(handleTerminalFeed(undefined, { op: 'terminalFeed', method: 'read' })).resolves.toEqual({ error: 'unsupported_op' })
  })

  it('reads by cursor, detaches and shuts down, and refuses anything else', async () => {
    const terminal = { read: vi.fn(() => ({ cursor: 's:1', events: [] })), detachRenderer: vi.fn(), shutdown: vi.fn(async () => undefined) }
    await expect(handleTerminalFeed(terminal, { op: 'terminalFeed', method: 'read', cursor: 's:0' })).resolves.toEqual({ terminal: { cursor: 's:1', events: [] } })
    expect(terminal.read).toHaveBeenCalledWith('s:0')
    await expect(handleTerminalFeed(terminal, { op: 'terminalFeed', method: 'detachRenderer' })).resolves.toEqual({ terminal: true })
    await expect(handleTerminalFeed(terminal, { op: 'terminalFeed', method: 'shutdown' })).resolves.toEqual({ terminal: true })
    for (const bad of [
      { op: 'terminalFeed', method: 'write' }, { op: 'terminalFeed', method: 'read', cursor: 7 },
      { op: 'terminalFeed', method: 'shutdown', cursor: 's:0' }, { op: 'terminalFeed', method: 'read', extra: 1 }
    ]) await expect(handleTerminalFeed(terminal, bad)).resolves.toEqual({ error: 'invalid_request' })
  })
})
