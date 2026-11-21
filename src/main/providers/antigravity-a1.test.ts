import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROVIDER_LABELS,
  PROVIDER_TRANSPORTS,
  providerDangerCoverage,
  type ProviderDescriptor
} from '../../shared/provider'
import {
  isExperimentalProviderEnabled,
  parseExperimentalProviders
} from '../../shared/experimental-providers'
import {
  providerIdForAgentId,
  providerIdForRuntime,
  runtimeProviderForAgentId,
  runtimeProviderForProviderId
} from '../../shared/runtime'
import {
  collectLoginStartPolicyEnv,
  LOGIN_START_POLICY_ENV_KEYS
} from '../../daemon/login-start/policy-env'
import { providerMcpConfigPaths, resolveProviderMcpConfigs } from '../mcp-config'
import { stopEscalationWindow } from '../run-stop-lifecycle'
import { parseDisabledProviders } from './registry'
import { parseDesktopHostRead } from '../remote/desktop-host-reader'
import { createProviderDiscovery } from '../remote/provider-discovery'

const temps: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

describe('A1: Antigravity Provider 枚举、实验门控、MCP 路径与停止窗口', () => {
  it('ProviderId 与 RuntimeProvider 映射与元数据一致', () => {
    expect(PROVIDER_LABELS.antigravity).toBe('Antigravity')
    expect(PROVIDER_TRANSPORTS.antigravity).toBe('ACP (stdio)')
    expect(runtimeProviderForProviderId('antigravity')).toBe('antigravity_acp')
    expect(providerIdForRuntime('antigravity_acp')).toBe('antigravity')
    expect(runtimeProviderForAgentId('antigravity')).toBe('antigravity_acp')
    expect(providerIdForAgentId('antigravity')).toBe('antigravity')
    expect(providerDangerCoverage('antigravity')).toBe('unsupported')
    expect(providerDangerCoverage(undefined, 'antigravity_acp')).toBe('unsupported')
    expect(parseDisabledProviders('antigravity').has('antigravity')).toBe(true)
  })

  it('SCRY_EXPERIMENTAL_PROVIDERS 未设置时默认开启 antigravity；设置后只开启列出的', () => {
    expect(parseExperimentalProviders(undefined).size).toBe(0)
    expect(parseExperimentalProviders('claude,unknown').size).toBe(0)
    expect(parseExperimentalProviders(' antigravity ').has('antigravity')).toBe(true)
    expect(isExperimentalProviderEnabled('claude', {})).toBe(true)
    expect(isExperimentalProviderEnabled('antigravity', {})).toBe(true)
    expect(isExperimentalProviderEnabled('antigravity', { SCRY_EXPERIMENTAL_PROVIDERS: '' })).toBe(false)
    expect(isExperimentalProviderEnabled('antigravity', { SCRY_EXPERIMENTAL_PROVIDERS: 'none' })).toBe(false)
    expect(isExperimentalProviderEnabled('antigravity', { SCRY_EXPERIMENTAL_PROVIDERS: 'antigravity' })).toBe(true)
  })

  it('LOGIN_START_POLICY_ENV_KEYS 包含 SCRY_EXPERIMENTAL_PROVIDERS 且严格校验', () => {
    expect(LOGIN_START_POLICY_ENV_KEYS).toContain('SCRY_EXPERIMENTAL_PROVIDERS')
    expect(collectLoginStartPolicyEnv({ SCRY_EXPERIMENTAL_PROVIDERS: 'antigravity' })).toEqual({
      ok: true,
      entries: [['SCRY_EXPERIMENTAL_PROVIDERS', 'antigravity']]
    })
    expect(collectLoginStartPolicyEnv({ SCRY_DISABLED_PROVIDERS: 'antigravity' })).toEqual({
      ok: true,
      entries: [['SCRY_DISABLED_PROVIDERS', 'antigravity']]
    })
    expect(collectLoginStartPolicyEnv({ SCRY_EXPERIMENTAL_PROVIDERS: ' antigravity' })).toEqual({
      ok: false,
      reason: 'login_start_invalid_env:SCRY_EXPERIMENTAL_PROVIDERS'
    })
    expect(collectLoginStartPolicyEnv({ SCRY_EXPERIMENTAL_PROVIDERS: 'unknown' })).toEqual({
      ok: false,
      reason: 'login_start_invalid_env:SCRY_EXPERIMENTAL_PROVIDERS'
    })
  })

  it('providerMcpConfigPaths 对 antigravity 使用显式路径，绝不落入 OpenCode', () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-agy-mcp-'))
    temps.push(root)
    const home = join(root, 'home')
    const repo = join(root, 'repo')
    const sub = join(repo, 'packages', 'app')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.agents'), { recursive: true })
    mkdirSync(join(sub, '_agent', 'plugins', 'demo'), { recursive: true })
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    writeFileSync(
      join(home, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { globalSrv: { url: 'http://127.0.0.1:9001/mcp' } } })
    )
    writeFileSync(
      join(repo, '.agents', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { rootSrv: { command: '/bin/echo', args: ['ok'] } } })
    )
    writeFileSync(
      join(sub, '_agent', 'plugins', 'demo', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { pluginSrv: { command: '/bin/echo', args: ['p'] } } })
    )

    const paths = providerMcpConfigPaths('antigravity', sub, home, {})
    expect(paths.some((p) => p.includes('opencode.json'))).toBe(false)
    expect(paths).toContain(join(home, '.gemini', 'config', 'mcp_config.json'))
    expect(paths).toContain(join(repo, '.agents', 'mcp_config.json'))
    expect(paths).toContain(join(sub, '_agent', 'mcp_config.json'))
    expect(paths).toContain(join(sub, '_agent', 'plugins', 'demo', 'mcp_config.json'))

    const resolved = resolveProviderMcpConfigs('antigravity', sub, home, {})
    expect(resolved.map((item) => item.name).sort()).toEqual(['globalSrv', 'pluginSrv', 'rootSrv'])
  })

  it('S11: providerMcpConfigPaths 对 pi 返回空列表，不误扫 opencode.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-pi-mcp-'))
    temps.push(root)
    const home = join(root, 'home')
    const ws = join(root, 'ws')
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'opencode.json'), JSON.stringify({ mcp: { oc: { type: 'remote', url: 'http://127.0.0.1:9/mcp' } } }))
    expect(providerMcpConfigPaths('pi', ws, home, {})).toEqual([])
    expect(resolveProviderMcpConfigs('pi', ws, home, {})).toEqual([])
  })

  it('RunStopLifecycle 为 antigravity_acp 配置 5s/4s 停止窗口', () => {
    expect(stopEscalationWindow('antigravity_acp')).toEqual({ gracefulMs: 5000, forceKillMs: 4000 })
  })

  it('远程 provider-discovery 受 SCRY_EXPERIMENTAL_PROVIDERS 门控，desktop-host-reader 接受 antigravity', async () => {
    const agyDescriptor: ProviderDescriptor = {
      id: 'antigravity',
      label: 'Antigravity',
      runtimeProvider: 'antigravity_acp',
      transport: 'ACP (stdio)',
      available: true,
      capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' }
    }
    vi.stubEnv('SCRY_EXPERIMENTAL_PROVIDERS', '')
    const hidden = createProviderDiscovery({
      descriptors: async () => [agyDescriptor],
      profiles: async () => [],
      resolveProfile: async () => undefined,
      authorizeWorkspace: (cwd) => cwd,
      controls: async () => ({ providerId: 'antigravity', mode: 'read', state: 'ready', data: { models: [], permissions: [] } }),
      defaultWorkspace: () => '/tmp',
      permissionOverride: () => undefined,
      onError: () => {}
    })
    await hidden.refreshMetadata()
    expect(hidden.metadata()).toEqual([])

    vi.stubEnv('SCRY_EXPERIMENTAL_PROVIDERS', 'antigravity')
    await hidden.refreshMetadata()
    expect(hidden.metadata().map((item) => item.id)).toEqual(['antigravity'])

    const parsed = parseDesktopHostRead({
      kind: 'trace',
      runId: 'run-1',
      context: { providerId: 'antigravity', cwd: '/repo' }
    })
    expect(parsed.kind).toBe('trace')
  })
})
