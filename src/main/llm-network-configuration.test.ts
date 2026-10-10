import { describe, expect, it, vi } from 'vitest'
import { collectLlmNetworkConfiguration, LlmNetworkConfigurationCache } from './llm-network-configuration'

describe('local network configuration', () => {
  it('shares an asynchronous collection for at least 30 seconds', async () => {
    let time = 0
    const config = { observedAt: new Date(0).toISOString(), source: 'app-environment' as const,
      systemProxy: null, environmentProxy: { http: false, https: true, all: false, bypass: false } }
    const collect = vi.fn(async () => config)
    const cache = new LlmNetworkConfigurationCache(collect, () => time)
    const first = cache.read()
    expect(cache.read()).toBe(first)
    expect(await first).toEqual(config)
    time = 29_999
    expect(cache.read()).toBe(first)
    expect(collect).toHaveBeenCalledTimes(1)
    time = 30_000
    await cache.read()
    expect(collect).toHaveBeenCalledTimes(2)
  })

  it('keeps the same in-flight collection and starts the cache lifetime at completion', async () => {
    let time = 0
    const config = { observedAt: new Date(0).toISOString(), source: 'app-environment' as const,
      systemProxy: null, environmentProxy: { http: false, https: false, all: false, bypass: false } }
    let finish!: (value: typeof config) => void
    const collect = vi.fn(() => new Promise<typeof config>(resolve => { finish = resolve }))
    const cache = new LlmNetworkConfigurationCache(collect, () => time)
    const pending = cache.read()
    time = 40_000
    expect(cache.read()).toBe(pending)
    finish(config)
    await pending
    time = 69_999
    expect(cache.read()).toBe(pending)
    expect(collect).toHaveBeenCalledTimes(1)
    time = 70_000
    expect(cache.read()).not.toBe(pending)
    expect(collect).toHaveBeenCalledTimes(2)
    finish(config)
  })

  it('collects only switches and never returns proxy credentials or endpoints', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://private-user:private-secret@private-host:9999')
    try {
      const config = await collectLlmNetworkConfiguration()
      expect(config.environmentProxy.https).toBe(true)
      expect(JSON.stringify(config)).not.toMatch(/private-user|private-secret|private-host|9999/)
      expect(Object.keys(config)).toEqual(['observedAt', 'source', 'systemProxy', 'environmentProxy'])
    } finally { vi.unstubAllEnvs() }
  })
})
