import { describe, expect, it } from 'vitest'
import { sanitizeMcpAuthError } from './mcp-auth-security'

describe('sanitizeMcpAuthError', () => {
  it('redacts OAuth callback values, authorization headers, and assigned secrets', () => {
    const result = sanitizeMcpAuthError(new Error(
      'Bearer abc.def-ghi callback=https://127.0.0.1/cb?code=secret-code&state=secret-state' +
      '&access_token=secret-access#client_secret=secret-client API_KEY="secret-key" refresh_token:secret-refresh\n' +
      'refreshToken=camel-refresh accessToken: camel-access authorizationCode=auth-code state=plain-state\n' +
      'Cookie: sid=AAA; refresh=BBB\nAuthorization: Custom AAA BBB'
    ))

    expect(result).not.toContain('abc.def-ghi')
    expect(result).not.toContain('secret-code')
    expect(result).not.toContain('secret-state')
    expect(result).not.toContain('secret-access')
    expect(result).not.toContain('secret-client')
    expect(result).not.toContain('secret-key')
    expect(result).not.toContain('secret-refresh')
    expect(result).not.toContain('camel-refresh')
    expect(result).not.toContain('camel-access')
    expect(result).not.toContain('auth-code')
    expect(result).not.toContain('plain-state')
    expect(result).not.toContain('sid=AAA')
    expect(result).not.toContain('refresh=BBB')
    expect(result).not.toContain('Custom AAA BBB')
    expect(result).toContain('Bearer [redacted]')
    expect(result).toContain('code=[redacted]')
    expect(result).toContain('API_KEY=[redacted]')
    expect(result).toContain('refreshToken=[redacted]')
    expect(result).toContain('authorizationCode=[redacted]')
    expect(result).toContain('Cookie: [redacted]')
    expect(result).toContain('Authorization: [redacted]')
  })

  it('bounds provider diagnostics returned to the renderer', () => {
    expect(sanitizeMcpAuthError('x'.repeat(3_000))).toHaveLength(2_000)
  })
})
