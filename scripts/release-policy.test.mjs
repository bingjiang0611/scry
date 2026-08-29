import { describe, expect, it } from 'vitest'
import { releaseBuildEnvironment } from './release-policy.mjs'

describe('macOS release policy', () => {
  it('allows unsigned development builds but rejects incomplete releases', () => {
    expect(releaseBuildEnvironment({ releaseBuild: false, platform: 'darwin', env: {}, discoveredIdentity: null })).toEqual({})
    expect(() => releaseBuildEnvironment({
      releaseBuild: true, platform: 'darwin', env: {}, discoveredIdentity: null
    })).toThrow('Developer ID')
    expect(() => releaseBuildEnvironment({
      releaseBuild: true,
      platform: 'darwin',
      env: { APPLE_TEAM_ID: 'TEAM' },
      discoveredIdentity: 'Developer ID Application: Example (TEAM)'
    })).toThrow('notarization')
  })

  it('accepts Developer ID plus either supported notarization credential mode', () => {
    expect(releaseBuildEnvironment({
      releaseBuild: true,
      platform: 'darwin',
      discoveredIdentity: 'Developer ID Application: Example (TEAM)',
      env: {
        APPLE_API_KEY: '/tmp/key.p8',
        APPLE_API_KEY_ID: 'KEY',
        APPLE_API_ISSUER: 'ISSUER',
        SCRY_RELEASE_TEAM_ID: 'TEAM'
      }
    })).toMatchObject({ CSC_NAME: 'Developer ID Application: Example (TEAM)' })
    expect(releaseBuildEnvironment({
      releaseBuild: true,
      platform: 'darwin',
      discoveredIdentity: null,
      env: {
        CSC_LINK: 'base64-cert',
        APPLE_ID: 'dev@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'secret',
        APPLE_TEAM_ID: 'TEAM'
      }
    })).toMatchObject({ CSC_LINK: 'base64-cert' })
  })
})
