import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from '../core/turn-recorder/io.js'
import type { ProviderId } from '../shared/provider'
import {
  isNewerManifest,
  parseCompatibilityManifest,
  resolveProviderCompatibility,
  type ProviderCompatibilityAdvisory,
  type ProviderCompatibilityManifest,
  type ProviderCompatibilitySource
} from '../shared/provider-compatibility'

/** 一小时内复用已取到的 manifest。 */
export const MANIFEST_TTL_MS = 60 * 60_000
/** 拉取失败后的静默期：失败不应变成每次探测都重试的网络抖动源。 */
export const MANIFEST_RETRY_MS = 5 * 60_000
export const MANIFEST_FETCH_TIMEOUT_MS = 10_000
/** 远端 manifest 体积上限，避免一个被劫持或写错的地址拖垮主进程。 */
export const MANIFEST_MAX_BYTES = 256 * 1024

/**
 * 内置兼容性策略。
 *
 * 这是**维护者声明的策略**，不是对每个版本的实测结果；`source`/`manifestUpdatedAt`
 * 会随建议一起暴露，UI 必须按「声明」而非「实测」呈现。没有覆盖到的版本解析为
 * `unknown`，绝不冒充 supported。
 *
 * 当前数据的依据：本机实际安装并由 Scry 真实驱动过的版本标 `supported`；
 * 更高的次版本线尚未验证，按定义标 `unsupported`（未验证，不保证证据完整）；
 * 更低版本没有规则，因此是 `unknown`。远端 manifest 可以在不发版的情况下更新这张表。
 */
export const BUNDLED_PROVIDER_COMPATIBILITY: ProviderCompatibilityManifest = {
  schemaVersion: 1,
  updatedAt: '2026-10-15T00:00:00.000Z',
  policies: [
    {
      provider: 'codex',
      recommendedRange: '>=0.160.1 <0.161.0',
      rules: [
        { range: '>=0.160.1 <0.161.0', status: 'supported', note: 'codex-cli 0.160.1：已在本机真实运行中验证 rollout 证据采集' },
        { range: '>=0.161.0', status: 'unsupported', note: '高于已验证版本线；rollout 字段变化可能让用量或工具证据不完整' }
      ]
    },
    {
      provider: 'pi',
      recommendedRange: '>=0.85.1 <0.86.0',
      rules: [
        { range: '>=0.85.1 <0.86.0', status: 'supported', note: 'pi 0.85.1：已在本机真实运行中验证 JSONL RPC 证据采集' },
        { range: '>=0.86.0', status: 'unsupported', note: '高于已验证版本线；RPC 事件变化可能让证据不完整' }
      ]
    },
    {
      provider: 'qoder',
      recommendedRange: '>=1.1.60 <1.2.0',
      rules: [
        { range: '>=1.1.60 <1.2.0', status: 'unsupported', note: 'qodercli 1.1.60：仅验证过版本探测，未验证完整轮次证据' },
        { range: '>=1.2.0', status: 'unsupported', note: '高于已探测版本线；未验证证据完整性' }
      ]
    },
    {
      provider: 'opencode',
      recommendedRange: '>=1.18.31 <1.19.0',
      rules: [
        { range: '>=1.18.31 <1.19.0', status: 'unsupported', note: 'opencode 1.18.31：仅验证过版本探测，未验证完整轮次证据' },
        { range: '>=1.19.0', status: 'unsupported', note: '高于已探测版本线；未验证证据完整性' }
      ]
    }
  ]
}

export interface ProviderCompatibilityStoreOptions {
  scryVersion: string
  /** 磁盘缓存路径，通常位于 userData；缺省表示不做缓存。 */
  cachePath?: string
  /**
   * 远端 manifest 地址，仅接受 https。缺省表示只用内置策略：Scry 不会在用户没有
   * 配置的情况下发起额外网络请求。
   */
  remoteUrl?: string
  bundled?: ProviderCompatibilityManifest
  fetchImpl?: typeof globalThis.fetch
  now?: () => number
}

export type ProviderCompatibilityRefresh =
  | { outcome: 'adopted'; source: ProviderCompatibilitySource; updatedAt: string }
  | { outcome: 'kept'; reason: 'not_newer' | 'fresh' | 'cooldown' | 'not_configured' }
  | { outcome: 'failed'; reason: string }

/**
 * 按 remote > 磁盘缓存 > 内置的优先级维护一份兼容性策略，并且**永不**把失败传播给
 * Provider 探测：拉取不到就继续用上一份可信数据，兼容性建议退化为 unknown，
 * 而不是让 Provider 变得不可用。
 */
