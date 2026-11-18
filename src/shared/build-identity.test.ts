import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIdentity, sameBuild, scryBuildId } from './build-identity'

afterEach(() => { vi.unstubAllGlobals() })

describe('build identity (A5)', () => {
  it('reads the build id electron-vite defines, and nothing that is not one', () => {
    // Unbundled there is no define at all.
    expect(scryBuildId()).toBeUndefined()
    expect(buildIdentity('1.0.0')).toEqual({ version: '1.0.0' })
    vi.stubGlobal('__SCRY_BUILD_ID__', 'c'.repeat(64))
    expect(scryBuildId()).toBe('c'.repeat(64))
    expect(buildIdentity('1.0.0')).toEqual({ version: '1.0.0', build: 'c'.repeat(64) })
    vi.stubGlobal('__SCRY_BUILD_ID__', 'not a build id')
    expect(scryBuildId()).toBeUndefined()
  })

  it('needs the version and the build to match', () => {
    const a = { version: '0.2.237', build: 'a'.repeat(64) }
    expect(sameBuild(a, { ...a })).toBe(true)
    expect(sameBuild(a, { version: '0.2.237', build: 'b'.repeat(64) })).toBe(false)
    expect(sameBuild(a, { version: '0.2.237' })).toBe(false)
    expect(sameBuild({ version: '0.2.237' }, a)).toBe(false)
    expect(sameBuild(a, { version: '0.2.238', build: a.build })).toBe(false)
    expect(sameBuild({ version: '0.2.237' }, { version: '0.2.237' })).toBe(true)
  })
})
