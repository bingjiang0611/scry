import { afterEach, describe, expect, it, vi } from 'vitest'
import { gateDaemonChannel, installDaemonChannelForwarder } from '../daemon-channel-gate'
import { installSessionLifecycleDialogs } from './session-lifecycle-daemon'

// Daemon mode: dialogs stay in this window (B4 D2). The App asks before it sends; a "no"
// never reaches the daemon, and an archived purge carries the count the user saw.

const ON = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv
type Call = { op: string; method: string; args: unknown[]; read: boolean }

function wire(answers: { confirm: boolean; confirmSingle?: boolean; windowCwd?: string }, reply: (call: Call) => unknown) {
  const undo: Array<() => void> = []
  const dialogs = { confirm: vi.fn(async () => answers.confirm), notifyFailure: vi.fn(async () => undefined), confirmSingle: answers.confirmSingle ?? true, windowCwd: () => answers.windowCwd }
  undo.push(installSessionLifecycleDialogs(dialogs))
  const forwarder = vi.fn(async (call: Call) => reply(call))
  undo.push(installDaemonChannelForwarder(forwarder))
  const channel = (name: string) => gateDaemonChannel(name, vi.fn(), ON) as unknown as (event: unknown, ...args: unknown[]) => Promise<any>
  return { dialogs, forwarder, channel, dispose: () => { for (const step of undo.splice(0)) step() } }
}

const ref = { providerId: 'codex', cwd: '/w', externalSessionId: 'native-1' }

describe('session lifecycle dialogs in daemon mode', () => {
  let dispose: (() => void) | undefined
  afterEach(() => { dispose?.(); dispose = undefined })

  it('asks before deleting a session, and a no never reaches the daemon', async () => {
    const declined = wire({ confirm: false }, () => ({ ok: true, deleted: [], retained: [], failed: [] }))
    dispose = declined.dispose
    await expect(declined.channel('agent:deleteSession')({}, ref)).resolves.toMatchObject({ ok: false, cancelled: true, reason: 'user_cancelled' })
    expect(declined.dialogs.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: '删除这个历史会话？' }))
    expect(declined.forwarder).not.toHaveBeenCalled()
    declined.dispose()

    const accepted = wire({ confirm: true }, () => ({ ok: false, reason: 'partial_failure', deleted: [], retained: [], failed: [{ store: 'sqlite', error: 'busy' }] }))
    dispose = accepted.dispose
    await expect(accepted.channel('agent:deleteSession')({}, ref)).resolves.toMatchObject({ reason: 'partial_failure' })
    expect(accepted.forwarder).toHaveBeenCalledWith({ op: 'sessionLifecycle', method: 'deleteSession', args: [ref], read: false })
    expect(accepted.dialogs.notifyFailure).toHaveBeenCalledWith(expect.objectContaining({ detail: 'sqlite: busy' }))
  })

  it('does not ask in the owned test App, as in process', async () => {
    const test = wire({ confirm: false, confirmSingle: false }, () => ({ ok: true, deleted: [], retained: [], failed: [] }))
    dispose = test.dispose
    await expect(test.channel('agent:deleteSession')({}, ref)).resolves.toMatchObject({ ok: true })
    expect(test.dialogs.confirm).not.toHaveBeenCalled()
  })

  it('purges archived sessions with the count the user was asked about', async () => {
    const reply = (call: Call) => call.method === 'listArchivedSessions'
      ? [{ cwd: '/w', sessions: [{}, {}] }, { cwd: '', sessions: [{}] }]
      : { ok: true, deleted: 3, failures: [] }
    const accepted = wire({ confirm: true }, reply)
    dispose = accepted.dispose
    await expect(accepted.channel('agent:deleteArchivedSessions')({})).resolves.toMatchObject({ ok: true, deleted: 3 })
    expect(accepted.dialogs.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: '永久删除全部 3 个已存档会话？' }))
    expect(accepted.forwarder).toHaveBeenLastCalledWith({ op: 'sessionPurge', method: 'deleteArchivedSessions', args: [3], read: false })
    accepted.dispose()

    const declined = wire({ confirm: false }, reply)
    dispose = declined.dispose
    await expect(declined.channel('agent:deleteArchivedSessions')({})).resolves.toMatchObject({ cancelled: true, deleted: 0 })
    expect(declined.forwarder).toHaveBeenCalledTimes(1)
  })

  it('says so when the archived set changed after the answer', async () => {
    const changed = wire({ confirm: true }, (call) => call.method === 'listArchivedSessions'
      ? [{ cwd: '/w', sessions: [{}] }]
      : { ok: false, reason: 'catalog_changed', deleted: 0, failures: [] })
    dispose = changed.dispose
    await expect(changed.channel('agent:deleteArchivedSessions')({})).resolves.toMatchObject({ reason: 'catalog_changed' })
    expect(changed.dialogs.notifyFailure).toHaveBeenCalledWith(expect.objectContaining({ message: '已存档会话在确认后有变化，没有删除任何会话' }))
  })

  it('names the window workspace for a fork that has none, and never overrides one', async () => {
    const fork = { providerId: 'codex', sourceSessionId: 'native-1', sourceRunId: 'r', sourceProviderTurnId: 't', sourceForkTurnId: 't' }
    const window = wire({ confirm: true, windowCwd: '/window' }, () => ({ externalSessionId: 'forked' }))
    dispose = window.dispose
    await expect(window.channel('agent:forkSession')({}, fork)).resolves.toEqual({ externalSessionId: 'forked' })
    expect(window.forwarder).toHaveBeenLastCalledWith({ op: 'sessionLifecycle', method: 'forkSession', args: [{ ...fork, cwd: '/window' }], read: false })
    await window.channel('agent:forkSession')({}, { ...fork, cwd: '/explicit' })
    expect(window.forwarder).toHaveBeenLastCalledWith(expect.objectContaining({ args: [{ ...fork, cwd: '/explicit' }] }))
    window.dispose()

    // No selection: sent as it came, as main's handler would have received it.
    const none = wire({ confirm: true }, () => ({ externalSessionId: 'forked' }))
    dispose = none.dispose
    await none.channel('agent:forkSession')({}, fork)
    expect(none.forwarder).toHaveBeenLastCalledWith(expect.objectContaining({ args: [fork] }))
  })
})
