import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySessionSelection, type SessionSelectionTarget } from './session-selection'
import { createHistoryRuntime } from './history-runtime'
import { gateDaemonChannel, installDaemonChannelForwarder } from '../daemon-channel-gate'

function target() {
  const sessionByContext = new Map<string, string>([['codex\0/w', 'stale']])
  const sessionAliasesByContext = new Map<string, Map<string, string>>([['codex\0/w', new Map([['a', 'b']])]])
  const value = {
    dockBadge: { view: vi.fn() },
    isWindowFocused: () => true,
    setCurrentCwd: vi.fn(),
    providerContextKey: (providerId: string, cwd: string) => `${providerId}\0${cwd}`,
    providerSessionKey: (providerId: string, cwd: string, sessionId: string) => `${providerId}\0${cwd}\0${sessionId}`,
    bumpSessionRevision: vi.fn(),
    sessionAliasesByContext,
    sessionByContext
  } satisfies SessionSelectionTarget
  return value
}

const selection = { providerId: 'codex' as const, cwd: '/w', externalSessionId: 'native-1', canResume: true, loadingUnsettledRun: false }

// The window part of a history load, as the in-process loader applied it inline.
describe('session selection', () => {
  it('points the window at the loaded session and resets its revision and aliases', () => {
    const t = target()
    applySessionSelection(t, selection)
    expect(t.dockBadge.view).toHaveBeenCalledWith('codex\0/w\0native-1', true)
    expect(t.setCurrentCwd).toHaveBeenCalledWith('/w')
    expect(t.bumpSessionRevision).toHaveBeenCalledWith('codex\0/w')
    expect(t.sessionAliasesByContext.has('codex\0/w')).toBe(false)
    expect(t.sessionByContext.get('codex\0/w')).toBe('native-1')
  })

  it('keeps revision and aliases while a run for the session settles, and forgets a session it cannot resume', () => {
    const t = target()
    applySessionSelection(t, { ...selection, cwd: '', loadingUnsettledRun: true, canResume: false })
    expect(t.setCurrentCwd).toHaveBeenCalledWith(undefined)
    expect(t.bumpSessionRevision).not.toHaveBeenCalled()
    expect(t.sessionAliasesByContext.has('codex\0/w')).toBe(true)
    expect(t.sessionByContext.has('codex\0')).toBe(false)
  })
})

describe('session history in daemon mode', () => {
  const previous = process.env.SCRY_HOST_DAEMON
  afterEach(() => {
    if (previous === undefined) delete process.env.SCRY_HOST_DAEMON
    else process.env.SCRY_HOST_DAEMON = previous
  })

  it('applies the selection the daemon reports to this window and hands the renderer only the page', async () => {
    process.env.SCRY_HOST_DAEMON = '1'
    const t = target()
    const history = createHistoryRuntime()
    history.register({
      handleTrusted: () => undefined, appSessionStore: (() => ({})) as never, resolveKnownProjectDirectory: (cwd: string) => cwd,
      providerRegistry: {} as never, getRuns: () => ({ unsettledStates: () => [], get: () => undefined }), rememberProject: () => undefined,
      homeDir: '/home', userDataDir: '/user', isShuttingDown: () => false,
      getWindow: () => ({ isFocused: () => true }),
      ...t
    })
    const page = { turns: [], offset: 0, totalTurns: 0, hasOlder: false }
    const uninstall = installDaemonChannelForwarder(async () => ({ page, selection }))
    try {
      const gated = gateDaemonChannel('agent:loadSession', vi.fn(), { SCRY_HOST_DAEMON: '1' }) as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>
      await expect(gated({}, { providerId: 'codex', cwd: '/w', externalSessionId: 'native-1' })).resolves.toBe(page)
      expect(t.setCurrentCwd).toHaveBeenCalledWith('/w')
      expect(t.sessionByContext.get('codex\0/w')).toBe('native-1')
    } finally {
      uninstall()
    }
  })

  it('refuses a daemon answer without the selection instead of showing a page the window does not track', async () => {
    process.env.SCRY_HOST_DAEMON = '1'
    const history = createHistoryRuntime()
    history.register({
      handleTrusted: () => undefined, appSessionStore: (() => ({})) as never, resolveKnownProjectDirectory: (cwd: string) => cwd,
      providerRegistry: {} as never, getRuns: () => ({ unsettledStates: () => [], get: () => undefined }), rememberProject: () => undefined,
      homeDir: '/home', userDataDir: '/user', isShuttingDown: () => false,
      getWindow: () => null, ...target()
    })
    const uninstall = installDaemonChannelForwarder(async () => ({ page: { turns: [] } }))
    try {
      const gated = gateDaemonChannel('agent:loadSession', vi.fn(), { SCRY_HOST_DAEMON: '1' }) as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>
      await expect(gated({}, { providerId: 'codex' })).rejects.toThrow('invalid_daemon_response')
    } finally {
      uninstall()
    }
  })
})
