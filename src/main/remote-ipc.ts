import type { IpcMainInvokeEvent } from 'electron'
import type { RemoteStatus } from '../shared/remote'
import type { RemoteHostService } from './remote/remote-host-service'

/**
 * Trusted-LOCAL remote pairing surface moved verbatim from the main entry
 * module. These handlers are reachable only from the Mac's own renderer; a
 * device never reaches confirm/cancel/revoke, and every handler still validates
 * its identifier before touching the host service.
 */
export function registerRemoteIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  remoteHost: () => RemoteHostService | null
}) {
  const { handleTrusted } = deps
  function requireRemoteHost(): RemoteHostService {
    const host = deps.remoteHost()
    if (!host) throw new Error('远程访问未启用')
    return host
  }

  // Trusted-LOCAL pairing surface. These are only ever driven by the Mac's own
  // renderer (assertTrustedIpcEvent), never by a device; a device reaches only the
  // prove/status transport path, never confirm/cancel/revoke.
  handleTrusted('remote:status', (): RemoteStatus => {
    const host = deps.remoteHost()
    return host ? host.status() : { enabled: false }
  })
  handleTrusted('remote:desktop:status', () => deps.remoteHost()?.desktopStatus() ?? { enabled: false })
  handleTrusted('remote:desktop:invite', () => requireRemoteHost().beginDesktopPairing())
  handleTrusted('remote:desktop:disable', () => requireRemoteHost().disableDesktop())
  handleTrusted('remote:pairing:begin', () => requireRemoteHost().beginPairing())
  handleTrusted('remote:pairing:confirm', (_event, pairingId: unknown, expectedPublicKeySHA256: unknown) => {
    if (typeof pairingId !== 'string' || typeof expectedPublicKeySHA256 !== 'string') throw new Error('无效的配对确认参数')
    return requireRemoteHost().confirmPairing(pairingId, expectedPublicKeySHA256)
  })
  handleTrusted('remote:pairing:cancel', (_event, pairingId: unknown) => {
    if (typeof pairingId !== 'string') throw new Error('无效的配对标识')
    return requireRemoteHost().cancelPairing(pairingId)
  })
  handleTrusted('remote:device:revoke', (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string') throw new Error('无效的设备标识')
    return requireRemoteHost().revokeDevice(deviceId)
  })
}
