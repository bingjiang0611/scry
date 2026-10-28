import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { parseDisabledProviders, ProviderRegistry } from './providers/registry'
import { ProviderCompatibilityStore } from './provider-compatibility-manifest'
import { createBuiltInProviderAdapters } from './providers'
import { createSmokeProviderAdapter } from './providers/smoke'
import { McpExecutionTrust } from './mcp-execution-trust'
import { ProviderOperationGate, providerOperationKey } from './provider-operation-gate'
import { sessionAttentionKey } from '../shared/session-attention'
import type { ProviderId } from '../shared/provider'
import { createProviderTrust } from './provider-trust'
import type { PiAgentProfile } from './pi-agent-profiles'

export function createMainProviderRuntime(deps: {
  homeDir: string
  userData: string
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  version: string
  listPiProfiles: () => Promise<PiAgentProfile[]>
  resolvePiProfile: (id: string) => Promise<PiAgentProfile | undefined>
  providerOperationGate: ProviderOperationGate
  shellEnv: typeof import('./claude-locate').shellEnv
}) {
  const smokeProviderEnabled = process.env.SCRY_ELECTRON_SMOKE_PROVIDER === '1' &&
    process.env.ELECTRON_ENABLE_LOGGING === '1' && process.argv.some((arg) => arg.startsWith('--remote-debugging-port='))
  const smokeProviderIds: Array<'claude' | 'codex' | 'pi'> = process.env.SCRY_ELECTRON_SMOKE_CONVERSATIONS === '1' ? ['codex', 'claude', 'pi'] : ['codex']
  const smokeDetectedAgents = smokeProviderIds.map(id => ({
    id: id === 'pi' ? 'pi:0123456789abcdef' : id,
    name: id === 'pi' ? 'Pi · Rotom Smoke Fixture' : `${id} Smoke Fixture`, bin: id, path: process.execPath
  }))
  const builtInProviderAdapters = smokeProviderEnabled ? smokeProviderIds.map((id) => createSmokeProviderAdapter(id)) : createBuiltInProviderAdapters(
    deps.homeDir,
    join(deps.userData, 'codex-home-v1'),
    join(deps.userData, 'provider-auth', 'opencode'),
    join(deps.userData, 'provider-state', 'opencode-v1'),
    { listProfiles: deps.listPiProfiles, resolveProfile: deps.resolvePiProfile,
      historyExtensionPath: join(deps.isPackaged ? deps.resourcesPath : join(deps.appPath, 'resources'), 'scry-history', 'pi-history-reader.mjs') }
  )
  const providerCompatibility = new ProviderCompatibilityStore({
    scryVersion: deps.version,
    cachePath: join(deps.userData, 'provider-compatibility-v1.json'),
    ...(process.env.SCRY_PROVIDER_MANIFEST_URL?.trim() ? { remoteUrl: process.env.SCRY_PROVIDER_MANIFEST_URL.trim() } : {})
  })
  const providerRegistry = new ProviderRegistry(builtInProviderAdapters, {
    disabledProviders: parseDisabledProviders(process.env.SCRY_DISABLED_PROVIDERS),
    runControlsEnabled: process.env.SCRY_RUN_CONTROLS?.trim() !== '0',
    compatibility: (providerId, version) => providerCompatibility.advisory(providerId, version)
  })
  const mcpExecutionTrust = new McpExecutionTrust()
  const providerContextKey = (providerId: ProviderId, cwd: string, agentProfileId?: string): string =>
    `${providerId}\0${agentProfileId ?? ''}\0${cwd}`
  const withProviderOperation = async <T>(providerId: ProviderId, operation: () => T | Promise<T>, agentProfileId?: string): Promise<T> => {
    const lease = deps.providerOperationGate.acquireOperation(providerOperationKey(providerId, agentProfileId))
    if (!lease.ok) throw new Error('当前 Provider 正在认证 MCP，请等待认证完成或超时后重试')
    try { return await operation() } finally { lease.release() }
  }
  const canonicalProviderCwd = (cwd?: string): string => {
    try { return realpathSync(cwd ?? process.cwd()) } catch { return cwd ?? process.cwd() }
  }
  const providerSessionKey = (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string): string =>
    sessionAttentionKey({ providerId, agentProfileId, cwd, sessionId })
  const trust = createProviderTrust({ providerRegistry, mcpExecutionTrust, userData: () => deps.userData, homeDir: deps.homeDir, shellEnv: deps.shellEnv })
  return { smokeProviderEnabled, smokeDetectedAgents, providerCompatibility, providerRegistry, mcpExecutionTrust,
    providerContextKey, withProviderOperation, canonicalProviderCwd, providerSessionKey, ...trust }
}
