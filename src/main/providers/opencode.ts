import { homedir } from 'node:os'
import { capabilityReady, capabilityUnknown, type McpSnapshot, type SkillMeta } from '../../shared/provider'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import { resolveRuntimeCliBin, shellEnv } from '../claude-locate'
import { isRemoteMcpConfig, listProviderMcp } from '../mcp-config'
import type { AuthorizedMcpExecution, ProviderAdapter } from './types'
import { completedOpenCodeTurnBoundary } from './session-fork-boundary'
import { sanitizeMcpAuthError } from './mcp-auth-security'
import {
  openCodeAuthenticationTargets,
  openCodeMcpSnapshot,
  openCodeRunControlCatalog
} from './opencode-controls'
import { unwrap } from './opencode-errors'
import { openCodeSkillScope } from './opencode-events'
import { openCodeMessageId, openCodeMessageRole, record } from './opencode-records'
import { openCodeContinuationKey } from './host-continuation-identity'
import { runOpenCode } from './opencode-run'
import { createOpenCodeServerPool } from './opencode-server-pool'
import { permissionOptions } from './run-controls'

/** The CLI path the adapter launches; identity checks hash the same resolution. */
export function openCodeExecutable(): string | undefined {
  return process.env.SCRY_OPENCODE_PATH?.trim() || resolveRuntimeCliBin('opencode')
}

