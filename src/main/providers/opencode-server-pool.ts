import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { ProviderContext } from '../../shared/provider'
import { resolveRuntimeCliBin } from '../claude-locate'
import { AgentRuntimeError } from '../run-outcome'
import { sanitizeMcpAuthError } from './mcp-auth-security'
import type { OpenCodeProjectPluginAuthorization } from '../opencode-plugin-trust'
import {
  OpenCodeServerManager,
  OpenCodeProjectPluginSecurityError,
  type OpenCodeServerState
} from './opencode-server'
import type { AuthorizedMcpExecution } from './types'
import {
  SESSION_POOL_CAP,
  sessionIdleWindowMs,
  type SessionLifecycleObserver,
  type SessionReleaseReason
} from './session-pool-policy'

/**
 * One OpenCode server per canonical cwd, shared by every conversation in that
 * workspace. Runs therefore only ever hold a reference-counted lease: a
 * workspace-level `forceClose()` is still `shared_transport`, and the adapter
 * must not present it as a run-scoped kill.
 */
export interface OpenCodeServerLease {
  release(): void
  forceClose(): void
  /** A5: the shared server currently has exactly one active run (this lease). */
  isExclusive(): boolean
}

export interface OpenCodeServerHealth {
  lastOkAt?: number
  lastErrorAt?: number
  lastError?: string
  current?: { cwd?: string; pid?: number }
  unexpectedExitAt?: number
}

export interface OpenCodeServerPool {
  serverFor(
    context: ProviderContext,
    mcpExecution?: AuthorizedMcpExecution,
    pluginTrust?: OpenCodeProjectPluginAuthorization
  ): Promise<OpenCodeServerState>
  withClient<T>(
    context: ProviderContext,
    mcpExecution: AuthorizedMcpExecution | undefined,
    action: (client: OpencodeClient) => Promise<T>
  ): Promise<T>
  /** Holds the shared server open for a run; `undefined` when no cwd is known. */
  lease(cwd: string | undefined): OpenCodeServerLease | undefined
  recordOk(): void
  recordFailure(error: unknown): void
  /** Launch diagnostic handle for the shared server of one workspace, when it exists. */
  diagnosticHandle(cwd: string | undefined): Pick<OpenCodeServerManager, 'diagnostic'> | undefined
  health(): OpenCodeServerHealth
  /** A private manager for one MCP OAuth flow; released by the caller. */
  authManager(): OpenCodeServerManager
  releaseManager(manager: OpenCodeServerManager): Promise<void>
  dispose(): Promise<void>
  readonly closed: boolean
}

