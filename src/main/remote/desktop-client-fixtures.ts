import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureHostIdentity } from './host-identity'
import { generateDesktopDeviceIdentity, type DesktopSshTunnel } from './desktop-transport'
import { DesktopRemoteClient } from './desktop-client'

export const ssh = { hostname: 'desktop.example', username: 'scry', port: 22 }
export const encrypt = (value: string): Buffer => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)
export const decrypt = (value: Buffer): string => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString()

export async function setup(setupOptions: { submitResponse?: () => unknown; intentStatusResponse?: () => unknown; resolveIntentResponse?: () => unknown; unknownIntent?: boolean; providerDiscovery?: boolean; encrypt?: typeof encrypt } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scry-desktop-client-'))
  const identity = await generateDesktopDeviceIdentity()
  const host = await ensureHostIdentity(join(directory, 'host'))
  const pairingId = randomUUID()
  const invitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: host.hostId, anchorPEM: host.caCertificatePEM, pairPort: 2201, runPort: 2202, pairingId, secret: 'pairing-secret', expiresAt: Date.now() + 60_000 })).toString('base64url')}`
  let phase: 'prove' | 'status' = 'prove'
  let tunnelCount = 0
  const tunnelShutdowns: Array<() => void> = []
  const tunnel = (): DesktopSshTunnel => {
    let alive = true
    const stop = (): void => { alive = false }
    tunnelShutdowns.push(stop)
    return { pairPath: `pair-${++tunnelCount}`, runPath: `run-${tunnelCount}`, get alive() { return alive }, close: async () => { stop() } }
  }
  const tlsRequest = vi.fn(async (options: { path: string; request: unknown }): Promise<unknown> => {
    const request = options.request as { operation?: string; requestId?: string; pairingId?: string }
    if (request.operation === 'pair.prove') {
      phase = 'status'
      return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.pending', pairingId, publicKeySHA256: identity.publicKeySHA256 }
    }
    if (request.operation === 'pair.status') {
      const verified = await host.verifyCSR(identity.csrPEM)
      const grant = await host.issue({ ...verified, deviceId: randomUUID() })
      return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.granted', pairingId, deviceId: grant.deviceId, certificatePEM: grant.certificatePEM,
        certificateSHA256: grant.certificateSHA256, expiresAt: grant.expiresAt, scope: 'g0_echo_only' }
    }
    if (phase === 'status' && (request as { op?: string }).op === 'desktop') return { desktop: { kind: 'info', protocol: 1, hostId: host.hostId, execution: 'canonical', ...(setupOptions.providerDiscovery === false ? {} : { providerDiscovery: 2 }) } }
    if ((request as { op?: string }).op === 'providers') return { providers: [{ id: 'claude', label: 'Claude', available: true, permissions: [{ id: 'default', label: 'Default' }] }] }
    if ((request as { op?: string }).op === 'submit') {
      if (setupOptions.submitResponse) return setupOptions.submitResponse()
      throw new Error('network_down')
    }
    if ((request as { op?: string }).op === 'intentStatus' && setupOptions.intentStatusResponse) return setupOptions.intentStatusResponse()
    if ((request as { op?: string }).op === 'intentStatus' && setupOptions.unknownIntent) return { error: 'unknown_intent' }
    if ((request as { op?: string }).op === 'resolveIntent' && setupOptions.resolveIntentResponse) return setupOptions.resolveIntentResponse()
    if ((request as { op?: string }).op === 'poll') return { cursor: 0, minCursor: 0, events: [] }
    return { error: 'unexpected_request' }
  })
  const openTunnel = vi.fn(async (_options: { username: string; hostname: string; port: number; pairPort: number; runPort: number }) => tunnel())
  const client = new DesktopRemoteClient({ directory, encrypt: setupOptions.encrypt ?? encrypt, decrypt }, { generateIdentity: async () => identity, openTunnel, tlsRequest })
  return { directory, host, invitation, client, openTunnel, tlsRequest, phase: () => phase, tunnelCount: () => tunnelCount, dropTunnel: () => tunnelShutdowns.at(-1)!() }
}
