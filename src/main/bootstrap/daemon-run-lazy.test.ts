import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../../shared/trace'
import { DaemonRunError } from '../daemon-run-transport'
import type { DaemonRunSurface } from './daemon-run-surface'
import { createLazyDaemonRunSurface } from './daemon-run-lazy'
import type { DaemonRunModeDeps, DaemonRunModeResult } from './daemon-run-mode'

const deps: DaemonRunModeDeps = {
  userDataDir: '/tmp/user', daemonStateDirectory: '/tmp/state', appVersion: '1.0.0',
  credentialCipher: () => ({ ok: false, reason: 'unused' }),
  send: () => {}, currentCwd: () => '/w'
}

function surface(overrides: Partial<DaemonRunSurface> = {}): DaemonRunSurface {
  return {
    start: async () => ({ runId: 'run-abc-1' }),
    activeRun: async () => null,
    activeRuns: async () => [],
    focusedRunSnapshot: async () => null,
    focusRun: async () => true,
    stop: async () => true,
    answerQuestion: async () => true,
    ack: async () => true,
    resynchronized: async () => true as const,
    steer: async () => ({ status: 'accepted' as const }),
    stopBackgroundTask: async () => ({ status: 'requested' as const, message: '' }),
    adopt: async () => null,
    ...overrides
  }
}

// The daemon can be absent, refused, or restart underneath the App. Each case has one
// honest answer, and only the last one is worth a reconnect.

describe('lazy daemon run surface', () => {
  it('reports the refusal reason instead of pretending the run exists', async () => {
    const lazy = createLazyDaemonRunSurface(deps, async () => ({ status: 'version-mismatch', running: '9', expected: '1', action: 'restart_daemon' }))
    await expect(lazy.activeRuns()).rejects.toThrow('daemon_version_mismatch')
  })

  it('keeps the switch off as a named failure, not an empty run list', async () => {
    const lazy = createLazyDaemonRunSurface(deps, async () => ({ status: 'disabled' }))
    await expect(lazy.activeRun()).rejects.toThrow('daemon_mode_disabled')
  })

  it('reconnects once when the daemon is gone, then serves the call', async () => {
    const first = surface({ activeRuns: async () => { throw new DaemonRunError('daemon_not_running') } })
    const dispose = vi.fn()
    const created: DaemonRunModeResult[] = [
      { status: 'ready', surface: first, dispose },
      { status: 'ready', surface: surface({ activeRuns: async () => [{ runId: 'run-abc-1' } as ActiveRun] }) }
    ]
    const createMode = vi.fn(async () => created.shift()!)
    const lazy = createLazyDaemonRunSurface(deps, createMode)
    await expect(lazy.activeRuns()).resolves.toEqual([{ runId: 'run-abc-1' }])
    expect(createMode).toHaveBeenCalledTimes(2)
    // The dead connection is closed, not left open behind a new one.
    expect(dispose).toHaveBeenCalled()
  })

  it('does not reconnect for a run-level answer', async () => {
    const createMode = vi.fn(async () => ({ status: 'ready' as const, surface: surface({ stop: async () => { throw new DaemonRunError('daemon_stop_not_confirmed') } }) }))
    const lazy = createLazyDaemonRunSurface(deps, createMode)
    await expect(lazy.stop('run-abc-1')).rejects.toMatchObject({ reason: 'daemon_stop_not_confirmed' })
    expect(createMode).toHaveBeenCalledTimes(1)
  })
})
