import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LlmNetworkConfiguration } from '../shared/llm-performance'

const execFileAsync = promisify(execFile)

/** Only allowlisted switches leave this module; URLs, hosts and credentials are discarded. */
export async function collectLlmNetworkConfiguration(): Promise<LlmNetworkConfiguration> {
  const configured = (key: string): boolean => Boolean(process.env[key] || process.env[key.toLowerCase()])
  const environmentProxy = { http: configured('HTTP_PROXY'), https: configured('HTTPS_PROXY'),
    all: configured('ALL_PROXY'), bypass: configured('NO_PROXY') }
  let systemProxy: LlmNetworkConfiguration['systemProxy'] = null
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 64 * 1024 })
      const enabled = (key: string): boolean => new RegExp(`^\\s*${key}\\s*:\\s*1\\s*$`, 'm').test(stdout)
      systemProxy = { http: enabled('HTTPEnable'), https: enabled('HTTPSEnable'), socks: enabled('SOCKSEnable'),
        pac: enabled('ProxyAutoConfigEnable'), discovery: enabled('ProxyAutoDiscoveryEnable') }
    } catch {
      // Optional local observation failed. Null preserves unknown system configuration.
    }
  }
  return { observedAt: new Date().toISOString(),
    source: process.platform === 'darwin' ? 'macos-system-and-app-environment' : 'app-environment',
    systemProxy, environmentProxy }
}

/** Shared in-flight collection and at least 30 seconds between system queries. */
export class LlmNetworkConfigurationCache {
  private pending?: Promise<LlmNetworkConfiguration>
  private expiresAt = -Infinity

  constructor(private readonly collect = collectLlmNetworkConfiguration, private readonly now = Date.now) {}

  read(): Promise<LlmNetworkConfiguration> {
    if (!this.pending || this.now() >= this.expiresAt) {
      this.expiresAt = Infinity
      this.pending = this.collect().then(config => {
        this.expiresAt = this.now() + 30_000
        return config
      })
    }
    return this.pending
  }
}
