import { describe, it, expect } from 'vitest'
import type { RemoteStatus } from '../shared/remote'
import { projectRemote, confirmArguments, shortFingerprint } from './remote-pairing'

const HASH_A = 'a'.repeat(64)

describe('remote-pairing projection (honest states)', () => {
  it('projects disabled as a real state, not an empty-but-ready host', () => {
    expect(projectRemote({ enabled: false })).toEqual({ kind: 'disabled' })
  })

  it('surfaces dormant (relay not configured) truthfully, not as ready', () => {
    const vm = projectRemote({ enabled: true, hostId: 'h', anchorSHA256: HASH_A, relayConfigured: false, pending: [], devices: [] })
    expect(vm.kind).toBe('enabled')
    if (vm.kind !== 'enabled') return
    expect(vm.relayReady).toBe(false)
    expect(vm.relayHint).toContain('手机暂时无法连接')
    expect(vm.hasActionablePending).toBe(false)
  })

  it('only marks a pending device confirmable once it proved a key fingerprint', () => {
    const status: RemoteStatus = {
      enabled: true, hostId: 'h', anchorSHA256: HASH_A, relayConfigured: true,
      pending: [
        { pairingId: 'p-created', state: 'created', expiresAt: 1 },
        { pairingId: 'p-await', state: 'awaiting_local_confirmation', expiresAt: 2, deviceLabel: 'My iPhone', publicKeySHA256: HASH_A }
      ],
      devices: []
    }
    const vm = projectRemote(status)
    if (vm.kind !== 'enabled') throw new Error('expected enabled')
    const created = vm.pending.find((r) => r.pairingId === 'p-created')!
    const awaiting = vm.pending.find((r) => r.pairingId === 'p-await')!
    expect(created.confirmable).toBe(false)
    expect(created.fingerprint).toBeNull()
    expect(awaiting.confirmable).toBe(true)
    expect(awaiting.fingerprint).toBe(HASH_A)
    expect(awaiting.label).toBe('My iPhone')
    expect(vm.hasActionablePending).toBe(true)
  })

  it('omits revoked grants from the currently paired device list', () => {
    const vm = projectRemote({
      enabled: true, hostId: 'h', anchorSHA256: HASH_A, relayConfigured: true, pending: [],
      devices: [
        { deviceId: 'd1', deviceLabel: 'iPhone', expiresAt: 9, confirmedAt: 1, revoked: false },
        { deviceId: 'd2', deviceLabel: 'Old iPad', expiresAt: 9, confirmedAt: 1, revoked: true }
      ]
    })
    if (vm.kind !== 'enabled') throw new Error('expected enabled')
    expect(vm.devices.map((d) => [d.deviceId, d.statusText])).toEqual([
      ['d1', '已配对']
    ])
  })

  it('confirmArguments passes back the exact proven fingerprint and fails closed otherwise', () => {
    const vm = projectRemote({
      enabled: true, hostId: 'h', anchorSHA256: HASH_A, relayConfigured: true,
      pending: [
        { pairingId: 'p1', state: 'awaiting_local_confirmation', expiresAt: 2, publicKeySHA256: HASH_A },
        { pairingId: 'p2', state: 'created', expiresAt: 2 }
      ],
      devices: []
    })
    if (vm.kind !== 'enabled') throw new Error('expected enabled')
    expect(confirmArguments(vm.pending.find((r) => r.pairingId === 'p1')!)).toEqual({ pairingId: 'p1', publicKeySHA256: HASH_A })
    expect(() => confirmArguments(vm.pending.find((r) => r.pairingId === 'p2')!)).toThrow('pairing_row_not_confirmable')
  })

  it('shortens a full digest for eyeball comparison and leaves non-digests intact', () => {
    expect(shortFingerprint(HASH_A)).toBe('AAAA AAAA AAAA AAAA')
    expect(shortFingerprint('not-a-hash')).toBe('not-a-hash')
  })

  it('projects approvedVia truthfully as App / 命令行 / 未记录 (P5-7)', () => {
    const vm = projectRemote({
      enabled: true, hostId: 'h', anchorSHA256: HASH_A, relayConfigured: true, pending: [],
      devices: [
        { deviceId: 'd-app', deviceLabel: 'Phone A', expiresAt: 9, confirmedAt: 1, revoked: false, approvedVia: 'app' },
        { deviceId: 'd-cli', deviceLabel: 'Phone B', expiresAt: 9, confirmedAt: 1, revoked: false, approvedVia: 'host_cli' },
        { deviceId: 'd-old', deviceLabel: 'Phone C', expiresAt: 9, confirmedAt: 1, revoked: false }
      ]
    })
    if (vm.kind !== 'enabled') throw new Error('expected enabled')
    expect(vm.devices.map((d) => [d.deviceId, (d as { approvedViaText?: string }).approvedViaText])).toEqual([
      ['d-app', '批准方式（记录为）：App'],
      ['d-cli', '批准方式（记录为）：命令行'],
      ['d-old', '批准方式（记录为）：未记录']
    ])
  })
})
