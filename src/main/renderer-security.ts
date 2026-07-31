import type { Session } from 'electron'

export function denyRendererPermissions(
  rendererSession: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>
): void {
  rendererSession.setPermissionCheckHandler(() => false)
  rendererSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
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
