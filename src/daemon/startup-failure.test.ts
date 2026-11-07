import { describe, expect, it } from 'vitest'
import { classifyDaemonStartupFailure } from './startup-failure'

describe('daemon startup failure classification', () => {
  it.each([
    'remote_lease_owner_alive',
    'remote_lease_identity_unverifiable',
    'daemon_recorder_cli_unavailable'
  ])('stops retrying %s because backing off cannot fix it', (code) => {
    expect(classifyDaemonStartupFailure(new Error(code))).toEqual({ code: 4, reason: code })
  })

  it('keeps an unknown failure retryable and records no machine reason', () => {
    expect(classifyDaemonStartupFailure(new Error('EMFILE: too many open files')))
      .toEqual({ code: 1 })
    expect(classifyDaemonStartupFailure(new Error('daemon_paths_missing: /Users/me/secret')))
      .toEqual({ code: 1 })
  })

  it('never turns a free-form message into a recorded reason', () => {
    expect(classifyDaemonStartupFailure(new Error('remote_lease_owner_alive because /Users/me/secret'))).toEqual({ code: 1 })
    expect(classifyDaemonStartupFailure(undefined)).toEqual({ code: 1 })
  })
})