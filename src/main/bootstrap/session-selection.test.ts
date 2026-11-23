import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySessionSelection, type SessionSelectionTarget } from './session-selection'
import { installDaemonSessionSelection } from './history-daemon'
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

  it('points a window without a session mirror (the App) at the session alone', () => {
    const dockBadge = { view: vi.fn() }
    const setCurrentCwd = vi.fn()
    applySessionSelection({ dockBadge, isWindowFocused: () => false, setCurrentCwd,
      providerContextKey: (providerId, cwd) => `${providerId}\0${cwd}`,
      providerSessionKey: (providerId, cwd, sessionId) => `${providerId}\0${cwd}\0${sessionId}` }, selection)
    expect(dockBadge.view).toHaveBeenCalledWith('codex\0/w\0native-1', false)
    expect(setCurrentCwd).toHaveBeenCalledWith('/w')
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

describe('session history from the daemon', () => {
  let uninstall: Array<() => void> = []
  afterEach(() => { for (const step of uninstall.splice(0)) step() })

  it('applies the selection the daemon reports to this window and hands the renderer only the page', async () => {
    const t = target()
    uninstall.push(installDaemonSessionSelection((selection) => applySessionSelection(t, selection)))
    const page = { turns: [], offset: 0, totalTurns: 0, hasOlder: false }
    uninstall.push(installDaemonChannelForwarder(async () => ({ page, selection })))
    const gated = gateDaemonChannel('agent:loadSession', vi.fn()) as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>
    await expect(gated({}, { providerId: 'codex', cwd: '/w', externalSessionId: 'native-1' })).resolves.toBe(page)
    expect(t.setCurrentCwd).toHaveBeenCalledWith('/w')
    expect(t.sessionByContext.get('codex\0/w')).toBe('native-1')
  })

  it('refuses a daemon answer without the selection instead of showing a page the window does not track', async () => {
    const t = target()
    uninstall.push(installDaemonSessionSelection((selection) => applySessionSelection(t, selection)))
    uninstall.push(installDaemonChannelForwarder(async () => ({ page: { turns: [] } })))
    const gated = gateDaemonChannel('agent:loadSession', vi.fn()) as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>
    await expect(gated({}, { providerId: 'codex' })).rejects.toThrow('invalid_daemon_response')
    expect(t.setCurrentCwd).not.toHaveBeenCalled()
  })
})
