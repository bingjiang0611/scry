import { runtimeCliEnv } from '../claude-locate'
import { authorizedMcpRuntimeEnv, isRemoteMcpConfig } from '../mcp-config'
import type { ProviderAdapter, ProviderRunRequest } from './types'

export function claudeRuntimeEnv(
  managedRecorder = false,
  managedIdentity?: ProviderRunRequest['managedRecorderIdentity']
): Record<string, string> {
  return {
    ...(managedRecorder
      ? runtimeCliEnv(undefined, { managedRecorder: true, providerId: 'claude' })
      : runtimeCliEnv(undefined, { providerId: 'claude' })),
    ...(managedRecorder && managedIdentity ? {
      SCRY_MANAGED_RUN_ID: managedIdentity.runId,
      SCRY_MANAGED_PROMPT_HASH: managedIdentity.promptHash
    } : {}),
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
  }
}

export function claudeRuntimeEnvForExecution(
  execution: Parameters<ProviderAdapter['run']>[0]['mcpExecution'],
  managedRecorder = false,
  managedIdentity?: ProviderRunRequest['managedRecorderIdentity']
): Record<string, string> {
  const env = claudeRuntimeEnv(managedRecorder, managedIdentity)
  const remoteEnabled = execution?.targets.some((target) => target.enabled && isRemoteMcpConfig(target.config))
  return execution && remoteEnabled ? authorizedMcpRuntimeEnv(env, execution.env) : env
}

export function heldPrompt(): { stream: AsyncIterable<never>; release: () => void } {
  let release = (): void => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    stream: (async function* (): AsyncIterable<never> {
      await wait
    })(),
    release
  }
}

export function settingSourcesFromEnv(): Array<'user' | 'project' | 'local'> | undefined {
  const configured = process.env.SCRY_CLAUDE_SETTING_SOURCES?.trim()
  if (!configured) return undefined
  const allowed = new Set(['user', 'project', 'local'])
  const sources = configured
    .split(',')
    .map((source) => source.trim())
    .filter((source): source is 'user' | 'project' | 'local' => allowed.has(source))
  return sources.length ? [...new Set(sources)] : undefined
}
