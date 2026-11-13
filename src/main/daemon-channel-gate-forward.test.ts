import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_FORWARD_CHANNELS, DAEMON_LOCAL_OP_CHANNELS, gateDaemonChannel, installDaemonChannelResultHandler, installDaemonRequestForwarder } from './daemon-channel-gate'

// Route `forward`: the daemon already serves the op to paired devices, so the App sends
// that op's own request for the renderer's channel and maps the reply back.

const ON = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv
const routing = ['daemon-ipc-routing.json', 'daemon-ipc-routing-workbench.json']
  .flatMap((file) => (JSON.parse(readFileSync(join(process.cwd(), 'scripts', file), 'utf8')) as { channels: Array<{ channel: string; route: string; op?: string }> }).channels)

describe('forwarded channels', () => {
  const undo: Array<() => void> = []
  afterEach(() => { for (const step of undo.splice(0)) step() })

  it('sends the op request built from the renderer arguments, and returns the mapped reply', async () => {
    const forwarder = vi.fn(async () => ({ renamed: { ok: true } }))
    undo.push(installDaemonRequestForwarder(forwarder))
    const entry = { op: 'sessionAction', read: false, request: (args: unknown[]) => ({ op: 'sessionAction', action: 'rename', args }), result: (reply: Record<string, unknown>) => reply.renamed }
    Object.assign(DAEMON_FORWARD_CHANNELS as Record<string, unknown>, { 'test:forwarded': entry })
    undo.push(() => { delete (DAEMON_FORWARD_CHANNELS as Record<string, unknown>)['test:forwarded'] })
    const after = vi.fn((value: unknown) => ({ after: value }))
    undo.push(installDaemonChannelResultHandler('test:forwarded', after))
    const listener = vi.fn()
    const gated = gateDaemonChannel('test:forwarded', listener, ON) as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>
    await expect(gated({}, 'a', 1)).resolves.toEqual({ after: { ok: true } })
    expect(forwarder).toHaveBeenCalledWith({ op: 'sessionAction', action: 'rename', args: ['a', 1] }, false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('is a named absence until the daemon client is ready', async () => {
    Object.assign(DAEMON_FORWARD_CHANNELS as Record<string, unknown>, { 'test:forwarded': { op: 'commands', read: true, request: () => ({ op: 'commands' }) } })
    undo.push(() => { delete (DAEMON_FORWARD_CHANNELS as Record<string, unknown>)['test:forwarded'] })
    const gated = gateDaemonChannel('test:forwarded', vi.fn(), ON) as unknown as (event: unknown) => Promise<unknown>
    await expect(gated({})).rejects.toThrow('daemon_capability_unavailable:test:forwarded')
  })

  it('forwards only channels the matrix routes to that op, and never one it also serves locally', () => {
    for (const [channel, { op }] of Object.entries(DAEMON_FORWARD_CHANNELS)) {
      const row = routing.find((entry) => entry.channel === channel)
      expect(row?.route, channel).toBe('forward')
      expect(row?.op, channel).toBe(op)
      expect(DAEMON_LOCAL_OP_CHANNELS[channel], channel).toBeUndefined()
    }
  })
})
