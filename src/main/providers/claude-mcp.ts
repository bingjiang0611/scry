import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import { runtimeCliEnv } from '../claude-locate'
import { authorizedMcpRuntimeEnv, authorizedMcpServers, isRemoteMcpConfig } from '../mcp-config'
import {
  MCP_CHECK_CANCELLED,
  type McpAuthResult,
  type McpMeta,
  type McpSnapshot
} from '../../shared/provider'
import type { AuthorizedMcpExecution, ProviderAdapter, ProviderRunRequest } from './types'
import type { McpLiveStatus } from '../../shared/trace'
import { sanitizeMcpAuthError } from './mcp-auth-security'
import { writePrivateMcpConfig } from './private-mcp-config'

const MCP_LOGIN_TIMEOUT_MS = 180_000
const MCP_STATUS_TIMEOUT_MS = 15_000

export type ClaudeMcpLogin = (
  executable: string,
  serverName: string,
  config: Record<string, unknown>,
  cwd: string,
  env: NodeJS.ProcessEnv
) => Promise<McpAuthResult>

export function claudeMcpLoginArgs(serverName: string, configPath: string): string[] {
  if (!serverName || /[\u0000-\u001f\u007f]/.test(serverName)) {
    throw new Error('Claude MCP 名称包含无效字符')
  }
  return ['--mcp-config', configPath, '--strict-mcp-config', 'mcp', 'login', '--', serverName]
}

function executeClaudeMcpLogin(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<McpAuthResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { cwd, env, shell: false, timeout: MCP_LOGIN_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error) => resolve(error
        ? { ok: false, status: 'failed', error: error.killed ? '等待 Claude MCP 浏览器认证超时' : sanitizeMcpAuthError(error) }
        : { ok: true, status: 'authenticated' })
    )
  })
}

export const runClaudeMcpLogin: ClaudeMcpLogin = async (executable, serverName, config, cwd, env) => {
  let authDirectory: string | undefined
  let result: McpAuthResult
  let cleanupError: unknown
  try {
    // Validate before writing a credential-bearing config to disk.
    claudeMcpLoginArgs(serverName, '')
    authDirectory = await mkdtemp(join(tmpdir(), 'scry-claude-mcp-auth-'))
    await chmod(authDirectory, 0o700)
    const configPath = join(authDirectory, 'mcp.json')
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { [serverName]: config } }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    )
    result = await executeClaudeMcpLogin(
      executable,
      claudeMcpLoginArgs(serverName, configPath),
      cwd,
      env
    )
  } catch (error) {
    result = { ok: false, status: 'failed', error: sanitizeMcpAuthError(error) }
  } finally {
    if (authDirectory) {
      try {
        await rm(authDirectory, { recursive: true, force: true })
      } catch (error) {
        cleanupError = error
      }
    }
  }
  if (cleanupError) {
    return { ok: false, status: 'failed', error: `Claude MCP 临时认证配置清理失败：${sanitizeMcpAuthError(cleanupError)}` }
  }
  return result
}

function claudeRuntimeEnv(
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

function claudeRuntimeEnvForExecution(
  execution: Parameters<ProviderAdapter['run']>[0]['mcpExecution'],
  managedRecorder = false,
  managedIdentity?: ProviderRunRequest['managedRecorderIdentity']
): Record<string, string> {
  const env = claudeRuntimeEnv(managedRecorder, managedIdentity)
  const remoteEnabled = execution?.targets.some((target) => target.enabled && isRemoteMcpConfig(target.config))
  return execution && remoteEnabled ? authorizedMcpRuntimeEnv(env, execution.env) : env
}

function heldPrompt(): { stream: AsyncIterable<never>; release: () => void } {
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

function settingSourcesFromEnv(): Array<'user' | 'project' | 'local'> | undefined {
  const configured = process.env.SCRY_CLAUDE_SETTING_SOURCES?.trim()
  if (!configured) return undefined
  const allowed = new Set(['user', 'project', 'local'])
  const sources = configured
    .split(',')
    .map((source) => source.trim())
    .filter((source): source is 'user' | 'project' | 'local' => allowed.has(source))
  return sources.length ? [...new Set(sources)] : undefined
}

export function authenticationTargets(configured: McpMeta[]): string[] {
  const nameCounts = new Map<string, number>()
  for (const item of configured) {
    if (item.enabled) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1)
  }
  return configured
    .filter((item) => item.enabled && nameCounts.get(item.name) === 1 && item.transport === 'http' && item.targetId)
    .map((item) => item.targetId as string)
}

export function claudeMcpSnapshot(configured: McpMeta[], statuses: McpServerStatus[]): McpSnapshot {
  const runtime: McpLiveStatus[] = statuses.map((server) => ({
    name: server.name,
    status: server.status,
    serverName: server.serverInfo?.name,
    serverVersion: server.serverInfo?.version,
    tools: server.tools?.length,
    toolNames: server.tools?.map((tool) => tool.name)
  }))
  for (const item of configured) {
    if (!item.enabled && !runtime.some((status) => status.name === item.name)) {
      runtime.push({ name: item.name, status: 'disabled' })
    }
  }
  return { configured, runtime, operations: { authenticate: authenticationTargets(configured) } }
}

export async function readClaudeMcpStatus(
  executable: string,
  execution: AuthorizedMcpExecution,
  signal?: AbortSignal
): Promise<McpServerStatus[]> {
  if (signal?.aborted) throw new Error(MCP_CHECK_CANCELLED)
  // Same private file as a run: the SDK would otherwise put headers and env on argv.
  const mcpConfig = writePrivateMcpConfig(authorizedMcpServers(execution))
  const prompt = heldPrompt()
  let q: ReturnType<typeof query>
  try {
    q = query({
      prompt: prompt.stream,
      options: {
        cwd: execution.cwd,
        pathToClaudeCodeExecutable: executable,
        env: claudeRuntimeEnvForExecution(execution),
        settingSources: settingSourcesFromEnv(),
        strictMcpConfig: true,
        mcpServers: {},
        ...(mcpConfig ? { extraArgs: mcpConfig.extraArgs } : {})
      }
    })
  } catch (error) {
    mcpConfig?.dispose()
    throw error
  }
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      (async () => {
        await q.initializationResult()
        return await q.mcpServerStatus()
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Claude Code MCP 状态校验超时')), MCP_STATUS_TIMEOUT_MS)
        timer.unref()
        // A person's cancel ends the check like the timeout does: finally closes the
        // SDK query, which owns and stops its own Claude Code child.
        signal?.addEventListener('abort', () => reject(new Error(MCP_CHECK_CANCELLED)), { once: true })
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    prompt.release()
    q.close()
    mcpConfig?.dispose()
  }
}

