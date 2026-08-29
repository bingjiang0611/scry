import type { Session } from 'electron'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export function configureRendererPermissions(
  rendererSession: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>,
  rendererEntryUrl: string
): void {
  rendererSession.setPermissionCheckHandler((webContents, permission) => (
    permission === 'notifications' &&
    webContents !== null &&
    isTrustedRendererUrl(webContents.getURL(), rendererEntryUrl)
  ))
  rendererSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'notifications' && isTrustedRendererUrl(webContents.getURL(), rendererEntryUrl))
  })
}

export function resolveRendererEntryUrl(
  envUrl: string | undefined,
  packagedEntryUrl: string,
  packaged: boolean
): string {
  if (packaged || !envUrl) return packagedEntryUrl
  const candidate = new URL(envUrl)
  const loopback = candidate.hostname === 'localhost' || candidate.hostname === '127.0.0.1' || candidate.hostname === '[::1]'
  if ((candidate.protocol !== 'http:' && candidate.protocol !== 'https:') || !loopback) {
    throw new Error('ELECTRON_RENDERER_URL must use an HTTP(S) loopback origin')
  }
  return candidate.href
}

export function isTrustedRendererUrl(actual: string, entry: string): boolean {
  try {
    const actualUrl = new URL(actual)
    const entryUrl = new URL(entry)
    actualUrl.hash = ''
    entryUrl.hash = ''
    return actualUrl.href === entryUrl.href
  } catch {
    return false
  }
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function privateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
}

function mappedIpv4(hostname: string): string | undefined {
  const mapped = hostname.match(/^::ffff:(.+)$/i)?.[1]
  if (!mapped) return undefined
  if (mapped.includes('.')) return mapped
  const words = mapped.split(':').map((word) => Number.parseInt(word, 16))
  if (words.length !== 2 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return undefined
  return `${words[0] >> 8}.${words[0] & 0xff}.${words[1] >> 8}.${words[1] & 0xff}`
}

export function isSensitiveExternalUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::' || hostname === '::1') return true
    const mapped = mappedIpv4(hostname)
    if (mapped) return privateIpv4(mapped)
    if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(hostname) || /^fe[89ab][0-9a-f]:/i.test(hostname)) return true
    return privateIpv4(hostname)
  } catch {
    return false
  }
}

export async function isSensitiveExternalDestination(value: string): Promise<boolean> {
  if (isSensitiveExternalUrl(value)) return true
  let hostname: string
  try { hostname = new URL(value).hostname.replace(/^\[|\]$/g, '') } catch { return false }
  if (isIP(hostname)) return false
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('DNS lookup timeout')), 2_000))
    ])
    return addresses.some(({ address }) => isSensitiveExternalUrl(`http://${isIP(address) === 6 ? `[${address}]` : address}/`))
  } catch {
    // Resolution failure is handled by the browser; do not silently classify it as private.
    return false
  }
}

export function isAllowedRendererRequest(value: string, entry: string): boolean {
  try {
    const request = new URL(value)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(request.protocol)) return true
    const renderer = new URL(entry)
    if (!['http:', 'https:'].includes(renderer.protocol)) return false
    const websocketProtocol = renderer.protocol === 'https:' ? 'wss:' : 'ws:'
    return request.origin === renderer.origin || request.origin === `${websocketProtocol}//${renderer.host}`
  } catch {
    return false
  }
}

export function rendererContentSecurityPolicy(entry: string): string {
  const base = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'"
  ]
  try {
    const renderer = new URL(entry)
    if (renderer.protocol === 'http:' || renderer.protocol === 'https:') {
      const websocketProtocol = renderer.protocol === 'https:' ? 'wss:' : 'ws:'
      base[1] = `script-src 'self' 'unsafe-eval'`
      base.push(`connect-src 'self' ${renderer.origin} ${websocketProtocol}//${renderer.host}`)
      return `${base.join('; ')};`
    }
  } catch {
    // Invalid entries are rejected by URL validation; keep the production policy fail-closed.
  }
  base.push("connect-src 'none'")
  return `${base.join('; ')};`
}
