import { describe, expect, it, vi } from 'vitest'
import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import type { HostAdminNotice } from '../../shared/host-admin'
import { DaemonEventPump } from '../daemon-event-pump'
import { validateInfo } from '../remote/desktop-client-capabilities'
import { catalogSnapshot } from '../remote/host-controller-catalog-snapshot'
import { showHostAdminSystemNotification } from './host-admin-notifications'

describe('W11 P5-7: App & paired device host-admin notifications', () => {
  const sampleNotice: HostAdminNotice = {
    id: 'n-1',
    kind: 'device_approved_via_cli',
    ts: 1_700_000_000_000,
    deviceId: '11111111-1111-4111-8111-111111111111',
    deviceLabel: 'Field iPhone',
    pairingId: '22222222-2222-4222-8222-222222222222',
    fingerprintPrefix: 'abcdef0123456789'
  }

  it('shows a native system notification without secrets and focuses/opens devices on click', () => {
    const show = vi.fn()
    const focus = vi.fn()
    const winShow = vi.fn()
    const send = vi.fn()
    let clickHandler: (() => void) | undefined
    class FakeNotification {
      static isSupported = () => true
      constructor(public opts: { title: string; body: string }) {}
      on(event: string, cb: () => void) { if (event === 'click') clickHandler = cb }
      show = show
    }
    const win = {
      isDestroyed: () => false,
      show: winShow,
      focus,
      webContents: { send }
    }

    showHostAdminSystemNotification(sampleNotice, {
      getWindow: () => win as never,
      NotificationCtor: FakeNotification as never
    })
    expect(show).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('remote:hostAdmin:notice', sampleNotice)
    expect(clickHandler).toBeTypeOf('function')
    clickHandler!()
    expect(winShow).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('remote:hostAdmin:openDevices', { deviceId: sampleNotice.deviceId })
  })

  it('forwards hostAdmin notices through DaemonEventPump', async () => {
    const received: HostAdminNotice[] = []
    const pump = new DaemonEventPump({
      source: {
        subscribe: async () => ({
          hostId: 'host', logId: 'log', seq: 1, mode: 'snapshot', snapshot: {},
          hints: [{ kind: 'hostNotice', notice: sampleNotice }]
        })
      },
      send: () => undefined,
      onHostAdmin: (notice) => { received.push(notice); pump.dispose() }
    })
    pump.start()
    await vi.waitFor(() => expect(received).toEqual([sampleNotice]))
    pump.dispose()
  })

  it('negotiates hostAdminNotices independently of the v3 version and includes notices in catalogSnapshot', async () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe(3)
    const info = validateInfo({
      desktop: {
        kind: 'info',
        protocol: REMOTE_PROTOCOL_VERSION,
        hostId: 'host-1',
        execution: 'canonical',
        hostAdminNotices: 1
      }
    }, 'host-1')
    expect(info.hostAdminNotices).toBe(1)

    const legacyInfo = validateInfo({
      desktop: { kind: 'info', protocol: REMOTE_PROTOCOL_VERSION, hostId: 'host-1', execution: 'canonical' }
    }, 'host-1')
    expect(legacyInfo.hostAdminNotices).toBeUndefined()

    const snap = await catalogSnapshot({
      authorizeDevice: () => undefined,
      readDesktop: async () => ({
        kind: 'info', protocol: REMOTE_PROTOCOL_VERSION, hostId: 'host-1', execution: 'canonical', hostAdminNotices: 1
      }),
      listProjects: () => [],
      listProviders: () => [],
      listHostAdminNotices: () => [sampleNotice]
    }, 'peer-1', {})
    expect('unchanged' in snap).toBe(false)
    if (!('unchanged' in snap)) {
      expect(snap.hostAdminNoticeItems).toEqual([sampleNotice])
    }
  })
})
