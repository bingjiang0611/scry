import { publishPersistedPiSession } from './pi-session-proof'
import type { PiAgentProfile } from '../pi-agent-profiles'
import { completedPiTurnForkTarget } from './session-fork-boundary'
import { HistoricalInput } from './historical-input'
import type { ProviderAdapter, ProviderRunHandle, ProviderRunRequest, ProviderRunResult } from './types'
import type { ProviderContext, ProviderDescriptor } from '../../shared/provider'
import { capabilityReady, capabilityUnavailable } from '../../shared/provider'
import { PerformanceTrace, performanceRecordingEnabled } from '../performance-timing'
import { piContinuationKey, piRpcEnvironment, PI_RPC_STARTUP_TIMEOUT_MS } from './pi-runtime'
import { RotomRpcPool } from './pi-rpc'
import type { PiProbe, PiRunState } from './pi-types'
import type { PiRunDiagnostics } from './pi-run-diagnostics'
import { runPiAgent } from './pi-run'
import { record } from './pi-shared'
import { piRpcArgs, withPiRpc, probePiAgent, disposePiCatalog, commandCatalog, skillCatalog, piModelContextWindows, piHistoryNeedsModelCatalog, enrichPiHistory, runControlCatalog } from './pi-catalog'


export function createPiAdapter(options: {
  diagnostics?: PiRunDiagnostics
  listProfiles: () => Promise<PiAgentProfile[]>
  resolveProfile: (id: string) => Promise<PiAgentProfile | undefined>
  /** Fixed App resource, not a profile/repository/renderer input. */
  historyExtensionPath?: string
  /** Tests may lower the frame residency boundary without allocating tens of MiB. */
  rpcMaxFrameBytes?: number
}): ProviderAdapter {
  const rotomPool = new RotomRpcPool()
  const profileForContext = async (context: ProviderContext): Promise<PiAgentProfile> => {
    if (!context.agentProfileId) throw new Error('Pi Provider 缺少 agentProfileId')
    const profile = await options.resolveProfile(context.agentProfileId)
    if (!profile) throw new Error(`Pi Agent Profile 不存在：${context.agentProfileId}`)
    return profile
  }
  const readProbe = async (context: ProviderContext): Promise<PiProbe> => {
    const trace = performanceRecordingEnabled() ? new PerformanceTrace('pi.catalog.read', { provider: 'pi' }) : undefined
    try {
      const profile = await profileForContext(context)
      trace?.mark('profile_resolved')
      const probe = await probePiAgent(profile, context.cwd)
      trace?.mark('probe_settled')
      trace?.finish()
      return probe
    } catch (error) {
      trace?.finish(undefined, 'error')
      throw error
    }
  }
  return {
    id: 'pi',
    runtimeProvider: 'pi_rpc',
    historicalContext: true,
    ...(options.historyExtensionPath ? { historyReader: true as const } : {}),
    async continuationKey(context: ProviderContext): Promise<string> {
      const profile = await profileForContext(context)
      const env = await piRpcEnvironment(profile)
      return piContinuationKey(profile, context.cwd, env)
    },
    async describe(): Promise<ProviderDescriptor> {
      const profiles = await options.listProfiles().catch(() => [])
      return {
        id: 'pi',
        label: 'Pi',
        runtimeProvider: 'pi_rpc',
        transport: 'JSONL RPC subprocess',
        available: profiles.length > 0,
        path: profiles[0]?.executable,
        disabledReason: profiles.length > 0 ? undefined : '未检测到 Pi 或已保存的 Pi Agent Profile',
        capabilities: { skills: 'read', mcp: 'none', commands: 'read', account: 'none' },
        health: { state: profiles.length > 0 ? 'ready' : 'unavailable', transport: 'JSONL RPC subprocess' }
      }
    },
    forkLastTurn: {
      async fork(request) {
        if (!request.agentProfileId) throw new Error('Pi 分支缺少 agentProfileId')
        const profile = await options.resolveProfile(request.agentProfileId)
        if (!profile) throw new Error(`Pi Agent Profile 不存在：${request.agentProfileId}`)
        return withPiRpc(
          profile,
          request.cwd,
          piRpcArgs({ session: request.sourceSessionId }),
          async (rpc) => {
            const snapshot = await rpc.send({ type: 'get_entries' }, PI_RPC_STARTUP_TIMEOUT_MS)
            const entries = record(snapshot.data).entries
            const target = Array.isArray(entries)
              ? entries.map(record).find((entry) => entry.id === request.replaceForkTurnId)
              : undefined
            if (!target || record(target.message).role !== 'user') {
              throw new Error('Pi 会话无法定位待替换的用户消息 entry')
            }
            const forked = await rpc.send({ type: 'fork', entryId: request.replaceForkTurnId }, null)
            if (record(forked.data).cancelled === true) throw new Error('Pi extension 取消了会话分支')
            const state = record((await rpc.send({ type: 'get_state' })).data)
            if (typeof state.sessionId !== 'string' || !state.sessionId) throw new Error('Pi fork 未返回新 sessionId')
            return { externalSessionId: state.sessionId }
          }
        )
      }
    },
    forkSession: {
      async fork(request) {
        if (!request.agentProfileId) throw new Error('Pi 分支缺少 agentProfileId')
        const profile = await options.resolveProfile(request.agentProfileId)
        if (!profile) throw new Error(`Pi Agent Profile 不存在：${request.agentProfileId}`)
        // Launching Pi can run extensions, so fence startup as well as the fork RPC below.
        await request.beforeFork?.()
        return withPiRpc(
          profile,
          request.cwd,
          piRpcArgs({ session: request.sourceSessionId }),
          async (rpc) => {
            const snapshot = record((await rpc.send({ type: 'get_entries' }, PI_RPC_STARTUP_TIMEOUT_MS)).data)
            const rawEntries = Array.isArray(snapshot.entries) ? snapshot.entries.map(record) : []
            if (typeof snapshot.leafId !== 'string' || !snapshot.leafId) {
              throw new Error('Pi 会话缺少 active leaf，无法创建分支')
            }
            const target = completedPiTurnForkTarget(rawEntries.map((entry) => ({
              id: typeof entry.id === 'string' ? entry.id : undefined,
              parentId: typeof entry.parentId === 'string' || entry.parentId === null ? entry.parentId : undefined,
              type: typeof entry.type === 'string' ? entry.type : undefined,
              role: typeof record(entry.message).role === 'string' ? String(record(entry.message).role) : undefined
            })), snapshot.leafId, request.sourceForkTurnId)
            await request.beforeFork?.()
            const forked = target.operation === 'fork_before'
              ? await rpc.send({ type: 'fork', entryId: target.entryId }, null)
              : await rpc.send({ type: 'clone' }, null)
            if (record(forked.data).cancelled === true) throw new Error('Pi extension 取消了会话分支')
            const state = record((await rpc.send({ type: 'get_state' })).data)
            if (typeof state.sessionId !== 'string' || !state.sessionId) throw new Error('Pi fork 未返回新 sessionId')
            return { externalSessionId: state.sessionId }
          }
        )
      }
    },
    run(request: ProviderRunRequest): ProviderRunHandle {
      const state: PiRunState = { stopped: false, diagnostics: options.diagnostics }
      options.diagnostics?.record(request.runId, 'profile_lookup', { stopRequested: false })
      const history = new HistoricalInput(request.expectedContinuationKey
        ? { ...request, trackInputReceipt: true }
        : request)
      const promise = (async () => {
        if (!request.agentProfileId) throw new Error('Pi Provider run 缺少 agentProfileId')
        const profile = await options.resolveProfile(request.agentProfileId)
        if (!profile) throw new Error(`Pi Agent Profile 不存在：${request.agentProfileId}`)
        let result: ProviderRunResult
        try {
          result = await runPiAgent(profile, request, state, options.rpcMaxFrameBytes, rotomPool, history, options.historyExtensionPath)
        } finally {
          // Prompt admission can race a stop/transport exit. Recheck after transport
          // cleanup, including failures, so persisted history remains resumable.
          publishPersistedPiSession(request, state)
        }
        return { ...result, externalSessionId: state.persistedSessionId }
      })().then(result => {
        options.diagnostics?.record(request.runId, 'provider_returned', {
          providerStatus: result.status, stopRequested: state.stopped
        })
        return result
      }, error => {
        options.diagnostics?.record(request.runId, 'provider_rejected', { stopRequested: state.stopped })
        throw error
      })
      return {
        promise,
        interrupt: () => {
          state.stopped = true
          state.rpc?.notify({ type: 'abort' })
          setTimeout(() => state.rpc?.abort(), 2_000)
        },
        steer: (input) => state.steer?.(input) ?? Promise.resolve({
          status: 'unavailable', message: 'Pi native run 尚未准备好'
        }),
        forceKill: () => {
          state.stopped = true
          state.rpc?.forceTerminate()
        },
        // 每轮 run 自己 spawn 一个 Pi RPC 子进程：SIGKILL 不会波及其他 run。
        forceKillScope: 'run_scoped',
        getExternalSessionId: () => state.persistedSessionId,
        getProviderTurnId: () => state.providerTurnId,
        getInputReceipt: () => history.snapshot(),
        getRecordingFailure: () => state.recordingFailure
      }
    },
    async invalidateContext(context) {
      await disposePiCatalog()
      return rotomPool.invalidate(context)
    },
    async dispose() {
      await disposePiCatalog()
      await rotomPool.dispose()
      await options.diagnostics?.flush()
    },
    sessionEvidence: {
      async enrich(context, turns) {
        if (!piHistoryNeedsModelCatalog(turns)) return turns
        try {
          const probe = await probePiAgent(await profileForContext(context), context.cwd)
          return enrichPiHistory(turns, piModelContextWindows(probe.models))
        } catch {
          return turns
        }
      }
    },
    skills: {
      async list(context) {
        try {
          return capabilityReady(context, 'read', skillCatalog(await readProbe(context)))
        } catch (error) {
          return capabilityUnavailable(context, 'unknown', `Pi Skill 目录探测失败：${String((error as Error).message)}`)
        }
      }
    },
    commands: {
      async list(context) {
        try {
          return capabilityReady(context, 'read', commandCatalog(await readProbe(context)))
        } catch (error) {
          return capabilityUnavailable(context, 'unknown', `Pi 命令目录探测失败：${String((error as Error).message)}`)
        }
      }
    },
    runControls: {
      async read(context) {
        try {
          return capabilityReady(context, 'read', runControlCatalog(await readProbe(context)))
        } catch (error) {
          return capabilityUnavailable(context, 'unknown', `Pi 运行能力探测失败：${String((error as Error).message)}`)
        }
      }
    }
  }
}

export { piContinuationKey, piRpcEnvironment, PI_RPC_COMMAND_TIMEOUT_MS, PI_RPC_STARTUP_TIMEOUT_MS, PI_RPC_MAX_FRAME_BYTES } from './pi-runtime'
export { piUserEntryIdAfterBaseline } from './pi-entry-proof'
export { probePiAgent } from './pi-catalog'
export { questionFromExtension } from './pi-events'
