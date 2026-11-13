import type { RemoteStatus } from '../../shared/remote'
import type { RemoteHostService } from '../remote/remote-host-service'
import type { ChannelHandlers } from './startup-channels'

// Pairing and host status as main has always answered them, shared with the daemon,
// which hosts paired devices while it owns runs (B4-L4). The pairing screen lists paired
// devices only: the App's own local-socket grant (scope `local`, daemon mode) is how this
// App reaches its daemon, not a device, and revoking it here would cut the App off. In
// process no such grant exists, so filtering it keeps both modes alike.

export type PairingHost = Pick<RemoteHostService, 'status' | 'beginPairing' | 'confirmPairing' | 'cancelPairing' | 'revokeDevice' | 'authority' |
  'desktopStatus' | 'beginDesktopPairing' | 'disableDesktop'>

function localDeviceIds(host: PairingHost): Set<string> {
  return new Set(host.authority.inspectLocal().grants.filter((grant) => grant.scope === 'local').map((grant) => grant.deviceId))
}

export function pairingChannelHandlers(deps: { host: () => PairingHost | null }) {
  const requireHost = (): PairingHost => {
    const host = deps.host()
    if (!host) throw new Error('远程访问未启用')
    return host
  }
  return {
    'remote:status': (): RemoteStatus => {
      const host = deps.host()
      if (!host) return { enabled: false }
      const status = host.status()
      if (!status.enabled) return status
      const local = localDeviceIds(host)
      return { ...status, devices: status.devices.filter((device) => !local.has(device.deviceId)) }
    },
    'remote:pairing:begin': () => requireHost().beginPairing(),
    'remote:pairing:confirm': (pairingId: unknown, expectedPublicKeySHA256: unknown) => {
      if (typeof pairingId !== 'string' || typeof expectedPublicKeySHA256 !== 'string') throw new Error('无效的配对确认参数')
      return requireHost().confirmPairing(pairingId, expectedPublicKeySHA256)
    },
    'remote:pairing:cancel': (pairingId: unknown) => {
      if (typeof pairingId !== 'string') throw new Error('无效的配对标识')
      return requireHost().cancelPairing(pairingId)
    },
    'remote:device:revoke': (deviceId: unknown) => {
      if (typeof deviceId !== 'string') throw new Error('无效的设备标识')
      const host = requireHost()
      if (localDeviceIds(host).has(deviceId)) throw new Error('这是本机 App 与后台服务的连接，不是已配对设备，不能在这里撤销')
      return host.revokeDevice(deviceId)
    },
    // Desktop access: another desktop App pairing with this host, over its own listeners.
    'remote:desktop:status': () => deps.host()?.desktopStatus() ?? { enabled: false },
    'remote:desktop:invite': () => requireHost().beginDesktopPairing(),
    'remote:desktop:disable': () => requireHost().disableDesktop()
  } satisfies ChannelHandlers
}