export function createOpenCodeServerPool(
  executable: () => string | undefined,
  privateMcpAuthDirectory?: string,
  sessionStateRoot?: string,
  sessions?: SessionLifecycleObserver,
  options: { sessionIdleMs?: number; metadataIdleMs?: number; maxServers?: number } = {}
): OpenCodeServerPool {
  // A session keeps its server for the C1 window; a metadata read only leases it briefly, because a
  // 20-minute retention for one config read would pin a server nobody is using.
  const SESSION_IDLE_MS = options.sessionIdleMs ?? sessionIdleWindowMs(process.env, 'SCRY_OPENCODE_IDLE_MS')
  const METADATA_IDLE_MS = options.metadataIdleMs ?? 90_000
  const SERVER_CAP = options.maxServers ?? SESSION_POOL_CAP
  const managers = new Map<string, OpenCodeServerManager>()
  const ownedManagers = new Set<OpenCodeServerManager>()
  let disposed = false
  const closeManager = async (manager: OpenCodeServerManager): Promise<void> => {
    await manager.close()
    ownedManagers.delete(manager)
  }
  const releaseReason = new WeakMap<OpenCodeServerManager, SessionReleaseReason>()
  const keyOfManager = (manager: OpenCodeServerManager): string | undefined => {
    for (const [key, cached] of managers) if (cached === manager) return key
    return undefined
  }
  const retireManager = (manager: OpenCodeServerManager, reason: SessionReleaseReason = 'dispose'): void => {
    const key = keyOfManager(manager)
    releaseReason.set(manager, releaseReason.get(manager) ?? reason)
    // Failed cleanup retains ownership for shutdown/escalation; a sent signal is not exit.
    void closeManager(manager)
      .then(() => {
        // Idle and LRU already reported their reason when they left the map; only dispose reports here.
        if (reason === 'dispose' && key !== undefined) {
          sessions?.onReleased?.(key, releaseReason.get(manager) ?? reason, Date.now())
        }
      })
      .catch((error) => console.warn('[scry] OpenCode cleanup failed:', error))
  }
  const managerActivity = new Map<OpenCodeServerManager, number>()
  const managerLastUsed = new Map<OpenCodeServerManager, number>()
  const managerIdleTimers = new Map<OpenCodeServerManager, ReturnType<typeof setTimeout>>()
  const evictIdleManagers = (protectedManager?: OpenCodeServerManager): void => {
    if (managers.size <= SERVER_CAP) return
    const idle = [...managers.entries()]
      .filter(([, manager]) => manager !== protectedManager && (managerActivity.get(manager) ?? 0) === 0)
      .sort(([, left], [, right]) => (managerLastUsed.get(left) ?? 0) - (managerLastUsed.get(right) ?? 0))
    for (const [cwd, manager] of idle.slice(0, Math.max(0, managers.size - SERVER_CAP))) {
      managers.delete(cwd)
      managerLastUsed.delete(manager)
      const timer = managerIdleTimers.get(manager)
      if (timer) clearTimeout(timer)
      managerIdleTimers.delete(manager)
      sessions?.onReleased?.(cwd, 'lru', Date.now())
      retireManager(manager, 'lru')
    }
  }
  const scheduleManagerClose = (cwd: string, manager: OpenCodeServerManager, idleMs: number): void => {
    if (disposed) return
    const previous = managerIdleTimers.get(manager)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      managerIdleTimers.delete(manager)
      if ((managerActivity.get(manager) ?? 0) > 0 || managers.get(cwd) !== manager) {
        if (managers.get(cwd) === manager) scheduleManagerClose(cwd, manager, idleMs)
        return
      }
      const key = keyOfManager(manager) ?? cwd
      managers.delete(cwd)
      managerActivity.delete(manager)
      managerLastUsed.delete(manager)
      releaseReason.set(manager, 'idle')
      sessions?.onReleased?.(key, 'idle', Date.now())
      retireManager(manager, 'idle')
    }, idleMs)
    timer.unref()
    managerIdleTimers.set(manager, timer)
  }
  const managerFor = (cwd: string): OpenCodeServerManager => {
    if (disposed) throw new Error('OpenCode adapter 已关闭')
    let manager = managers.get(cwd)
    if (!manager) {
      manager = new OpenCodeServerManager(executable, privateMcpAuthDirectory, {}, sessionStateRoot)
      managers.set(cwd, manager)
      sessions?.onOpened?.(cwd, 'opencode', Date.now())
      ownedManagers.add(manager)
    }
    const timer = managerIdleTimers.get(manager)
    if (timer) clearTimeout(timer)
    managerIdleTimers.delete(manager)
    managerLastUsed.set(manager, Date.now())
    evictIdleManagers(manager)
    return manager
  }
  let lastOkAt: number | undefined
  let lastErrorAt: number | undefined
  let lastError: string | undefined
  const rememberFailure = (error: unknown): void => {
    const message = sanitizeMcpAuthError(error)
    if (message === 'OpenCode 需要工作目录') return
    lastErrorAt = Date.now()
    lastError = message
  }

  const serverFor = async (
    context: ProviderContext,
    mcpExecution?: AuthorizedMcpExecution,
    pluginTrust?: OpenCodeProjectPluginAuthorization
  ): Promise<OpenCodeServerState> => {
    if (!context.cwd) throw new Error('OpenCode 需要工作目录')
    const manager = managerFor(context.cwd)
    try {
      const state = await manager.ensure(context.cwd, mcpExecution, pluginTrust)
      lastOkAt = Date.now()
      lastError = undefined
      return state
    } catch (error) {
      rememberFailure(error)
      if (error instanceof OpenCodeProjectPluginSecurityError) {
        throw new AgentRuntimeError(error.message, {
          provider: 'opencode_server',
          stage: 'capability',
          cwd: context.cwd,
          nextAction: '项目 plugin 声明、内容或授权已变化；请重新发送任务以重验并自动授权最新 OpenCode plugin'
        })
      }
      throw error
    } finally {
      scheduleManagerClose(context.cwd, manager, METADATA_IDLE_MS)
    }
  }

  return {
    serverFor,
    withClient: async <T>(
      context: ProviderContext,
      mcpExecution: AuthorizedMcpExecution | undefined,
      action: (client: OpencodeClient) => Promise<T>
    ): Promise<T> => {
      if (!context.cwd) throw new Error('OpenCode 需要工作目录')
      const manager = managerFor(context.cwd)
      managerActivity.set(manager, (managerActivity.get(manager) ?? 0) + 1)
      try {
        return await action((await serverFor(context, mcpExecution)).client)
      } finally {
        const active = Math.max(0, (managerActivity.get(manager) ?? 1) - 1)
        if (active > 0) managerActivity.set(manager, active)
        else managerActivity.delete(manager)
        managerLastUsed.set(manager, Date.now())
        scheduleManagerClose(context.cwd, manager, METADATA_IDLE_MS)
        evictIdleManagers()
      }
    },
    lease: (cwd) => {
      if (!cwd) return undefined
      const manager = managerFor(cwd)
      managerActivity.set(manager, (managerActivity.get(manager) ?? 0) + 1)
      let released = false
      return {
        forceClose: () => manager.forceClose(),
        isExclusive: () => !released && (managerActivity.get(manager) ?? 0) === 1,
        release: () => {
          if (released) return
          released = true
          const active = Math.max(0, (managerActivity.get(manager) ?? 1) - 1)
          if (active > 0) managerActivity.set(manager, active)
          else managerActivity.delete(manager)
          managerLastUsed.set(manager, Date.now())
          scheduleManagerClose(cwd, manager, SESSION_IDLE_MS)
        }
      }
    },
    recordOk: () => {
      lastOkAt = Date.now()
      lastError = undefined
    },
    recordFailure: rememberFailure,
    diagnosticHandle: (cwd) => managers.get(cwd ?? ''),
    health: () => {
      const current = [...managers.values()].map((manager) => manager.state).find((state) => state != null)
      const unexpectedExit = [...managers.values()]
        .map((manager) => manager.diagnostic.lastExit)
        .filter((exit) => exit && !exit.expected)
        .sort((left, right) => (right?.at ?? 0) - (left?.at ?? 0))[0]
      return {
        lastOkAt,
        lastErrorAt: lastErrorAt ?? unexpectedExit?.at,
        lastError: lastError ?? (unexpectedExit
          ? `OpenCode 本地 server 已退出（${unexpectedExit.code ?? unexpectedExit.signal ?? 'unknown'}）`
          : undefined),
        ...(current ? { current: { cwd: current.cwd, pid: current.pid } } : {})
      }
    },
    authManager: () => {
      if (disposed) throw new Error('OpenCode adapter 已关闭')
      const manager = new OpenCodeServerManager(executable, privateMcpAuthDirectory, {
        completeTargetInventory: false
      })
      ownedManagers.add(manager)
      return manager
    },
    releaseManager: closeManager,
    dispose: async () => {
      disposed = true
      for (const timer of managerIdleTimers.values()) clearTimeout(timer)
      managerIdleTimers.clear()
      managerActivity.clear()
      managerLastUsed.clear()
      // The release record needs the key, and the map is the only place that knows it.
      const closing = [...ownedManagers].map((manager) => ({ manager, key: keyOfManager(manager) }))
      managers.clear()
      const results = await Promise.allSettled(closing.map(({ manager }) => manager.close()))
      for (const { manager, key } of closing) {
        ownedManagers.delete(manager)
        if (key !== undefined) sessions?.onReleased?.(key, releaseReason.get(manager) ?? 'dispose', Date.now())
      }
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'OpenCode cleanup incomplete')
    },
    get closed() {
      return disposed
    }
  }
}

/** The CLI path the pool launches; identity checks must hash the same resolution. */
export function openCodeExecutable(): string | undefined {
  return process.env.SCRY_OPENCODE_PATH?.trim() || resolveRuntimeCliBin('opencode')
}
