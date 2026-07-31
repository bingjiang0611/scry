import { homedir } from 'node:os'
import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { getClaudeVersion, runAgent } from '../agent-runner'
import { resolveClaudeBin, runtimeCliEnv } from '../claude-locate'
import { authorizedMcpRuntimeEnv, listMcp, testMcpConfig, toggleMcp } from '../mcp-config'
import { computeEnabledSkills, listSkills, setSkillEnabled } from '../skill-config'
import { capabilityReady, capabilityUnavailable, type ProviderContext } from '../../shared/provider'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import type { ProviderAdapter } from './types'
import { effortOption, permissionOptions } from './run-controls'

interface CachedControls {
  data: AgentRunControlCatalog
  observedAt: number
}

const CONTROL_TTL_MS = 30_000

function claudeRuntimeEnv(): Record<string, string> {
  return { ...runtimeCliEnv(), CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1' }
}

function isRemoteMcpConfig(config: Record<string, unknown>): boolean {
  return Boolean(config.url) || config.type === 'http' || config.type === 'sse'
}

function claudeRuntimeEnvForExecution(
  execution: Parameters<ProviderAdapter['run']>[0]['mcpExecution']
): Record<string, string> {
  const env = claudeRuntimeEnv()
  const remoteEnabled = execution?.targets.some((target) => target.enabled && isRemoteMcpConfig(target.config))
  return execution && remoteEnabled ? authorizedMcpRuntimeEnv(env, execution.env) : env
}

function authorizedMcpServers(
  execution: Parameters<ProviderAdapter['run']>[0]['mcpExecution']
): Record<string, Record<string, unknown>> {
  if (!execution) return {}
  return Object.fromEntries(
    execution.targets
      .filter((target) => target.enabled)
      .map((target) => {
        const config = { ...target.config }
        const stdio = !isRemoteMcpConfig(config)
        if (stdio) {
          const configuredEnv = config.env && typeof config.env === 'object'
            ? config.env as Record<string, unknown>
            : {}
          config.env = { ...execution.env, ...configuredEnv }
        }
        return [target.name, config]
      })
  )
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

export function createClaudeAdapter(homeDir = homedir()): ProviderAdapter {
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
        const models = await q.supportedModels()
        const value = {
          observedAt: Date.now(),
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
          env: claudeRuntimeEnvForExecution(request.mcpExecution),
          settingSources: settingSourcesFromEnv(),
          onSessionId: request.onExternalSessionId,
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
          stopped: result.stopped,
          mcp: result.mcpStatus ? { configured: listMcp(request.cwd, homeDir), runtime: result.mcpStatus } : undefined
        })),
        interrupt: handle.interrupt,
        getExternalSessionId: handle.getSessionId
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
        if (!executable()) return capabilityUnavailable(context, 'unknown', 'Claude Code executable 未找到')
        const configured = listMcp(context.cwd, homeDir)
        if (!refresh) {
          return {
            ...capabilityReady(context, 'manage', { configured, runtime: null }),
            state: 'degraded' as const,
            reason: '运行态尚未直接检测；刷新会逐个执行 MCP initialize/tools/list，不会发起模型对话'
          }
        }
        if (!execution) return capabilityUnavailable(context, 'unknown', '缺少绑定当前配置快照的 MCP 执行授权')
        const runtime = await Promise.all(
          execution.targets.map(async (item) => {
            if (!item.enabled) return { name: item.name, status: 'disabled' as const }
            const result = await testMcpConfig(item.config, execution.env, execution.cwd)
            return {
              name: item.name,
              status: result.ok ? ('connected' as const) : ('failed' as const),
              tools: result.tools
            }
          })
        )
        return capabilityReady(context, 'manage', { configured, runtime })
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
      }
    },
    commands: {
      list: async (context) => {
        if (!executable()) return capabilityUnavailable(context, 'unknown', 'Claude Code executable 未找到')
        const commands = listSkills(context.cwd, homeDir)
          .filter((skill) => skill.enabled)
          .map((skill) => ({ name: skill.name, description: skill.description, source: 'skill' as const }))
        return {
          ...capabilityReady(context, 'read', commands),
          state: 'degraded' as const,
          reason: 'Claude SDK 无法在不发送用户消息的前提下启动 control transport；当前仅列出静态可发现的 Skill 命令'
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
