import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteHostServiceDependencies } from '../remote/remote-host-service'
import { ReverseTunnelTransport } from '../remote/relay-client'
import { createRelayConnect } from '../remote/relay-connect'
import { createRelayConnectWS } from '../remote/relay-connect-ws'
import { ensureHostIdentity } from '../remote/host-identity'
import { ensureRelayCredential } from '../remote/relay-credential'
import { DEFAULT_PUBLIC_RELAY_WS } from '../remote/remote-defaults'

export type RemoteRelayResolution = Pick<RemoteHostServiceDependencies, 'createTransport' | 'relayAdvertisement'>

function createRemoteWssResolution(endpoint: URL, token: string, enroll: boolean): RemoteRelayResolution {
  const url = endpoint.origin
  const createTransport: RemoteHostServiceDependencies['createTransport'] = (ctx) => {
    const { connect, readyEvent } = createRelayConnectWS({ url, hostId: ctx.hostId, token, enroll, mode: ctx.mode })
    // A paired phone keeps up to four persistent run lanes (control, live watch,
    // live-run status, bulk history), so keep four warm run legs; recycle idle legs every 55 s.
    return new ReverseTunnelTransport({ connect, readyEvent, poolSize: ctx.mode === 'run' ? 4 : 2, idleLegMs: 55_000 })
  }
  return {
    createTransport,
    relayAdvertisement: {
      host: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'wss:' ? 443 : 80,
      tls: endpoint.protocol === 'wss:' ? 'system' : 'plaintext'
    }
  }
}

export async function resolveRemoteRelay(stateDirectory: string): Promise<RemoteRelayResolution> {
  // An SSH-only host need not dial any public relay. This never disables the
  // inner device authentication or changes the existing packaged default.
  if (process.env.SCRY_REMOTE_RELAY_ENABLED === '0') return {}
  // An explicit Cloudflare-compatible relay takes precedence.
  //   SCRY_REMOTE_RELAY_WS = { "url": "wss://relay.example", "token": "..." }
  const wsRaw = process.env.SCRY_REMOTE_RELAY_WS
  if (wsRaw) {
    let wsCfg: { url?: unknown; token?: unknown }
    try { wsCfg = JSON.parse(wsRaw) } catch { console.warn('[scry] SCRY_REMOTE_RELAY_WS is not valid JSON; remote relay disabled'); return {} }
    if (typeof wsCfg.url !== 'string' || typeof wsCfg.token !== 'string' || wsCfg.token.length === 0) {
      console.warn('[scry] SCRY_REMOTE_RELAY_WS missing url/token; remote relay disabled')
      return {}
    }
    let endpoint: URL
    try { endpoint = new URL(wsCfg.url) } catch { console.warn('[scry] SCRY_REMOTE_RELAY_WS url is invalid; remote relay disabled'); return {} }
    if (!['wss:', 'ws:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      console.warn('[scry] SCRY_REMOTE_RELAY_WS url must be a root ws/wss origin without credentials; remote relay disabled')
      return {}
    }
    return createRemoteWssResolution(endpoint, wsCfg.token, false)
  }

  // Legacy raw TCP remains explicit-only because it has no device-facing WSS
  // advertisement. A malformed explicit override fails closed instead of
  // silently falling back to Scry's public infrastructure.
  const raw = process.env.SCRY_REMOTE_RELAY
  if (raw) {
    let cfg: { host?: unknown; port?: unknown; token?: unknown; tls?: unknown; caPath?: unknown }
    try { cfg = JSON.parse(raw) } catch { console.warn('[scry] SCRY_REMOTE_RELAY is not valid JSON; remote relay disabled'); return {} }
    if (typeof cfg.host !== 'string' || typeof cfg.port !== 'number' || typeof cfg.token !== 'string') {
      console.warn('[scry] SCRY_REMOTE_RELAY missing host/port/token; remote relay disabled')
      return {}
    }
    const host = cfg.host, port = cfg.port, token = cfg.token
    const tls = cfg.tls === true
      ? { ca: typeof cfg.caPath === 'string' ? readFileSync(cfg.caPath, 'utf8') : undefined, servername: host }
      : undefined
    return {
      createTransport: (ctx) => {
        const { connect, readyEvent } = createRelayConnect({ host, port, hostId: ctx.hostId, token, mode: ctx.mode, tls })
        return new ReverseTunnelTransport({ connect, readyEvent })
      }
    }
  }

  const endpoint = new URL(DEFAULT_PUBLIC_RELAY_WS)
  const identity = await ensureHostIdentity(join(stateDirectory, 'identity'))
  const token = ensureRelayCredential(join(stateDirectory, 'relay'), identity.hostId)
  return createRemoteWssResolution(endpoint, token, true)
}
