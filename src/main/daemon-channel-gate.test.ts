import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { DAEMON_LOCAL_OP_CHANNELS, DAEMON_MODE_IN_PROCESS_CHANNELS, DAEMON_MODE_SERVED_CHANNELS, gateDaemonChannel, installDaemonChannelForwarder } from './daemon-channel-gate'

const on = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv
const off = {} as NodeJS.ProcessEnv
const routing = [
  ...JSON.parse(readFileSync(new URL('../../scripts/daemon-ipc-routing.json', import.meta.url), 'utf8')).channels,
  ...JSON.parse(readFileSync(new URL('../../scripts/daemon-ipc-routing-workbench.json', import.meta.url), 'utf8')).channels,
  ...JSON.parse(readFileSync(new URL('../../scripts/daemon-ipc-routing-client.json', import.meta.url), 'utf8')).channels,
  ...JSON.parse(readFileSync(new URL('../../scripts/daemon-ipc-routing-service.json', import.meta.url), 'utf8')).channels
] as Array<{ channel: string; route: string; op?: string; method?: string }>
const routeOf = (channel: string) => routing.find((row) => row.channel === channel)?.route

// With the switch on the daemon owns the run pipeline, the ledger and (by B4-S) SQLite.
// A channel that still ran its in-process handler would read or write the same userData
// as a second owner, or answer from state the daemon no longer keeps. Until a channel is
// migrated it answers with a named absence, never with a local fallback (B4 hard rule 2).
describe('daemon mode channel gate', () => {
  it('leaves every handler untouched while the switch is off', () => {
    const listener = vi.fn()
    expect(gateDaemonChannel('test:unclassified', listener, off)).toBe(listener)
  })

  it('refuses a channel no table classifies (every production channel is classified now) without running its handler', () => {
    const listener = vi.fn(() => 'in-process answer')
    const gated = gateDaemonChannel('test:unclassified', listener, on)
    expect(() => gated()).toThrow('daemon_capability_unavailable:test:unclassified')
    expect(listener).not.toHaveBeenCalled()
  })

  it('fails closed for a channel nobody has classified yet', () => {
    const listener = vi.fn()
    expect(() => gateDaemonChannel('agent:somethingNew', listener, on)()).toThrow('daemon_capability_unavailable:agent:somethingNew')
    expect(listener).not.toHaveBeenCalled()
  })

  it('passes window-side channels and the run channels the daemon already answers', () => {
    for (const channel of ['app:copyText', 'runTraces:subscribe', 'agent:start', 'agent:stop']) {
      const listener = vi.fn()
      expect(gateDaemonChannel(channel, listener, on)).toBe(listener)
    }
  })

  it('answers the unread badge in process, from the mirror of the daemon set (E1b)', () => {
    // The handler itself refuses until the daemon's first snapshot (dock-badge.test.ts),
    // so "not known yet" never reads as "nothing unread".
    expect(DAEMON_MODE_IN_PROCESS_CHANNELS.has('agent:unreadSessions')).toBe(true)
  })

  it('agrees with the routing matrix', () => {
    for (const channel of DAEMON_MODE_IN_PROCESS_CHANNELS) {
      if (channel === 'agent:setCwd') continue // window selection only; see the gate's comment
      expect(routeOf(channel), `${channel} runs in-process but is not routed to main`).toBe('main')
    }
    for (const channel of DAEMON_MODE_SERVED_CHANNELS) {
      expect(routeOf(channel), `${channel} is answered by the daemon but is not in the matrix`).toBeDefined()
      expect(routeOf(channel)).not.toBe('main')
    }
  })

  it('runs every main-routed channel in-process, so window and client work is not refused', () => {
    // desktopRemote:list is polled every second by the remote-hosts view; refusing it
    // filled the main log and showed the App's own saved hosts as unavailable.
    const refused = routing
      .filter((row) => row.route === 'main' && !DAEMON_MODE_IN_PROCESS_CHANNELS.has(row.channel))
      .map((row) => row.channel)
    expect(refused).toEqual([])
    expect(gateDaemonChannel('desktopRemote:list', vi.fn(), on)).not.toThrow()
  })

  it('forwards a migrated channel to the daemon with the renderer arguments, not to main', async () => {
    const listener = vi.fn(() => 'in-process answer')
    const forwarded = vi.fn(async (_call: unknown) => ['from-daemon'])
    const uninstall = installDaemonChannelForwarder(forwarded)
    try {
      const gated = gateDaemonChannel('agent:listSessions', listener, on) as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>
      await expect(gated({}, { providerId: 'codex', cwd: '/w' })).resolves.toEqual(['from-daemon'])
      expect(forwarded).toHaveBeenCalledWith({ op: 'sessionStore', method: 'listSessions', args: [{ providerId: 'codex', cwd: '/w' }], read: true })
      expect(listener).not.toHaveBeenCalled()
    } finally {
      uninstall()
    }
  })

  it('reports a migrated channel as unavailable until the daemon client is ready', async () => {
    const listener = vi.fn()
    const gated = gateDaemonChannel('agent:listProjects', listener, on) as unknown as (event: unknown) => Promise<unknown>
    await expect(gated({})).rejects.toThrow('daemon_capability_unavailable:agent:listProjects')
    expect(listener).not.toHaveBeenCalled()
  })

  it('records every migrated channel under the op and method the matrix names', () => {
    for (const [channel, { op, method }] of Object.entries(DAEMON_LOCAL_OP_CHANNELS)) {
      const row = routing.find((entry) => entry.channel === channel)
      expect(row?.op, channel).toBe(op)
      expect(row?.method, channel).toBe(method)
      expect(method).toBe(channel.slice(channel.lastIndexOf(':') + 1))
    }
  })
})
