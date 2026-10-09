import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import {
  configureRendererPermissions,
  isAllowedRendererRequest,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  resolveRendererEntryUrl,
  rendererContentSecurityPolicy
} from './renderer-security'

describe('renderer security boundary', () => {
  const fileEntry = 'file:///Applications/Scry.app/Contents/Resources/app.asar/out/renderer/index.html'
  const devEntry = 'http://127.0.0.1:5173/'

  it('只允许受信 renderer 请求通知权限，其余权限继续 fail closed', () => {
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

    configureRendererPermissions(rendererSession, fileEntry)
    expect(checkHandler?.(null, 'geolocation', fileEntry, {} as never)).toBe(false)
    expect(checkHandler?.({ getURL: () => fileEntry } as never, 'notifications', fileEntry, {} as never)).toBe(true)
    expect(checkHandler?.(null, 'notifications', fileEntry, {} as never)).toBe(false)
    expect(checkHandler?.(
      { getURL: () => 'https://attacker.invalid/' } as never,
      'notifications',
      fileEntry,
      {} as never
    )).toBe(false)
    let granted = true
    requestHandler?.({} as never, 'media', (next) => { granted = next }, {} as never)
    expect(granted).toBe(false)
    requestHandler?.({ getURL: () => fileEntry } as never, 'notifications', (next) => { granted = next }, {} as never)
    expect(granted).toBe(true)
    requestHandler?.(
      { getURL: () => 'https://attacker.invalid/' } as never,
      'notifications',
      (next) => { granted = next },
      {} as never
    )
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

  it.each([
    'https://example.com/docs',
    'http://127.0.0.1:4610/',
    'http://localhost:3000/',
    'http://[::1]:3000/',
    'http://[::ffff:7f00:1]:3000/',
    'http://169.254.169.254/latest/meta-data',
    'https://10.0.0.1/admin',
    'https://172.31.0.1/admin',
    'https://192.168.1.1/admin'
  ])('allows HTTP(S) links to open externally: %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(true)
  })

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hello',
    'mailto:user@example.com',
    'not a URL'
  ])('rejects unsafe external links: %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(false)
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
    const devPolicy = rendererContentSecurityPolicy(devEntry)
    expect(devPolicy).toContain('connect-src \'self\' http://127.0.0.1:5173 ws://127.0.0.1:5173')
    expect(devPolicy).toContain("script-src 'self' 'unsafe-eval';")
  })
})
