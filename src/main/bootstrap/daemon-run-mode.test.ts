import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonClientError } from '../daemon-client'
import { DaemonRunError } from '../daemon-run-transport'
import { createDaemonRunMode, daemonModeEnabled, retryAfterReconnect } from './daemon-run-mode'

// The switch has to be boring: absent, the App keeps its in-process pipeline; present,
// either the daemon is usable and owns the runs, or the reason it is not is returned.
// None of these paths may start a second daemon or write a credential it cannot protect.

afterEach(() => { vi.unstubAllEnvs() })

const cipher = () => ({
  ok: true as const,
  encrypt: (value: string) => Buffer.from(value),
  decrypt: (value: Buffer) => value.toString()
})

const base = { userDataDir: '/tmp/scry-user', daemonStateDirectory: '/tmp/scry-state', appVersion: '1.2.3', send: () => {}, currentCwd: () => '/w' }

describe('daemon reconnect policy', () => {
  it('retries a replayable read after the daemon it talked to is gone', () => {
    expect(retryAfterReconnect(new DaemonClientError('daemon_not_running'), true)).toBe(true)
    // The transport relays the same reason wrapped in its own error type.
    expect(retryAfterReconnect(new DaemonRunError('daemon_not_running'), true)).toBe(true)
    expect(retryAfterReconnect(new DaemonRunError('daemon_outcome_unknown'), true)).toBe(true)
  })

  it('never replays a write, and never retries an answer the daemon gave', () => {
    // The already-reported reason for M1: a write whose reply was lost may have been
    // applied, so a retry is a second run, not a recovery.
    expect(retryAfterReconnect(new DaemonRunError('daemon_outcome_unknown'), false)).toBe(false)
    expect(retryAfterReconnect(new DaemonClientError('daemon_not_running'), false)).toBe(false)
    // A refusal or a version mismatch is an answer, not a lost connection.
    expect(retryAfterReconnect(new DaemonClientError('daemon_device_not_authorized'), true)).toBe(false)
    expect(retryAfterReconnect(new DaemonClientError('daemon_version_mismatch'), true)).toBe(false)
  })
})

describe('daemon run mode', () => {
  it('stays off unless the switch is exactly 1', async () => {
    expect(daemonModeEnabled({})).toBe(false)
    expect(daemonModeEnabled({ SCRY_HOST_DAEMON: 'true' })).toBe(false)
    expect(daemonModeEnabled({ SCRY_HOST_DAEMON: '1' })).toBe(true)
    const result = await createDaemonRunMode({ ...base, credentialCipher: cipher })
    expect(result).toEqual({ status: 'disabled' })
  })

  it('refuses before writing a credential it cannot protect', async () => {
    vi.stubEnv('SCRY_HOST_DAEMON', '1')
    const probe = vi.fn()
    const result = await createDaemonRunMode({
      ...base, probe, credentialCipher: () => ({ ok: false, reason: 'basic_text_plaintext_backend' })
    })
    expect(result).toEqual({ status: 'credential-unavailable', reason: 'basic_text_plaintext_backend' })
    // No daemon was contacted at all: the refusal happens before any handshake.
    expect(probe).not.toHaveBeenCalled()
  })

  it('does not talk to a daemon built from other sources', async () => {
    vi.stubEnv('SCRY_HOST_DAEMON', '1')
    const result = await createDaemonRunMode({
      ...base, credentialCipher: cipher,
      probe: async () => ({ version: '9.9.9' }),
      launch: async () => ({ status: 'failed', reason: 'must_not_launch' })
    })
    expect(result).toMatchObject({ status: 'version-mismatch', running: '9.9.9', expected: '1.2.3', action: 'restart_daemon' })
  })

  it('reports a launch that never produces a daemon', async () => {
    vi.stubEnv('SCRY_HOST_DAEMON', '1')
    const result = await createDaemonRunMode({
      ...base, credentialCipher: cipher,
      probe: async () => undefined,
      launch: async () => ({ status: 'failed', reason: 'daemon_binary_missing' })
    })
    expect(result).toEqual({ status: 'unavailable', reason: 'daemon_binary_missing' })
  })

  it('keeps a revoked grant as its own status instead of retrying', async () => {
    vi.stubEnv('SCRY_HOST_DAEMON', '1')
    // A stored credential that the daemon refuses surfaces from the probe; the mode
    // must name it, not fall back to launching a daemon that would refuse again.
    const launch = vi.fn(async () => ({ status: 'failed' as const, reason: 'must_not_launch' }))
    const probe = vi.fn(async () => { throw new DaemonClientError('daemon_device_not_authorized') })
    const result = await createDaemonRunMode({ ...base, credentialCipher: cipher, launch, probe })
    expect(result).toEqual({ status: 'device-not-authorized', reason: 'daemon_device_not_authorized' })
    // The daemon already answered; launching another one would only be refused again.
    expect(launch).not.toHaveBeenCalled()
  })

  it('offers reconnect instead of launching when a live daemon has no secret for an App without a grant (A6)', async () => {
    vi.stubEnv('SCRY_HOST_DAEMON', '1')
    // The App lost daemon-client.json; the daemon that is up answers its enrollment socket
    // but has no secret, because the grant it issued to that credential is still live.
    // Launching cannot change that: the second daemon finds the lock held and exits.
    const launch = vi.fn(async () => ({ status: 'started' as const }))
    const probe = vi.fn(async () => { throw new DaemonClientError('daemon_enrollment_unavailable') })
    const result = await createDaemonRunMode({ ...base, credentialCipher: cipher, launch, probe })
    expect(result).toEqual({ status: 'device-not-authorized', reason: 'daemon_enrollment_unavailable' })
    expect(launch).not.toHaveBeenCalled()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('names the same refusal when it first appears while waiting for a daemon it launched', async () => {
    vi.stubEnv('SCRY_HOST_DAEMON', '1')
    let probes = 0
    const launch = vi.fn(async () => ({ status: 'started' as const }))
    // Not answering at first (absence), then up without a secret: the wait stops there
    // instead of running out as daemon_ready_timeout.
    const probe = vi.fn(async () => {
      probes += 1
      if (probes === 1) return undefined
      throw new DaemonClientError('daemon_enrollment_unavailable')
    })
    const started = Date.now()
    const result = await createDaemonRunMode({ ...base, credentialCipher: cipher, launch, probe })
    expect(result).toEqual({ status: 'device-not-authorized', reason: 'daemon_enrollment_unavailable' })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('still launches when nothing answers at all (control)', async () => {
    vi.stubEnv('SCRY_HOST_DAEMON', '1')
    const launch = vi.fn(async () => ({ status: 'failed' as const, reason: 'daemon_binary_missing' }))
    const probe = vi.fn(async () => { throw new DaemonClientError('daemon_not_running') })
    const result = await createDaemonRunMode({ ...base, credentialCipher: cipher, launch, probe })
    expect(result).toEqual({ status: 'unavailable', reason: 'daemon_binary_missing' })
    expect(launch).toHaveBeenCalledTimes(1)
  })
})
