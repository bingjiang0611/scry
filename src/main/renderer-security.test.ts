import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import {
  denyRendererPermissions,
  isAllowedRendererRequest,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  resolveRendererEntryUrl,
  rendererContentSecurityPolicy
} from './renderer-security'

describe('renderer security boundary', () => {
  const fileEntry = 'file:///Applications/Scry.app/Contents/Resources/app.asar/out/renderer/index.html'
  const devEntry = 'http://127.0.0.1:5173/'

  it('denies both permission requests and check-only permission paths', () => {
    let checkHandler: Parameters<Session['setPermissionCheckHandler']>[0] | undefined
    let requestHandler: Parameters<Session['setPermissionRequestHandler']>[0] | undefined
    const rendererSession = {
      setPermissionCheckHandler(handler: Parameters<Session['setPermissionCheckHandler']>[0]) {
        checkHandler = handler
      },
      setPermissionRequestHandler(handler: Parameters<Session['setPermissionRequestHandler']>[0]) {
        requestHandler = handler
      }
    }

    denyRendererPermissions(rendererSession)
    expect(checkHandler?.(null, 'geolocation', fileEntry, {} as never)).toBe(false)
    let granted = true
    requestHandler?.({} as never, 'media', (next) => { granted = next }, {} as never)
    expect(granted).toBe(false)
  })

  it('ignores renderer env overrides when packaged and permits only loopback development origins', () => {
    expect(resolveRendererEntryUrl('https://attacker.invalid/', fileEntry, true)).toBe(fileEntry)
    expect(resolveRendererEntryUrl(devEntry, fileEntry, false)).toBe(devEntry)
    expect(resolveRendererEntryUrl('http://localhost:5173/', fileEntry, false)).toBe('http://localhost:5173/')
    expect(resolveRendererEntryUrl('http://[::1]:5173/', fileEntry, false)).toBe('http://[::1]:5173/')
    expect(() => resolveRendererEntryUrl('https://attacker.invalid/', fileEntry, false)).toThrow('loopback')
    expect(() => resolveRendererEntryUrl('file:///tmp/renderer.html', fileEntry, false)).toThrow('loopback')
  })

  it('trusts only the exact main document while tolerating an in-document hash', () => {
    expect(isTrustedRendererUrl(`${fileEntry}#chat`, fileEntry)).toBe(true)
    expect(isTrustedRendererUrl('https://attacker.invalid/', fileEntry)).toBe(false)
    expect(isTrustedRendererUrl('http://127.0.0.1:5174/', devEntry)).toBe(false)
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/admin', devEntry)).toBe(false)
  })

  it('only opens HTTP(S) links externally', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true)
    expect(isSafeExternalUrl('http://127.0.0.1:3000/')).toBe(true)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
  })

  it('blocks renderer network in production and pins development traffic to one origin', () => {
    expect(isAllowedRendererRequest('https://example.com/image.png', fileEntry)).toBe(false)
    expect(isAllowedRendererRequest('data:image/png;base64,AA==', fileEntry)).toBe(true)
    expect(isAllowedRendererRequest('http://127.0.0.1:5173/src/main.tsx', devEntry)).toBe(true)
    expect(isAllowedRendererRequest('ws://127.0.0.1:5173/', devEntry)).toBe(true)
    expect(isAllowedRendererRequest('http://127.0.0.1:5174/steal', devEntry)).toBe(false)
  })

  it('emits distinct production and exact-origin development CSPs', () => {
    expect(rendererContentSecurityPolicy(fileEntry)).toContain("connect-src 'none'")
    expect(rendererContentSecurityPolicy(fileEntry)).toContain("img-src 'self' data: blob:")
    expect(rendererContentSecurityPolicy(devEntry)).toContain('connect-src \'self\' http://127.0.0.1:5173 ws://127.0.0.1:5173')
  })
})
