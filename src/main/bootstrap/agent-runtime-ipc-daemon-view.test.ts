import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../../shared/trace'
import { DockBadgeState } from '../dock-badge'
import type { DaemonRunSurface } from './daemon-run-surface'

const { registerAgentRuntimeHandlers } = await import('./agent-runtime-ipc')

// E1b: focusing or adopting a run views its session and clears its unread mark. The run
// lives in the daemon, and this window must still say so, or a session the user is
// looking at stays unread on the daemon's side.

const RUN = { runId: 'turn-1', providerId: 'codex', cwd: '/w', externalSessionId: 'native-1', userText: '', items: [], done: false } as unknown as ActiveRun

function register(focused: boolean) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const viewed = vi.fn()
  const badge = new DockBadgeState(vi.fn())
  badge.bindDaemon(viewed)
  badge.setDaemon({ revision: 1, unreadSessionKeys: ['key:native-1'] }, false)
  const daemon = {
    focusRun: vi.fn(async () => true),
    focusedRunSnapshot: vi.fn(async () => RUN),
    adopt: vi.fn(async () => RUN)
  } as unknown as DaemonRunSurface
  registerAgentRuntimeHandlers({
    handleTrusted: ((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, listener) }) as never,
    runs: {} as never, dockBadge: badge,
    activeRunSessionKey: (run) => `key:${run.externalSessionId}`,
    getWindow: () => ({ isFocused: () => focused, webContents: { send: vi.fn() } }) as never,
    getCurrentCwd: () => '/w', runTraces: {} as never, daemon
  })
  return { handlers, viewed, badge }
}

describe('daemon mode: showing a run views its session', () => {
  it('clears the daemon unread entry when the focused window focuses the run', async () => {
    const { handlers, viewed, badge } = register(true)
    await expect(handlers.get('agent:focusRun')!({}, 'turn-1')).resolves.toBe(true)
    expect(viewed).toHaveBeenCalledWith('key:native-1')
    expect(badge.count).toBe(0)
  })

  it('does the same when the window adopts the run', async () => {
    const { handlers, viewed } = register(true)
    await expect(handlers.get('agent:adoptActiveRun')!({}, 'turn-1')).resolves.toBe(RUN)
    expect(viewed).toHaveBeenCalledWith('key:native-1')
  })

  it('leaves it unread while the window is not focused', async () => {
    const { handlers, viewed, badge } = register(false)
    await handlers.get('agent:focusRun')!({}, 'turn-1')
    expect(viewed).not.toHaveBeenCalled()
    expect(badge.count).toBe(1)
  })
})

describe('agent:viewSessions: a conversation names the sessions it shows', () => {
  it('views them, and refuses anything but a bounded list of keys', () => {
    const { handlers, viewed, badge } = register(true)
    const view = handlers.get('agent:viewSessions')!
    expect(view({}, { viewId: 'main:c1', main: true, sessionKeys: ['key:native-1'] })).toBe(true)
    expect(viewed).toHaveBeenCalledWith('key:native-1')
    expect(badge.count).toBe(0)
    for (const bad of [
      undefined, ['key'], { viewId: 'main:c1', main: true, sessionKeys: 'key' },
      { viewId: '', main: true, sessionKeys: [] }, { viewId: 'main:c1', sessionKeys: [] },
      { viewId: 'main:c1', main: true, sessionKeys: [''] },
      { viewId: 'main:c1', main: true, sessionKeys: Array.from({ length: 17 }, (_, index) => `k${index}`) }
    ]) expect(() => view({}, bad)).toThrow('invalid_viewed_sessions')
  })
})
