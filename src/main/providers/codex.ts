import {
  capabilityReady,
  capabilityUnknown,
  type CapabilityEnvelope,
  type ProviderCommand,
  type ProviderContext,
  type SkillMeta
} from '../../shared/provider'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import { homedir } from 'node:os'
import { codexContinuationKey, ContinuationIdentityUnavailable } from './continuation-identity'
import type {
  CodexHookInspection,
  CodexHookMetadata,
  CodexHookTrustStatus
} from '../codex-hook-trust'
import {
} from '../mcp-config'
import type {
  ProviderAdapter,
} from './types'
import { effortOption, permissionOptions } from './run-controls'
import { record } from './codex-trace'
export { codexAccess } from './codex-protocol'
import { createCodexRun } from './codex-run'
import { createCodexClientPool } from './codex-client-pool'
import { createCodexMcpSurface } from './codex-mcp-surface'
import { codexMcpConfig } from './codex-mcp-config'
export { codexMcpConfig }
export type { CodexMcpConfig } from './codex-mcp-config-types'
import {
  codexAccess,
  type CodexThreadResponse
} from './codex-protocol'

/** Encode the native UserInput union once for both initial turns and same-turn steering. */
// Root items that run a tool the model called. Their completion is tool activity, not model output.
export function createCodexAdapter(
  isolatedHomePath?: string,
  homeDir = homedir(),
  sessions?: import('./session-pool-policy').SessionLifecycleObserver
): ProviderAdapter {
  const pool = createCodexClientPool({ isolatedHomePath, homeDir, sessions })
  const { getClient, shutdownClient, request, clientActivity, clientActiveRuns, executable, runtimeEnvironment, sourceHomeFor } = pool
  const modelCache = new Map<string, { data: AgentRunControlCatalog; observedAt: number }>()
  const forcedSkillReloads = new Map<string, number>()
  const MODEL_TTL_MS = 30_000

  const inspectHookTrust = async (context: ProviderContext): Promise<CodexHookInspection> => {
    if (!context.cwd) throw new Error('Codex Hook 预检需要工作目录')
    const response = await request<{
      data?: Array<{ cwd?: string; hooks?: unknown[]; warnings?: unknown[]; errors?: unknown[] }>
    }>('hooks/list', { cwds: [context.cwd] }, context.cwd)
    const group = response.data?.find((item) => item.cwd === context.cwd) ?? response.data?.[0]
    if (!group) throw new Error(`Codex hooks/list 未返回当前工作目录：${context.cwd}`)
    const hooks: CodexHookMetadata[] = (group.hooks ?? []).map((raw) => {
      const item = record(raw)
      const trustStatus = String(item.trustStatus ?? '')
      if (!['managed', 'untrusted', 'trusted', 'modified'].includes(trustStatus)) {
        throw new Error(`Codex Hook 返回未知信任状态：${trustStatus || 'empty'}`)
      }
      const key = String(item.key ?? '')
      const currentHash = String(item.currentHash ?? '')
      if (!key || !currentHash) throw new Error('Codex Hook 缺少 key/currentHash，无法建立安全授权')
      return {
        key,
        eventName: String(item.eventName ?? 'hook'),
        source: String(item.source ?? 'unknown'),
        sourcePath: String(item.sourcePath ?? ''),
        enabled: item.enabled !== false,
        currentHash,
        trustStatus: trustStatus as CodexHookTrustStatus
      }
    })
    return {
      cwd: context.cwd,
      hooks,
      warnings: (group.warnings ?? []).map(String),
      errors: (group.errors ?? []).map(String)
    }
  }

  const isTopLevelSkill = (path: string): boolean => {
    const normalized = path.replaceAll('\\', '/')
    const root = normalized.lastIndexOf('/skills/')
    return root < 0 || normalized.slice(root + 8).split('/').length <= 2
  }
  const skills = {
    list: async (context: ProviderContext, forceReload = false, expectedContinuationKey?: string) => {
      const key = context.cwd ?? ''
      const reloadGeneration = forcedSkillReloads.get(key)
      const reload = forceReload || reloadGeneration != null
      try {
        const response = await request<{ data?: Array<{ cwd?: string; skills?: unknown[]; errors?: unknown[] }> }>('skills/list', {
          cwds: context.cwd ? [context.cwd] : [],
          forceReload: reload
        }, context.cwd, [], undefined, expectedContinuationKey)
        const group = response.data?.find((item) => !context.cwd || item.cwd === context.cwd) ?? response.data?.[0]
        const data: SkillMeta[] = (group?.skills ?? []).map((raw) => {
          const item = record(raw)
          return {
            name: String(item.name ?? ''),
            dir: String(item.path ?? ''),
            scope: String(item.scope ?? 'unknown'),
            description: String(item.description ?? item.shortDescription ?? ''),
            enabled: item.enabled !== false
          }
        }).filter((skill) => isTopLevelSkill(skill.dir))
        const errors = group?.errors?.length ?? 0
        return errors
          ? { ...capabilityReady(context, 'read' as const, data), state: 'degraded' as const, reason: `${errors} 个 Skill 读取错误` }
          : capabilityReady(context, 'read' as const, data)
      } catch (error) {
        return capabilityUnknown<SkillMeta[]>(context, 'read', String((error as Error).message))
      } finally {
        if (reloadGeneration != null && forcedSkillReloads.get(key) === reloadGeneration) {
          forcedSkillReloads.delete(key)
        }
      }
    }
  }

  return {
    id: 'codex',
    runtimeProvider: 'codex_cli',
    historicalContext: true,
    historyReader: true,
    continuationKey: (context) => {
      const env = runtimeEnvironment()
      const sourceHome = sourceHomeFor(env)
      const { home, sourceHome: materialisedFrom } = pool.isolatedState()
      if (home && materialisedFrom !== sourceHome) {
        throw new ContinuationIdentityUnavailable('Codex source home 已变化；请重启 Provider 后再继续')
      }
      const intendedHome = home?.path ?? isolatedHomePath
      if (!intendedHome) {
        throw new ContinuationIdentityUnavailable('Codex 临时 isolated home 尚未初始化，无法建立稳定接续身份；请重启 Provider 或配置持久化运行目录')
      }
      return codexContinuationKey(context, sourceHome, intendedHome, executable(), env, home ? 'materialized' : 'planned')
    },
    describe: async () => {
      const path = executable()
      const health = pool.health()
      return {
        id: 'codex',
        label: 'Codex',
        runtimeProvider: 'codex_cli',
        transport: 'app-server',
        available: !!path,
        path,
        capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' },
        health: {
          state: !path ? 'unavailable' : health.lastError ? 'degraded' : health.lastOkAt ? 'ready' : 'unknown',
          transport: 'app-server',
          pid: health.pid,
          lastOkAt: health.lastOkAt,
          lastErrorAt: health.lastErrorAt,
          lastError: health.lastError,
          restarts: health.restarts
        }
      }
    },
    forkLastTurn: {
      async fork(forkRequest) {
        if (!forkRequest.previousForkTurnId) throw new Error('Codex 分支缺少上一轮 turn ID')
        const access = codexAccess(forkRequest.permissionMode)
        const thread = await request<CodexThreadResponse>('thread/fork', {
          threadId: forkRequest.sourceSessionId,
          lastTurnId: forkRequest.previousForkTurnId,
          cwd: forkRequest.cwd,
          excludeTurns: true,
          ...access,
          ...(forkRequest.model ? { model: forkRequest.model.id } : {})
        }, forkRequest.cwd, forkRequest.codexHookTrust, forkRequest.mcpExecution)
        return { externalSessionId: thread.thread.id }
      }
    },
    forkSession: {
      async fork(forkRequest) {
        const access = codexAccess(forkRequest.permissionMode)
        await forkRequest.beforeFork?.()
        const thread = await request<CodexThreadResponse>('thread/fork', {
          threadId: forkRequest.sourceSessionId,
          lastTurnId: forkRequest.sourceForkTurnId,
          cwd: forkRequest.cwd,
          excludeTurns: true,
          ...access,
          ...(forkRequest.model ? { model: forkRequest.model.id } : {})
        }, forkRequest.cwd, forkRequest.codexHookTrust, forkRequest.mcpExecution, forkRequest.expectedContinuationKey)
        return { externalSessionId: thread.thread.id }
      }
    },
    run: createCodexRun({
      request,
      getClient,
      shutdownClient,
      scheduleClientShutdown: pool.scheduleClientShutdown,
      clientActivity,
      clientActiveRuns,
      modelCache,
      skills,
      onNativeThread: pool.recordNativeSession
    }),
    invalidateContext(context) {
      const key = context.cwd ?? ''
      forcedSkillReloads.set(key, (forcedSkillReloads.get(key) ?? 0) + 1)
      modelCache.delete(key)
    },
    skills,
    commands: {
      list: async (context): Promise<CapabilityEnvelope<ProviderCommand[]>> => {
        const result = await skills.list(context)
        return {
          ...result,
          mode: 'read',
          data: result.data
            ? result.data
                .filter((skill) => skill.enabled)
                .map((skill) => ({
                  name: skill.name,
                  description: skill.description || 'Codex Skill',
                  source: 'skill' as const
                }))
            : null
        }
      }
    },
    hookTrust: { inspect: inspectHookTrust },
    mcp: createCodexMcpSurface({ homeDir, request, getClient, shutdownClient }),
    runControls: {
      read: async (context) => {
        try {
          const key = context.cwd ?? ''
          let value = modelCache.get(key)
          if (!value || Date.now() - value.observedAt >= MODEL_TTL_MS) {
            const response = await request<{ data?: unknown[] }>(
              'model/list',
              { includeHidden: false },
              context.cwd
            )
            const models = (response.data ?? []).map((raw) => {
              const item = record(raw)
              const efforts = Array.isArray(item.supportedReasoningEfforts)
                ? item.supportedReasoningEfforts.map((rawEffort) => {
                    const entry = record(rawEffort)
                    const id = String(entry.reasoningEffort ?? '')
                    return effortOption(
                      id,
                      typeof entry.description === 'string' ? entry.description : undefined,
                      id === item.defaultReasoningEffort
                    )
                  }).filter((effort) => effort.id)
                : []
              return {
                model: { id: String(item.model ?? item.id ?? '') },
                label: String(item.displayName ?? item.model ?? item.id ?? ''),
                description: typeof item.description === 'string' ? item.description : undefined,
                isDefault: item.isDefault === true,
                efforts
              }
            }).filter((model) => model.model.id)
            value = {
              data: { models, permissions: permissionOptions({ autoReview: true }) },
              observedAt: Date.now()
            }
            modelCache.delete(key)
            modelCache.set(key, value)
            while (modelCache.size > 16) {
              const oldest = modelCache.keys().next().value
              if (oldest === undefined) break
              modelCache.delete(oldest)
            }
          }
          return capabilityReady(context, 'read', value.data, value.observedAt)
        } catch (error) {
          return {
            ...capabilityReady(context, 'read', { models: [], permissions: permissionOptions({ autoReview: true }) }),
            state: 'degraded' as const,
            reason: String((error as Error).message)
          }
        }
      }
    },
    dispose: async () => {
      await pool.closeAll()
      modelCache.clear()
      forcedSkillReloads.clear()
      pool.isolatedState().home?.cleanup()
    }
  }
}


