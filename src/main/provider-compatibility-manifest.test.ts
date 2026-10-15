import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_PROVIDER_COMPATIBILITY,
  MANIFEST_RETRY_MS,
  MANIFEST_TTL_MS,
  ProviderCompatibilityStore
} from './provider-compatibility-manifest'
import { parseCompatibilityManifest, type ProviderCompatibilityManifest } from '../shared/provider-compatibility'

const remote: ProviderCompatibilityManifest = {
  schemaVersion: 1,
  updatedAt: '2030-01-01T00:00:00.000Z',
  policies: [{ provider: 'codex', recommendedRange: '>=9.0.0', rules: [{ range: '>=9.0.0', status: 'supported' }] }]
}

const response = (body: unknown, ok = true, status = 200): Response => ({
  ok,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
}) as Response

async function workdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'scry-manifest-'))
}

describe('内置兼容性策略', () => {
  it('自身通过严格校验（发布前就能发现写坏的内置表）', () => {
    expect(parseCompatibilityManifest(JSON.parse(JSON.stringify(BUNDLED_PROVIDER_COMPATIBILITY))))
      .toEqual(BUNDLED_PROVIDER_COMPATIBILITY)
  })

  it('未声明的 Provider 解析为 unknown，不冒充已验证', () => {
    const store = new ProviderCompatibilityStore({ scryVersion: '0.2.186' })
    expect(store.advisory('claude', '1.0.0').status).toBe('unknown')
    expect(store.advisory('codex', 'codex-cli 0.160.1').status).toBe('supported')
  })
})

