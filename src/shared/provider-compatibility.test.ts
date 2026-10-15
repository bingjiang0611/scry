import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  isNewerManifest,
  normalizeProviderVersion,
  parseCompatibilityManifest,
  parseSemver,
  resolveProviderCompatibility,
  satisfiesRange,
  type ProviderCompatibilityManifest
} from './provider-compatibility'

const manifest: ProviderCompatibilityManifest = {
  schemaVersion: 1,
  updatedAt: '2026-10-01T00:00:00.000Z',
  policies: [
    {
      provider: 'codex',
      recommendedRange: '>=0.160.0',
      rules: [
        { range: '>=0.160.0', status: 'supported' },
        { range: '>=0.150.0 <0.160.0', status: 'graceful', note: '缺少 rollout 用量字段' },
        { range: '>=0.100.0 <0.150.0', status: 'unsupported' },
        { range: '<0.100.0', status: 'broken' }
      ]
    },
    { provider: 'pi', scryRange: '>=9.0.0', rules: [{ range: '>=0.1.0', status: 'supported' }] }
  ]
}

describe('semver 子集', () => {
  it('解析并比较版本，预发布版本低于正式版', () => {
    expect(parseSemver('1.2')).toEqual({ major: 1, minor: 2, patch: 0, prerelease: null })
    expect(parseSemver('nope')).toBeNull()
    expect(compareSemver(parseSemver('1.2.3')!, parseSemver('1.2.10')!)).toBeLessThan(0)
    expect(compareSemver(parseSemver('1.2.3-rc.1')!, parseSemver('1.2.3')!)).toBeLessThan(0)
    expect(compareSemver(parseSemver('1.2.3-rc.2')!, parseSemver('1.2.3-rc.10')!)).toBeLessThan(0)
  })

  it('空格取交集，|| 取并集', () => {
    expect(satisfiesRange('0.155.0', '>=0.150.0 <0.160.0')).toBe(true)
    expect(satisfiesRange('0.160.0', '>=0.150.0 <0.160.0')).toBe(false)
    expect(satisfiesRange('2.0.0', '<1.0.0 || >=2.0.0')).toBe(true)
  })

  it('无法求值时返回 null，而不是 false', () => {
    expect(satisfiesRange('1.0.0', '~1.0.0')).toBeNull()
    expect(satisfiesRange('not-a-version', '>=1.0.0')).toBeNull()
  })

  it('从混杂输出里规整版本号，取不到就返回 null', () => {
    expect(normalizeProviderVersion('codex-cli 0.160.1')).toBe('0.160.1')
    expect(normalizeProviderVersion('agy_acp_server_1.2.3')).toBe('1.2.3')
    expect(normalizeProviderVersion('2026.01.02-a1b2c3')).toBe('2026.01.02-a1b2c3')
    expect(normalizeProviderVersion('unknown build')).toBeNull()
    expect(normalizeProviderVersion(undefined)).toBeNull()
  })
})

describe('manifest 校验', () => {
  it('接受合法 manifest', () => {
    expect(parseCompatibilityManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
  })

  it('拒绝非法 manifest 而不是局部吞掉', () => {
    const invalidStatus = { ...manifest, policies: [{ provider: 'codex', rules: [{ range: '>=1.0.0', status: 'maybe' }] }] }
    const invalidRange = { ...manifest, policies: [{ provider: 'codex', rules: [{ range: '~1.0.0', status: 'supported' }] }] }
    const unknownProvider = { ...manifest, policies: [{ provider: 'cursor', rules: [{ range: '>=1.0.0', status: 'supported' }] }] }
    expect(parseCompatibilityManifest(invalidStatus)).toBeNull()
    expect(parseCompatibilityManifest(invalidRange)).toBeNull()
    expect(parseCompatibilityManifest(unknownProvider)).toBeNull()
    expect(parseCompatibilityManifest({ ...manifest, schemaVersion: 2 })).toBeNull()
    expect(parseCompatibilityManifest({ ...manifest, updatedAt: 'soon' })).toBeNull()
  })

  it('按 updatedAt 择新', () => {
    const newer = { ...manifest, updatedAt: '2026-10-02T00:00:00.000Z' }
    expect(isNewerManifest(newer, manifest)).toBe(true)
    expect(isNewerManifest(manifest, newer)).toBe(false)
    expect(isNewerManifest(manifest, undefined)).toBe(true)
  })
})

describe('兼容性判定', () => {
  const resolve = (version: string | undefined, provider: 'codex' | 'pi' = 'codex', scryVersion = '0.2.186') =>
    resolveProviderCompatibility({ manifest, source: 'bundled', provider, version, scryVersion })

  it('四档状态按声明顺序命中', () => {
    expect(resolve('codex-cli 0.160.1').status).toBe('supported')
    expect(resolve('0.155.0')).toMatchObject({ status: 'graceful', reason: '缺少 rollout 用量字段' })
    expect(resolve('0.120.0').status).toBe('unsupported')
    expect(resolve('0.1.0').status).toBe('broken')
  })

  it('版本号无法解析时是 unknown，不会冒充 supported', () => {
    const advisory = resolve('codex nightly')
    expect(advisory.status).toBe('unknown')
    expect(advisory.observedVersion).toBeNull()
    expect(advisory.reason).toContain('无法从版本输出中解析版本号')
    expect(resolve(undefined).reason).toBe('未探测到 CLI 版本')
  })

  it('没有适用策略时是 unknown，并说明原因', () => {
    expect(resolve('1.0.0', 'pi')).toMatchObject({
      status: 'unknown',
      reason: '没有适用于 Scry 0.2.186 的 pi 兼容性策略'
    })
    // scryRange 命中时同一条策略生效
    expect(resolve('1.0.0', 'pi', '9.1.0').status).toBe('supported')
  })

  it('建议里带上出处与推荐范围，便于复核', () => {
    expect(resolve('0.160.1')).toMatchObject({
      source: 'bundled',
      manifestUpdatedAt: '2026-10-01T00:00:00.000Z',
      recommendedRange: '>=0.160.0',
      matchedRange: '>=0.160.0',
      observedVersion: '0.160.1'
    })
  })
})
