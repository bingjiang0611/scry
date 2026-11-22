import { describe, expect, it } from 'vitest'
import { checkDaemonBeforeSignal } from './userdata-owner'

describe('the check before the App signals the userData holder', () => {
  const holder = { pid: 4001, startedAt: 'linux:b:10', identityKey: '4001:linux:b:10', startedBy: 'x', role: 'daemon' }
  const row = { pid: 4001, ppid: 1, status: 'S', startedAt: 'linux:b:10', identityKey: '4001:linux:b:10', command: 'daemon.js' }

  it('re-verifies record and identity before a signal', () => {
    expect(checkDaemonBeforeSignal(holder, holder, row)).toEqual({ ok: true })
    expect(checkDaemonBeforeSignal(holder, undefined, row)).toEqual({ ok: false, reason: 'lock-released' })
    expect(checkDaemonBeforeSignal(holder, { ...holder, startedAt: 'linux:b:11' }, row)).toEqual({ ok: false, reason: 'lock-changed' })
    expect(checkDaemonBeforeSignal(holder, holder, undefined)).toEqual({ ok: false, reason: 'holder-exited' })
    expect(checkDaemonBeforeSignal(holder, holder, { ...row, status: 'Z' })).toEqual({ ok: false, reason: 'holder-exited' })
    expect(checkDaemonBeforeSignal(holder, holder, { ...row, identityKey: '4001:linux:b:12' })).toEqual({ ok: false, reason: 'identity-changed' })
    expect(checkDaemonBeforeSignal(holder, holder, 'unreadable')).toEqual({ ok: false, reason: 'identity-unreadable' })
    const unrecorded = { ...holder, identityKey: '' }
    expect(checkDaemonBeforeSignal(unrecorded, unrecorded, row)).toEqual({ ok: false, reason: 'identity-unrecorded' })
  })
})