export function createOpenCodeAdapter(
  homeDir = homedir(),
  privateMcpAuthDirectory?: string,
  sessionStateRoot?: string
): ProviderAdapter {
  const pool = createOpenCodeServerPool(openCodeExecutable, privateMcpAuthDirectory, sessionStateRoot)
  const identity = {
    homeDir,
    privateMcpAuthDirectory,
    sessionStateRoot,
    executable: openCodeExecutable()
  }
  const modelCache = new Map<string, { expiresAt: number; catalog: AgentRunControlCatalog }>()
  const withClient = pool.withClient

  return {
    id: 'opencode',
    runtimeProvider: 'opencode_server',
    historicalContext: true,
    continuationKey: (context) => openCodeContinuationKey(context, identity),
    describe: async () => {
      const path = openCodeExecutable()
      const health = pool.health()
      return {
        id: 'opencode',
        label: 'OpenCode',
        runtimeProvider: 'opencode_server',
        transport: 'server SDK',
        available: !!path,
        path,
        capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' },
        health: {
          state: !path ? 'unavailable' : health.lastError ? 'degraded' : health.lastOkAt ? 'ready' : 'unknown',
          transport: 'server SDK',
          cwd: health.current?.cwd,
          pid: health.current?.pid,
          lastOkAt: health.lastOkAt,
          lastErrorAt: health.lastErrorAt,
          lastError: health.lastError
        }
      }
    },
    forkLastTurn: {
      async fork(request) {
        if (!request.cwd) throw new Error('OpenCode 分支需要工作目录')
        const server = await pool.serverFor(
          { providerId: 'opencode', cwd: request.cwd, externalSessionId: request.sourceSessionId },
          request.mcpExecution,
          request.openCodePluginTrust
        )
        const message = await unwrap<{ info?: unknown }>(server.client.session.message({
          sessionID: request.sourceSessionId,
          messageID: request.replaceForkTurnId,
          directory: request.cwd
        }), 'session.message')
        const parentID = record(message.info).parentID
        if (typeof parentID !== 'string' || !parentID) throw new Error('OpenCode 会话无法定位待替换消息的前一边界')
        const forked = await unwrap<{ id: string }>(server.client.session.fork({
          sessionID: request.sourceSessionId,
          messageID: parentID,
          directory: request.cwd
        }), 'session.fork')
        return { externalSessionId: forked.id }
      }
    },
    forkSession: {
      async fork(request) {
        if (!request.cwd) throw new Error('OpenCode 分支需要工作目录')
        const server = await pool.serverFor(
          { providerId: 'opencode', cwd: request.cwd, externalSessionId: request.sourceSessionId },
          request.mcpExecution,
          request.openCodePluginTrust
        )
        if (typeof server.client.session.messages !== 'function') {
          throw new Error('当前 OpenCode SDK 无法读取完整消息边界')
        }
        const rows = await unwrap<Array<{ info?: unknown }>>(server.client.session.messages({
          sessionID: request.sourceSessionId,
          directory: request.cwd,
          limit: 1_000
        }), 'session.messages')
        if (rows.length >= 1_000) throw new Error('OpenCode 会话消息超过安全边界，无法证明分支位置')
        const boundary = completedOpenCodeTurnBoundary(rows.map((row) => {
          const info = record(row.info)
          return { id: openCodeMessageId(info), role: openCodeMessageRole(info) }
        }), request.sourceForkTurnId)
        const forked = await unwrap<{ id: string }>(server.client.session.fork({
          sessionID: request.sourceSessionId,
          messageID: boundary,
          directory: request.cwd
        }), 'session.fork')
        return { externalSessionId: forked.id }
      }
    },    run: (request) => runOpenCode(request, { pool, identity }),
    mcp: {
      snapshot: async (context, refresh = false, execution) => {
        const configured = listProviderMcp('opencode', context.cwd, homeDir, shellEnv())
        const operations = { authenticate: openCodeAuthenticationTargets(execution) }
        if (!refresh) {
          return {
            ...capabilityReady(context, 'read', { configured, runtime: null, operations }),
            state: 'degraded',
            reason: '配置已读取；刷新后才会启动隔离 OpenCode server 并读取已授权 MCP 运行状态'
          }
        }
        if (!configured.some((item) => item.enabled)) {
          return capabilityReady(context, 'read', { configured, runtime: [], operations })
        }
        if (!execution) return capabilityUnknown<McpSnapshot>(context, 'read', '缺少已确认的 OpenCode MCP 执行快照')
        try {
          return capabilityReady(context, 'read', await withClient(
            context,
            execution,
            (client) => openCodeMcpSnapshot(client, context, configured, operations.authenticate)
          ))
        } catch (error) {
          pool.recordFailure(error)
          return capabilityUnknown<McpSnapshot>(context, 'read', sanitizeMcpAuthError(error))
        }
      },
      reauthenticate: async (context, targetId, execution) => {
        const failed = (error: unknown, authenticated = false) => capabilityReady(context, 'read', {
          ok: false,
          status: authenticated ? 'authenticated-unverified' as const : 'failed' as const,
          error: sanitizeMcpAuthError(error)
        })
        if (!context.cwd) return failed('OpenCode 需要工作目录')
        if (!execution) return failed('缺少绑定当前配置快照的 MCP 执行授权')
        if (execution.cwd !== context.cwd) return failed('MCP 执行授权与当前工作目录不匹配')
        const target = execution.targets.find((item) => item.targetId === targetId)
        if (!target) return failed('已确认的 OpenCode MCP 执行快照中不存在该目标')
        if (!target.enabled) return failed(`OpenCode MCP ${target.name} 当前已停用`)
        if (!isRemoteMcpConfig(target.config)) return failed('stdio MCP 不支持 OAuth 重新认证')
        if (target.config.oauth === false) return failed(`OpenCode MCP ${target.name} 已显式停用 OAuth`)
        if (execution.targets.some((item) => item.targetId !== targetId && item.enabled && item.name === target.name)) {
          return failed(`OpenCode 存在多个同名 MCP ${target.name}，无法安全绑定认证目标`)
        }
        const authExecution: AuthorizedMcpExecution = {
          ...execution,
          fingerprint: `${execution.fingerprint}:auth:${target.targetId}`,
          targets: [target]
        }
        if (pool.closed) return failed('OpenCode adapter 已关闭')
        const authManager = pool.authManager()
        let persisted = false
        try {
          const client = (await authManager.ensure(context.cwd, authExecution)).client
          let timer: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              unwrap(client.mcp.auth.authenticate({ name: target.name, directory: context.cwd }), 'mcp.auth.authenticate'),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  reject(new Error('等待 OpenCode MCP 浏览器认证超时'))
                }, OPEN_CODE_MCP_AUTH_TIMEOUT_MS)
                timer.unref()
              })
            ])
          } finally {
            if (timer) clearTimeout(timer)
          }
          await authManager.persistMcpAuth(target, execution.cwd)
          persisted = true
          let verificationTimer: NodeJS.Timeout | undefined
          let snapshot: McpSnapshot
          try {
            snapshot = await Promise.race([
              (async () => {
                await unwrap(client.mcp.connect({ name: target.name, directory: context.cwd }), 'mcp.connect')
                return await openCodeMcpSnapshot(client, context, [
                  {
                    targetId: target.targetId,
                    name: target.name,
                    scope: 'authorized',
                    transport: 'http',
                    detail: String(target.config.url ?? ''),
                    enabled: true
                  }
                ], [target.targetId])
              })(),
              new Promise<never>((_resolve, reject) => {
                verificationTimer = setTimeout(() => {
                  reject(new Error('OpenCode MCP 认证已完成，但连接状态校验超时'))
                }, OPEN_CODE_MCP_VERIFY_TIMEOUT_MS)
                verificationTimer.unref()
              })
            ])
          } finally {
            if (verificationTimer) clearTimeout(verificationTimer)
          }
          const status = snapshot.runtime?.find((item) => item.name === target.name)
          if (status?.status !== 'connected') {
            return failed(`OpenCode MCP ${target.name} 认证后状态为 ${status?.status ?? 'unknown'}`, true)
          }
          return capabilityReady(context, 'read', { ok: true, status: 'authenticated' as const })
        } catch (error) {
          return failed(error, persisted)
        } finally {
          await pool.releaseManager(authManager)
        }
      }
    },
    runControls: {
      read: async (context) => {
        const cacheKey = context.cwd ?? ''
        const cached = modelCache.get(cacheKey)
        if (cached && cached.expiresAt > Date.now()) return capabilityReady(context, 'read', cached.catalog)
        try {
          const response = await withClient(context, undefined, (client) => unwrap<{ data?: unknown[] }>(
            client.v2.model.list({ location: { directory: context.cwd } }),
            'model.list'
          ))
          const catalog = openCodeRunControlCatalog(response.data ?? [])
          modelCache.delete(cacheKey)
          modelCache.set(cacheKey, { expiresAt: Date.now() + 30_000, catalog })
          while (modelCache.size > 16) {
            const oldest = modelCache.keys().next().value
            if (oldest === undefined) break
            modelCache.delete(oldest)
          }
          return capabilityReady(context, 'read', catalog)
        } catch (error) {
          pool.recordFailure(error)
          return {
            ...capabilityReady(context, 'read', { models: [], permissions: permissionOptions() }),
            state: 'degraded' as const,
            reason: String((error as Error).message)
          }
        }
      }
    },
    skills: {
      list: async (context) => {
        try {
          const response = await withClient(context, undefined, (client) => unwrap<{ data?: unknown[] }>(
            client.v2.skill.list({ location: { directory: context.cwd } }),
            'skill.list'
          ))
          const data: SkillMeta[] = await Promise.all((response.data ?? []).map(async (raw) => {
            const skill = record(raw)
            const location = String(skill.location ?? '')
            return {
              name: String(skill.name ?? ''),
              dir: location,
              scope: context.cwd ? await openCodeSkillScope(context.cwd, location, homeDir) : 'unknown',
              description: String(skill.description ?? ''),
              enabled: true
            }
          }))
          return capabilityReady(context, 'read', data)
        } catch (error) {
          pool.recordFailure(error)
          return capabilityUnknown<SkillMeta[]>(context, 'read', String((error as Error).message))
        }
      }
    },
    commands: {
      list: async (context) => {
        try {
          const response = await withClient(context, undefined, (client) => unwrap<{ data?: unknown[] }>(
            client.v2.command.list({ location: { directory: context.cwd } }),
            'command.list'
          ))
          return capabilityReady(context, 'read', (response.data ?? []).map((raw) => {
            const command = record(raw)
            return { name: String(command.name ?? ''), description: String(command.description ?? ''), source: 'custom' as const }
          }))
        } catch (error) {
          pool.recordFailure(error)
          return capabilityUnknown(context, 'read', String((error as Error).message))
        }
      }
    },
    dispose: async () => {
      modelCache.clear()
      await pool.dispose()
    }
  }
}
const OPEN_CODE_MCP_AUTH_TIMEOUT_MS = 120_000
const OPEN_CODE_MCP_VERIFY_TIMEOUT_MS = 15_000

export { emitOpenCodeEvent, emitOpenCodeHookEvents, openCodeSkillScope } from './opencode-events'
export { handleOpenCodePermission, handleOpenCodeQuestion, openCodePermissionRules } from './opencode-permissions'
export { openCodeModelContextWindows, openCodeRunControlCatalog } from './opencode-controls'
export type { OpenCodeServerHealth, OpenCodeServerPool } from './opencode-server-pool'
