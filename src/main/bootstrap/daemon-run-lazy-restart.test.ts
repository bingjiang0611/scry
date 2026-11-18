import { describe, expect, it, vi } from 'vitest'
import { createLazyDaemonRunSurface } from './daemon-run-lazy'
import type { DaemonRunModeDeps, DaemonRunModeResult } from './daemon-run-mode'

// B4-S S0-1: the «后台服务» actions replace the session's daemon decision only when the
// user asked (restart, reconnect), and nothing launches a daemon while one is being
// stopped, not even a retried read through the run mode's own reconnect.

function baseDeps(launch: DaemonRunModeDeps['launch']): DaemonRunModeDeps {
  return {
    userDataDir: '/tmp/user', daemonStateDirectory: '/tmp/state', appVersion: '2.0.0',
    credentialCipher: () => ({ ok: false, reason: 'unused' }),
    send: () => {}, currentCwd: () => '/w',
    ...(launch ? { launch } : {})
  }
}

describe('lazy daemon surface: restart and held launches', () => {
  it('keeps a version mismatch for the session until restart() asks again', async () => {
    const dispose = vi.fn()
    const outcomes: DaemonRunModeResult[] = [
      { status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon', dispose },
      { status: 'ready' }
    ]
    const create = vi.fn(async () => outcomes.shift()!)
    const lazy = createLazyDaemonRunSurface(baseDeps(undefined), create)
    expect((await lazy.ready()).status).toBe('version-mismatch')
    expect((await lazy.ready()).status).toBe('version-mismatch')
    expect(create).toHaveBeenCalledTimes(1)
    expect((await lazy.restart()).status).toBe('ready')
    expect(create).toHaveBeenCalledTimes(2)
    // The mismatched client is closed, not left holding a socket.
    expect(dispose).toHaveBeenCalledTimes(1)
    expect((await lazy.ready()).status).toBe('ready')
    lazy.dispose()
  })

  it('tells observers each outcome it connects to by itself, never the outcome of restart()', async () => {
    const outcomes: DaemonRunModeResult[] = [
      { status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon' },
      { status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon' },
      { status: 'unavailable', reason: 'daemon_ready_timeout' },
      { status: 'ready' }
    ]
    const lazy = createLazyDaemonRunSurface(baseDeps(undefined), vi.fn(async () => outcomes.shift()!))
    const seen: string[] = []
    const stop = lazy.onOutcome((result) => { seen.push(result.status) })
    lazy.onOutcome(() => { throw new Error('an observer failing must not break the run surface') })
    await lazy.ready()
    await lazy.ready()
    // Remembered for the session: no second connect, no second notice.
    expect(seen).toEqual(['version-mismatch'])
    // A restart the user asked for reports through its own action, not here.
    expect((await lazy.restart()).status).toBe('version-mismatch')
    expect(seen).toEqual(['version-mismatch'])
    expect((await lazy.restart()).status).toBe('unavailable')
    // `unavailable` is asked again on the next call: that connect is the surface's own.
    expect((await lazy.ready()).status).toBe('ready')
    expect(seen).toEqual(['version-mismatch', 'ready'])
    stop()
    lazy.dispose()
  })

  it('refuses launches while held, for every mode it builds, and launches again once released', async () => {
    const launch = vi.fn(async () => ({ status: 'started' as const }))
    let seen: DaemonRunModeDeps | undefined
    const lazy = createLazyDaemonRunSurface(baseDeps(launch), async (deps) => { seen = deps; return { status: 'unavailable', reason: 'x' } })
    await lazy.ready()
    const release = lazy.holdLaunches()
    await expect(seen!.launch!()).resolves.toEqual({ status: 'failed', reason: 'daemon_stopping' })
    const second = lazy.holdLaunches()
    release()
    // Two holders: still held until both release.
    await expect(seen!.launch!()).resolves.toEqual({ status: 'failed', reason: 'daemon_stopping' })
    second()
    second()
    await expect(seen!.launch!()).resolves.toEqual({ status: 'started' })
    expect(launch).toHaveBeenCalledTimes(1)
    lazy.dispose()
  })
})
