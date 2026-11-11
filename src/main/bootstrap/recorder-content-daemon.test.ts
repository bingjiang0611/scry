import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_LOCAL_OP_NAMES, gateDaemonChannel, installDaemonChannelForwarder } from '../daemon-channel-gate'
import { installRecorderContentWindowCwd } from './recorder-content-daemon'

// Daemon mode: recorder content is read in the daemon, for the workspace this window
// selected (agent:setCwd, kept in main). The App appends that selection to the request;
// the daemon re-validates it against its own project authority (host-process-queries-2).

const ON = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv
const REF = { sha256: 'a'.repeat(64), bytes: 4, encoding: 'utf8' }
type Gated = (event: unknown, ...args: unknown[]) => Promise<unknown>

describe('recorder content in daemon mode', () => {
  const undo: Array<() => void> = []
  afterEach(() => { for (const step of undo.splice(0)) step() })

  function gated(windowCwd: () => string | undefined, reply: (call: { args: unknown[] }) => unknown = () => ({ page: true })) {
    const forwarded = vi.fn(async (call: { op: string; method: string; args: unknown[]; read: boolean }) => reply(call))
    const listener = vi.fn()
    undo.push(installDaemonChannelForwarder(forwarded), installRecorderContentWindowCwd(windowCwd))
    return { forwarded, listener, read: gateDaemonChannel('agent:recorderContentPage', listener, ON) as unknown as Gated }
  }

  it('sends the window workspace with the request, and nothing the renderer added', async () => {
    const { forwarded, listener, read } = gated(() => '/projects/app')
    await expect(read({}, { ref: REF }, '/projects/other', 'more')).resolves.toEqual({ page: true })
    expect(forwarded).toHaveBeenCalledExactlyOnceWith({ op: 'recorderContent', method: 'recorderContentPage', args: [{ ref: REF }, '/projects/app'], read: true })
    expect(listener).not.toHaveBeenCalled()
  })

  it('refuses a recorder read before sending when the window has no workspace', async () => {
    const { forwarded, listener, read } = gated(() => undefined)
    await expect(read({}, { ref: REF }, '/projects/other')).rejects.toThrow('recorder_workspace_unavailable')
    expect(forwarded).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('sends a trace read without a workspace as main reads it: the empty bucket', async () => {
    // In process an app-trace read with no selection reads the '' bucket; the daemon does the same.
    const { forwarded, read } = gated(() => undefined)
    await read({}, { source: 'app-trace', ref: REF })
    expect(forwarded.mock.calls[0]![0].args).toEqual([{ source: 'app-trace', ref: REF }, ''])
  })

  it('refuses an answer when the selection changed while the daemon read', async () => {
    let cwd = '/projects/app'
    const { read } = gated(() => cwd, () => { cwd = '/projects/other'; return { page: true } })
    await expect(read({}, { ref: REF })).rejects.toThrow('recorder_workspace_changed')
  })

  it('forwards the command catalog as a local op and keeps an unavailable envelope', async () => {
    const envelope = { providerId: 'codex', mode: 'read', state: 'unavailable', data: null, reason: 'not running', observedAt: 1 }
    const forwarded = vi.fn(async () => envelope)
    undo.push(installDaemonChannelForwarder(forwarded))
    const listener = vi.fn()
    const list = gateDaemonChannel('agent:listCommands', listener, ON) as unknown as Gated
    await expect(list({}, { providerId: 'codex', cwd: '/w' })).resolves.toBe(envelope)
    expect(forwarded).toHaveBeenCalledWith({ op: 'providerCommands', method: 'listCommands', args: [{ providerId: 'codex', cwd: '/w' }], read: true })
    expect(listener).not.toHaveBeenCalled()
  })

  it('names no local op after a device op, so paired devices keep theirs', () => {
    // The dispatcher answers local op names before device ops and refuses them on the
    // network endpoint: a local op called `commands` would take the device catalog away.
    // The same reading of the dispatch chain as scripts/daemon-ipc-matrix.mjs protocolOps().
    const device = new Set(['inner-mtls-dispatch.ts', 'inner-mtls-history-dispatch.ts'].flatMap((file) =>
      [...readFileSync(new URL(`../remote/${file}`, import.meta.url), 'utf8').matchAll(/request\.op === '([a-zA-Z0-9]+)'/g)].map(([, op]) => op)))
    expect(device.has('commands')).toBe(true)
    expect([...DAEMON_LOCAL_OP_NAMES].filter((op) => device.has(op))).toEqual([])
  })
})