export class ProviderCompatibilityStore {
  readonly #options: ProviderCompatibilityStoreOptions
  readonly #now: () => number
  #manifest: ProviderCompatibilityManifest
  #source: ProviderCompatibilitySource = 'bundled'
  #fetchedAt = 0
  #failedAt = 0
  #lastError: string | null = null
  #pending: Promise<ProviderCompatibilityRefresh> | null = null
  #hydrated: Promise<void> | null = null

  constructor(options: ProviderCompatibilityStoreOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#manifest = options.bundled ?? BUNDLED_PROVIDER_COMPATIBILITY
  }

  get source(): ProviderCompatibilitySource {
    return this.#source
  }

  get manifest(): ProviderCompatibilityManifest {
    return this.#manifest
  }

  /** 最近一次拉取失败的原因；null 表示没有失败。诊断用，不影响判定。 */
  get lastError(): string | null {
    return this.#lastError
  }

  advisory(provider: ProviderId, version: string | undefined | null): ProviderCompatibilityAdvisory {
    return resolveProviderCompatibility({
      manifest: this.#manifest,
      source: this.#source,
      provider,
      version,
      scryVersion: this.#options.scryVersion
    })
  }

  /** 读一次磁盘缓存（进程内只做一次）；缓存损坏按不存在处理。 */
  hydrate(): Promise<void> {
    return this.#hydrated ??= this.#hydrate()
  }

  async #hydrate(): Promise<void> {
    const cached = await this.#readCache()
    if (cached && isNewerManifest(cached, this.#manifest)) {
      this.#manifest = cached
      this.#source = 'cache'
    }
  }

  refresh(): Promise<ProviderCompatibilityRefresh> {
    return this.#pending ??= this.#refresh().finally(() => { this.#pending = null })
  }

  async #refresh(): Promise<ProviderCompatibilityRefresh> {
    const url = this.#options.remoteUrl
    if (!url) return { outcome: 'kept', reason: 'not_configured' }
    const now = this.#now()
    if (this.#source === 'remote' && now - this.#fetchedAt < MANIFEST_TTL_MS) return { outcome: 'kept', reason: 'fresh' }
    if (this.#failedAt && now - this.#failedAt < MANIFEST_RETRY_MS) return { outcome: 'kept', reason: 'cooldown' }
    let fetched: ProviderCompatibilityManifest | null
    try {
      fetched = await this.#fetchRemote(url)
    } catch (error) {
      this.#failedAt = this.#now()
      this.#lastError = error instanceof Error ? error.message : String(error)
      return { outcome: 'failed', reason: this.#lastError }
    }
    if (!fetched) {
      this.#failedAt = this.#now()
      this.#lastError = 'remote manifest rejected by schema validation'
      return { outcome: 'failed', reason: this.#lastError }
    }
    this.#fetchedAt = this.#now()
    this.#failedAt = 0
    this.#lastError = null
    if (!isNewerManifest(fetched, this.#manifest)) {
      this.#source = 'remote'
      return { outcome: 'kept', reason: 'not_newer' }
    }
    this.#manifest = fetched
    this.#source = 'remote'
    await this.#writeCache(fetched)
    return { outcome: 'adopted', source: 'remote', updatedAt: fetched.updatedAt }
  }

  async #fetchRemote(url: string): Promise<ProviderCompatibilityManifest | null> {
    if (new URL(url).protocol !== 'https:') throw new Error('provider manifest URL must use HTTPS')
    const fetchImpl = this.#options.fetchImpl ?? globalThis.fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' })
      if (!response.ok) throw new Error(`provider manifest HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > MANIFEST_MAX_BYTES) throw new Error('provider manifest exceeds size limit')
      return parseCompatibilityManifest(JSON.parse(text) as unknown)
    } finally {
      clearTimeout(timer)
    }
  }

  async #readCache(): Promise<ProviderCompatibilityManifest | null> {
    const path = this.#options.cachePath
    if (!path) return null
    try {
      const text = await readFile(path, 'utf8')
      if (text.length > MANIFEST_MAX_BYTES) return null
      return parseCompatibilityManifest(JSON.parse(text) as unknown)
    } catch {
      // 缓存是加速手段，不是证据：读不出来就当没有。
      return null
    }
  }

  async #writeCache(manifest: ProviderCompatibilityManifest): Promise<void> {
    const path = this.#options.cachePath
    if (!path) return
    try {
      await writeJsonAtomic(path, manifest, { sync: false })
    } catch {
      // 写缓存失败只影响下次启动的起点，不影响本次判定。
    }
  }
}
