import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  query,
  type McpServerConfig,
  type McpServerStatus,
  type ModelInfo,
  type SlashCommand
} from '@anthropic-ai/claude-agent-sdk'
import { getClaudeVersion, runAgent } from '../agent-runner'
import { resolveClaudeBin, runtimeCliEnv } from '../claude-locate'
import {
  authorizedMcpRuntimeEnv,
  authorizedMcpServers,
  isRemoteMcpConfig,
  listMcp,
  testMcpConfig,
  toggleMcp
} from '../mcp-config'
import { computeEnabledSkills, listSkills, setSkillEnabled } from '../skill-config'
import {
  capabilityReady,
  capabilityUnavailable,
  type McpAuthResult,
  type McpMeta,
  type McpSnapshot,
  type ProviderContext
} from '../../shared/provider'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import type { McpLiveStatus } from '../../shared/trace'
import type { AuthorizedMcpExecution, ProviderAdapter } from './types'
import { effortOption, permissionOptions } from './run-controls'
import { sanitizeMcpAuthError } from './mcp-auth-security'

interface CachedControls {
  data: AgentRunControlCatalog
  commands: SlashCommand[]
  observedAt: number
}

const CONTROL_TTL_MS = 30_000
const MCP_LOGIN_TIMEOUT_MS = 180_000
const MCP_STATUS_TIMEOUT_MS = 15_000

type ClaudeMcpLogin = (
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

function claudeRuntimeEnv(managedRecorder = false): Record<string, string> {
  return {
    ...(managedRecorder ? runtimeCliEnv(undefined, { managedRecorder: true }) : runtimeCliEnv()),
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
  }
}

function claudeRuntimeEnvForExecution(
  execution: Parameters<ProviderAdapter['run']>[0]['mcpExecution'],
  managedRecorder = false
): Record<string, string> {
  const env = claudeRuntimeEnv(managedRecorder)
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

function authenticationTargets(configured: McpMeta[]): string[] {
  const nameCounts = new Map<string, number>()
  for (const item of configured) {
    if (item.enabled) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1)
  }
  return configured
    .filter((item) => item.enabled && nameCounts.get(item.name) === 1 && item.transport === 'http' && item.targetId)
    .map((item) => item.targetId as string)
}

function claudeMcpSnapshot(configured: McpMeta[], statuses: McpServerStatus[]): McpSnapshot {
  const runtime: McpLiveStatus[] = statuses.map((server) => ({
    name: server.name,
    status: server.status,
    serverName: server.serverInfo?.name,
    serverVersion: server.serverInfo?.version,
    tools: server.tools?.length
  }))
  for (const item of configured) {
    if (!item.enabled && !runtime.some((status) => status.name === item.name)) {
      runtime.push({ name: item.name, status: 'disabled' })
    }
  }
  return { configured, runtime, operations: { authenticate: authenticationTargets(configured) } }
}

async function readClaudeMcpStatus(
  executable: string,
  execution: AuthorizedMcpExecution
): Promise<McpServerStatus[]> {
  const prompt = heldPrompt()
  const q = query({
    prompt: prompt.stream,
    options: {
      cwd: execution.cwd,
      pathToClaudeCodeExecutable: executable,
      env: claudeRuntimeEnvForExecution(execution),
      settingSources: settingSourcesFromEnv(),
      strictMcpConfig: true,
      mcpServers: authorizedMcpServers(execution) as Record<string, McpServerConfig>
    }
  })
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
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    prompt.release()
    q.close()
  }
}

