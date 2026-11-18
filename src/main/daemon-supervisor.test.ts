import { describe, expect, it, vi } from 'vitest'
import { ensureDaemon } from './daemon-supervisor'

const VERSION = '0.2.237'

// Each scenario is the same question the App asks at startup and after a loss: is
// there a usable daemon on this socket, and if not, what do we do about it?
describe('daemon supervision (L2: probe, adopt, launch, ready)', () => {
  it('adopts a daemon that is already serving and does not launch a second one', async () => {
    const launch = vi.fn(async () => ({ status: 'started' as const }))
    const result = await ensureDaemon({ probe: async () => ({ version: VERSION }), launch, appVersion: VERSION })
    expect(result).toEqual({ status: 'adopted', version: VERSION })
    expect(launch).not.toHaveBeenCalled()
  })

  it('launches, then waits for the daemon to answer before reporting success', async () => {
    let probes = 0
    const launch = vi.fn(async () => ({ status: 'started' as const }))
    const result = await ensureDaemon({
      // Not answering yet on its first two polls: a started process is not a
      // ready one, and reporting "started" before the socket accepts would hand the
      // caller a connection that fails on its first request.
      probe: async () => (++probes < 3 ? undefined : { version: VERSION }),
      launch,
      appVersion: VERSION,
      sleep: async () => {}
    })
    expect(result).toEqual({ status: 'started', version: VERSION })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(probes).toBe(3)
  })

  it('treats a daemon that never answers as unavailable, with a named reason', async () => {
    let clock = 0
    const result = await ensureDaemon({
      probe: async () => undefined,
      launch: async () => ({ status: 'started' }),
      appVersion: VERSION,
      readyTimeoutMs: 1_000,
      sleep: async (ms) => { clock += ms },
      now: () => clock
    })
    expect(result).toEqual({ status: 'unavailable', reason: 'daemon_ready_timeout' })
  })

  it('surfaces the launch failure reason instead of retrying behind the user', async () => {
    const launch = vi.fn(async () => ({ status: 'failed' as const, reason: 'remote_lease_owner_alive' }))
    const result = await ensureDaemon({ probe: async () => undefined, launch, appVersion: VERSION })
    expect(result).toEqual({ status: 'unavailable', reason: 'remote_lease_owner_alive' })
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('refuses a daemon built from other sources and asks the user to restart it', async () => {
    const launch = vi.fn(async () => ({ status: 'started' as const }))
    const result = await ensureDaemon({ probe: async () => ({ version: '0.2.199' }), launch, appVersion: VERSION })
    expect(result).toEqual({ status: 'version-mismatch', running: '0.2.199', expected: VERSION, action: 'restart_daemon' })
    expect(launch).not.toHaveBeenCalled()

    // The same rule applies to the daemon we just started: a mismatch is reported,
    // not hidden behind 'started'.
    const afterLaunch = await ensureDaemon({
      probe: (() => { let n = 0; return async () => (++n === 1 ? undefined : { version: '0.2.199' }) })(),
      launch, appVersion: VERSION, sleep: async () => {}
    })
    expect(afterLaunch).toMatchObject({ status: 'version-mismatch', action: 'restart_daemon' })
  })

  it('refuses a daemon of the same version from another build (A5), and adopts the same build', async () => {
    const launch = vi.fn(async () => ({ status: 'started' as const }))
    const old = 'a'.repeat(64)
    const current = 'b'.repeat(64)
    const result = await ensureDaemon({ probe: async () => ({ version: VERSION, build: old }), launch, appVersion: VERSION, appBuild: current })
    expect(result).toEqual({
      status: 'version-mismatch', running: VERSION, runningBuild: old, expected: VERSION, expectedBuild: current, action: 'restart_daemon'
    })
    // A daemon that reports no build at all is not the same build either.
    expect(await ensureDaemon({ probe: async () => ({ version: VERSION }), launch, appVersion: VERSION, appBuild: current }))
      .toMatchObject({ status: 'version-mismatch', running: VERSION, expectedBuild: current })
    expect(launch).not.toHaveBeenCalled()
    // Control: the same version and build is adopted as before.
    expect(await ensureDaemon({ probe: async () => ({ version: VERSION, build: current }), launch, appVersion: VERSION, appBuild: current }))
      .toEqual({ status: 'adopted', version: VERSION })
  })

  it('treats a probe failure as "not running" rather than an error to show', async () => {
    let probes = 0
    const result = await ensureDaemon({
      probe: async () => { if (++probes === 1) throw new Error('ECONNREFUSED'); return { version: VERSION } },
      launch: async () => ({ status: 'started' }),
      appVersion: VERSION,
      sleep: async () => {}
    })
    expect(result).toEqual({ status: 'started', version: VERSION })
  })

  it('recovers after the daemon is killed: probe fails, launch runs, subscription is re-established', async () => {
    // A kill looks exactly like "not there yet": the socket refuses, so the App must
    // launch again and re-subscribe rather than keep a dead lane open.
    let alive = false
    const probes: number[] = []
    const result = await ensureDaemon({
      probe: async () => { probes.push(1); return alive ? { version: VERSION } : undefined },
      launch: async () => { alive = true; return { status: 'started' } },
      appVersion: VERSION,
      sleep: async () => {}
    })
    expect(result).toEqual({ status: 'started', version: VERSION })
    expect(probes).toHaveLength(2)
  })

  it('adopts the winner when a launch races another starter', async () => {
    let alive = false
    const result = await ensureDaemon({
      probe: (() => { let n = 0; return async () => (++n === 1 ? undefined : (alive ? { version: VERSION } : undefined)) })(),
      launch: async () => { alive = true; return { status: 'already-running' as const } },
      appVersion: VERSION,
      sleep: async () => {}
    })
    expect(result).toEqual({ status: 'started', version: VERSION })
  })
})