describe('remote > 磁盘缓存 > 内置', () => {
  it('没有配置远端地址时不发请求，只用内置策略', async () => {
    let calls = 0
    const store = new ProviderCompatibilityStore({
      scryVersion: '0.2.186',
      fetchImpl: async () => { calls += 1; return response(remote) }
    })
    expect(await store.refresh()).toEqual({ outcome: 'kept', reason: 'not_configured' })
    expect(calls).toBe(0)
    expect(store.source).toBe('bundled')
  })

  it('远端更新则采用并写入磁盘缓存', async () => {
    const dir = await workdir()
    const cachePath = join(dir, 'manifest.json')
    const store = new ProviderCompatibilityStore({
      scryVersion: '0.2.186',
      cachePath,
      remoteUrl: 'https://example.invalid/manifest.json',
      fetchImpl: async () => response(remote)
    })
    expect(await store.refresh()).toEqual({ outcome: 'adopted', source: 'remote', updatedAt: remote.updatedAt })
    expect(store.source).toBe('remote')
    expect(store.advisory('codex', '9.1.0').status).toBe('supported')
    // 内置表里 9.1.0 本是 unsupported，证明远端数据真的生效了
    expect(new ProviderCompatibilityStore({ scryVersion: '0.2.186' }).advisory('codex', '9.1.0').status).toBe('unsupported')
    expect(parseCompatibilityManifest(JSON.parse(await readFile(cachePath, 'utf8')))).toEqual(remote)
  })

  it('TTL 内不重复拉取，失败后进入冷却期', async () => {
    let calls = 0
    let now = 1_000_000
    const store = new ProviderCompatibilityStore({
      scryVersion: '0.2.186',
      remoteUrl: 'https://example.invalid/manifest.json',
      now: () => now,
      fetchImpl: async () => { calls += 1; return response(remote) }
    })
    expect((await store.refresh()).outcome).toBe('adopted')
    now += MANIFEST_TTL_MS - 1
    expect(await store.refresh()).toEqual({ outcome: 'kept', reason: 'fresh' })
    expect(calls).toBe(1)
    now += 2
    expect((await store.refresh()).outcome).toBe('kept') // 同一份 updatedAt，不覆盖
    expect(calls).toBe(2)
  })

  it('拉取失败不改变已有策略，并在冷却期内不再重试', async () => {
    let calls = 0
    let now = 1_000_000
    const store = new ProviderCompatibilityStore({
      scryVersion: '0.2.186',
      remoteUrl: 'https://example.invalid/manifest.json',
      now: () => now,
      fetchImpl: async () => { calls += 1; throw new Error('network down') }
    })
    expect(await store.refresh()).toEqual({ outcome: 'failed', reason: 'network down' })
    expect(store.source).toBe('bundled')
    expect(store.advisory('codex', '0.160.1').status).toBe('supported')
    expect(await store.refresh()).toEqual({ outcome: 'kept', reason: 'cooldown' })
    expect(calls).toBe(1)
    now += MANIFEST_RETRY_MS
    expect((await store.refresh()).outcome).toBe('failed')
    expect(calls).toBe(2)
    expect(store.lastError).toBe('network down')
  })

  it('远端返回非法 manifest 时整体拒绝，保留内置策略', async () => {
    const store = new ProviderCompatibilityStore({
      scryVersion: '0.2.186',
      remoteUrl: 'https://example.invalid/manifest.json',
      fetchImpl: async () => response({ schemaVersion: 1, updatedAt: '2030-01-01T00:00:00.000Z', policies: [{ provider: 'codex', rules: [] }] })
    })
    expect((await store.refresh()).outcome).toBe('failed')
    expect(store.source).toBe('bundled')
  })

  it('HTTP 错误码与超大响应都算失败', async () => {
    const httpError = new ProviderCompatibilityStore({
      scryVersion: '0.2.186',
      remoteUrl: 'https://example.invalid/manifest.json',
      fetchImpl: async () => response(remote, false, 503)
    })
    expect(await httpError.refresh()).toEqual({ outcome: 'failed', reason: 'provider manifest HTTP 503' })
    const oversize = new ProviderCompatibilityStore({
      scryVersion: '0.2.186',
      remoteUrl: 'https://example.invalid/manifest.json',
      fetchImpl: async () => response('x'.repeat(256 * 1024 + 1))
    })
    expect(await oversize.refresh()).toEqual({ outcome: 'failed', reason: 'provider manifest exceeds size limit' })
  })

  it('拒绝非 HTTPS 地址', async () => {
    const store = new ProviderCompatibilityStore({
      scryVersion: '0.2.186',
      remoteUrl: 'http://example.invalid/manifest.json',
      fetchImpl: async () => response(remote)
    })
    expect(await store.refresh()).toEqual({ outcome: 'failed', reason: 'provider manifest URL must use HTTPS' })
  })

  it('磁盘缓存比内置新时启动即采用；缓存损坏按不存在处理', async () => {
    const dir = await workdir()
    const cachePath = join(dir, 'manifest.json')
    await writeFile(cachePath, JSON.stringify(remote), 'utf8')
    const store = new ProviderCompatibilityStore({ scryVersion: '0.2.186', cachePath })
    await store.hydrate()
    expect(store.source).toBe('cache')
    expect(store.advisory('codex', '9.1.0').status).toBe('supported')

    const brokenPath = join(dir, 'broken.json')
    await writeFile(brokenPath, '{not json', 'utf8')
    const fallback = new ProviderCompatibilityStore({ scryVersion: '0.2.186', cachePath: brokenPath })
    await fallback.hydrate()
    expect(fallback.source).toBe('bundled')
    expect(fallback.advisory('codex', '0.160.1').status).toBe('supported')
  })

  it('磁盘缓存比内置旧时不降级', async () => {
    const dir = await workdir()
    const cachePath = join(dir, 'manifest.json')
    await writeFile(cachePath, JSON.stringify({ ...remote, updatedAt: '2000-01-01T00:00:00.000Z' }), 'utf8')
    const store = new ProviderCompatibilityStore({ scryVersion: '0.2.186', cachePath })
    await store.hydrate()
    expect(store.source).toBe('bundled')
  })
})
