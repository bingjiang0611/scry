import { homedir } from 'node:os'
import { getClaudeVersion, runAgent } from '../agent-runner'
import { resolveClaudeBin, shellEnv } from '../claude-locate'
import { findMcpConfig, listMcp, testMcpConfig, toggleMcp } from '../mcp-config'
import { computeEnabledSkills, listSkills, setSkillEnabled } from '../skill-config'
import { capabilityReady, capabilityUnavailable } from '../../shared/provider'
import type { ProviderAdapter } from './types'

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

  const executable = (): string | undefined => {
    if (!pathResolved) {
      claudePath = resolveClaudeBin()
      pathResolved = true
    }
    return claudePath
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
          cwd: request.cwd,
          skills: computeEnabledSkills(request.cwd, homeDir),
          claudePath: executable(),
          env: shellEnv(),
          settingSources: settingSourcesFromEnv(),
          onSessionId: request.onExternalSessionId,
          attachments: request.attachments,
          requestUserInput: request.requestUserInput
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
      snapshot: async (context, refresh = false) => {
        if (!executable()) return capabilityUnavailable(context, 'unknown', 'Claude Code executable 未找到')
        const configured = listMcp(context.cwd, homeDir)
        if (!refresh) {
          return {
            ...capabilityReady(context, 'manage', { configured, runtime: null }),
            state: 'degraded' as const,
            reason: '运行态尚未直接检测；刷新会逐个执行 MCP initialize/tools/list，不会发起模型对话'
          }
        }
        const runtime = await Promise.all(
          configured.map(async (item) => {
            if (!item.enabled) return { name: item.name, status: 'disabled' as const }
            const config = findMcpConfig(item.name, context.cwd, homeDir)
            if (!config) return { name: item.name, status: 'failed' as const }
            const result = await testMcpConfig(config)
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
      test: async (context, name) => {
        const config = findMcpConfig(name, context.cwd, homeDir)
        if (!config) return capabilityReady(context, 'manage', { ok: false, error: '找不到配置' })
        return capabilityReady(context, 'manage', await testMcpConfig(config))
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
    }
  }
}