export function createClaudeAdapter(homeDir = homedir(), login: ClaudeMcpLogin = runClaudeMcpLogin): ProviderAdapter {
  let claudePath: string | undefined
  let pathResolved = false
  const controlCache = new Map<string, CachedControls>()
  const pendingControls = new Map<string, Promise<CachedControls>>()

  const executable = (): string | undefined => {
    if (!pathResolved) {
      claudePath = resolveClaudeBin()
      pathResolved = true
    }
    return claudePath
  }

  const readControls = async (context: ProviderContext): Promise<CachedControls> => {
    const key = context.cwd ?? ''
    const cached = controlCache.get(key)
    if (cached && Date.now() - cached.observedAt < CONTROL_TTL_MS) return cached
    const pending = pendingControls.get(key)
    if (pending) return pending
    const load = (async () => {
      const path = executable()
      if (!path) throw new Error('Claude Code executable 未找到')
      const prompt = heldPrompt()
      const q = query({
        prompt: prompt.stream,
        options: {
          cwd: context.cwd,
          pathToClaudeCodeExecutable: path,
          env: claudeRuntimeEnv(),
          settingSources: settingSourcesFromEnv(),
          strictMcpConfig: true,
          mcpServers: {}
        }
      })
      try {
        const [models, commands] = await Promise.all([q.supportedModels(), q.supportedCommands()])
        const value = {
          observedAt: Date.now(),
          commands,
          data: {
            models: models.map((model: ModelInfo) => ({
              model: { id: model.value },
              label: model.displayName,
              description: model.description,
              efforts: (model.supportedEffortLevels ?? []).map((effort) => effortOption(effort))
            })),
            permissions: permissionOptions()
          }
        }
        controlCache.set(key, value)
        return value
      } finally {
        prompt.release()
        q.close()
      }
    })()
    pendingControls.set(key, load)
    try {
      return await load
    } finally {
      pendingControls.delete(key)
    }
  }

  return {
    id: 'claude',
    runtimeProvider: 'claude_sdk',
    describe: async () => {
      const path = executable()
      return {
        id: 'claude',
        label: 'Claude Code',
        runtimeProvider: 'claude_sdk',
        transport: 'Agent SDK',
        available: !!path,
        path,
        version: getClaudeVersion(),
        capabilities: { skills: 'manage', mcp: 'manage', commands: 'read', account: 'none' }
      }
    },
    run: (request) => {
      const handle = runAgent(
        request.prompt,
        request.runId,
        (event) =>
          request.emit(
            event.kind === 'harness' && event.stage === 'result'
              ? {
                  ...event,
                  billingProvider: 'anthropic',
                  upstreamProvider: 'anthropic',
                  usageSource: 'claude_sdk',
                  modelUsage: event.modelUsage?.map((usage) => ({
                    ...usage,
                    billingProvider: 'anthropic',
                    upstreamProvider: 'anthropic',
                    usageSource: 'claude_sdk'
                  }))
                }
              : event
          ),
        {
          resume: request.resume,
          cwd: request.mcpExecution?.cwd ?? request.cwd,
          skills: computeEnabledSkills(request.cwd, homeDir),
          claudePath: executable(),
          env: claudeRuntimeEnvForExecution(request.mcpExecution, request.managedRecorder === true),
          settingSources: settingSourcesFromEnv(),
          onSessionId: request.onExternalSessionId,
          captureProviderTurnId: request.managedRecorder === true,
          attachments: request.attachments,
          requestUserInput: request.requestUserInput,
          model: request.model?.id,
          effort: request.effort,
          permissionMode: request.permissionMode,
          mcpServers: authorizedMcpServers(request.mcpExecution)
        }
      )
      return {
        promise: handle.promise.then((result) => ({
          externalSessionId: result.sessionId,
          providerTurnId: result.providerTurnId,
          stopped: result.stopped,
          status: result.status,
          mcp: result.mcpStatus ? { configured: listMcp(request.cwd, homeDir), runtime: result.mcpStatus } : undefined
        })),
        interrupt: handle.interrupt,
        getExternalSessionId: handle.getSessionId,
        getProviderTurnId: handle.getProviderTurnId
      }
    },
    skills: {
      list: async (context) => capabilityReady(context, 'manage', listSkills(context.cwd, homeDir)),
      setEnabled: async (context, name, enabled) => {
        setSkillEnabled(name, enabled, context.cwd, homeDir)
        return capabilityReady(context, 'manage', true)
      }
    },
    mcp: {
      snapshot: async (context, refresh = false, execution) => {
        const path = executable()
        if (!path) return capabilityUnavailable(context, 'unknown', 'Claude Code executable 未找到')
        const configured = listMcp(context.cwd, homeDir)
        const operations = { authenticate: authenticationTargets(configured) }
        if (!refresh) {
          return {
            ...capabilityReady(context, 'manage', { configured, runtime: null, operations }),
            state: 'degraded' as const,
            reason: '运行态尚未直接检测；刷新会读取 Claude Code 原生 MCP 状态，不会发起模型对话'
          }
        }
        if (!execution) return capabilityUnavailable(context, 'unknown', '缺少绑定当前配置快照的 MCP 执行授权')
        try {
          return capabilityReady(context, 'manage', claudeMcpSnapshot(
            configured,
            await readClaudeMcpStatus(path, execution)
          ))
        } catch (error) {
          return capabilityUnavailable(context, 'unknown', sanitizeMcpAuthError(error))
        }
      },
      setEnabled: async (context, name, enabled) => {
        const ok = toggleMcp(name, enabled, context.cwd, homeDir)
        return capabilityReady(context, 'manage', ok)
      },
      test: async (context, targetId, execution) => {
        if (!execution) return capabilityReady(context, 'manage', { ok: false, error: '缺少绑定当前配置快照的 MCP 执行授权' })
        const target = execution.targets.find((item) => item.targetId === targetId)
        if (!target) return capabilityReady(context, 'manage', { ok: false, error: '找不到精确配置目标' })
        return capabilityReady(context, 'manage', await testMcpConfig(target.config, execution.env, execution.cwd))
      },
      reauthenticate: async (context, targetId, execution) => {
        const failed = (error: unknown, authenticated = false) => capabilityReady(context, 'manage', {
          ok: false,
          status: authenticated ? 'authenticated-unverified' as const : 'failed' as const,
          error: sanitizeMcpAuthError(error)
        })
        const path = executable()
        if (!path) return failed('Claude Code executable 未找到')
        if (!execution) return failed('缺少绑定当前配置快照的 MCP 执行授权')
        if (execution.cwd !== context.cwd) return failed('MCP 执行授权与当前工作目录不匹配')
        const target = execution.targets.find((item) => item.targetId === targetId)
        if (!target) return failed('找不到精确配置目标')
        if (!target.enabled) return failed('当前 MCP 已停用')
        if (!isRemoteMcpConfig(target.config)) return failed('stdio MCP 不支持 OAuth 认证')
        if (execution.targets.some((item) => item.targetId !== targetId && item.enabled && item.name === target.name)) {
          return failed(`Claude Code 存在多个同名 MCP ${target.name}，无法安全绑定认证目标`)
        }
        const result = await login(path, target.name, target.config, execution.cwd, claudeRuntimeEnv())
        if (!result.ok) return failed(result.error || 'Claude MCP 认证失败')
        try {
          const statuses = await readClaudeMcpStatus(path, {
            ...execution,
            targets: [target]
          })
          const status = statuses.find((item) => item.name === target.name)
          if (status?.status !== 'connected') {
            return failed(status?.status === 'needs-auth'
              ? 'Claude Code 完成认证后仍报告需要登录'
              : `Claude Code 完成认证后连接状态为 ${status?.status ?? 'unknown'}`, true)
          }
          return capabilityReady(context, 'manage', result)
        } catch (error) {
          return failed(`认证已完成，但原生状态校验失败：${sanitizeMcpAuthError(error)}`, true)
        }
      }
    },
    commands: {
      list: async (context) => {
        if (!executable()) return capabilityUnavailable(context, 'unknown', 'Claude Code executable 未找到')
        try {
          const controls = await readControls(context)
          const skills = new Set(listSkills(context.cwd, homeDir).filter((skill) => skill.enabled).map((skill) => skill.name))
          return capabilityReady(
            context,
            'read',
            controls.commands.map((command) => ({
              name: command.name,
              description: command.description,
              argumentHint: command.argumentHint || undefined,
              source: skills.has(command.name) ? 'skill' as const : 'builtin' as const
            })),
            controls.observedAt
          )
        } catch (error) {
          return capabilityUnavailable(context, 'unknown', String((error as Error).message))
        }
      }
    },
    runControls: {
      read: async (context) => {
        try {
          const controls = await readControls(context)
          return capabilityReady(context, 'read', controls.data, controls.observedAt)
        } catch (error) {
          return {
            ...capabilityReady(context, 'read', { models: [], permissions: permissionOptions() }),
            state: 'degraded' as const,
            reason: String((error as Error).message)
          }
        }
      }
    }
  }
}
