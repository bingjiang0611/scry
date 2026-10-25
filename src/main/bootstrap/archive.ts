import { app } from 'electron'
import { createHash } from 'node:crypto'
import {
  deleteTranscriptCopies,
  upsertTraceArchiveTurnAsync,
  type TraceArchiveTurn
} from '../transcript-archive'
import { restoreTraceArchiveTurn } from '../session-history'
import { prepareRunAttachments, storeAttachmentReference, deleteRunAttachments } from '../attachment-store'
import { isDiffPreviewStage, type TraceEvent } from '../../shared/trace'
import type { AgentInputAttachment, RuntimeProvider } from '../../shared/runtime'
import type { ProviderId } from '../../shared/provider'
import { aggregateTurnEvidence } from '../../core/turn-recorder/aggregate'
import { isManagedRecorderProvider, managedRecorderAllowsMissingProviderTurnId, type ManagedTurnTiming } from '../../core/turn-recorder/managed'
import { persistTraceTurnProgress, persistUnresolvedTraceTurnProgress, isProviderlessTerminalTurn, shouldUseManagedTerminalPersistence } from '../trace-turn-progress'
import { canonicalOrObservedTurnTiming, commitManagedTraceTurn, persistManagedTraceProgress } from '../managed-turn-commit'
import { deleteTraceTurnProgress } from '../trace-turn-progress'

export interface ArchiveTraceTurnArgs {
  agentProfileId: string | null
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  cwd: string | undefined
  sessionId: string | undefined
  providerTurnId?: string
  forkTurnId?: string
  runId: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done: boolean
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  error?: string
  errorHint?: string
  observedTiming?: ManagedTurnTiming
  commitHookEnv?: NodeJS.ProcessEnv
  managedRecorderEnabled: boolean
  beforePersist?: () => Promise<void>
}

export async function cloneForkArchiveTurns(args: {
  turns: TraceArchiveTurn[]
  targetSessionId: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  cwd: string
}): Promise<void> {
  const userDataDir = app.getPath('userData')
  const clonedRunIds: string[] = []
  try {
    for (const source of args.turns) {
      const runId = `fork-${createHash('sha256')
        .update(`${args.targetSessionId}\0${source.runId}`)
        .digest('hex')
        .slice(0, 24)}`
      clonedRunIds.push(runId)
      const restored = restoreTraceArchiveTurn(source, { userDataDir })
      const attachments = prepareRunAttachments(userDataDir, runId, restored.attachments ?? [], {
        providerId: args.providerId,
        cwd: args.cwd,
        sessionId: args.targetSessionId
      })
      const ok = await upsertTraceArchiveTurnAsync({
        cwd: args.cwd,
        sessionId: args.targetSessionId,
        providerId: args.providerId,
        runtimeProvider: args.runtimeProvider,
        userDataDir,
        turn: {
          // A copied prefix retains its original Profile evidence; legacy
          // unknown provenance must not be relabeled from the fork target.
          ...source,
          runId,
          attachments,
          items: source.items.map((event) => ({ ...event, runId }))
        }
      })
      if (!ok) throw new Error('Scry 无法复制分支前缀归档')
    }
  } catch (error) {
    deleteTranscriptCopies({
      cwd: args.cwd,
      sessionId: args.targetSessionId,
      userDataDir,
      providerId: args.providerId
    })
    for (const runId of clonedRunIds) deleteRunAttachments(userDataDir, runId)
    throw error
  }
}

export function observedTurnTiming(startedAt: string | undefined, completedAt: string): ManagedTurnTiming | undefined {
  if (!startedAt) return undefined
  const started = Date.parse(startedAt)
  const completed = Date.parse(completedAt)
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return undefined
  return { startedAt, completedAt, durationMs: Math.max(0, completed - started) }
}

export function buildTraceArchiveTurn(args: ArchiveTraceTurnArgs): {
  turn: TraceArchiveTurn
  timing: ManagedTurnTiming | null
} {
  // 运行中 Diff 预览只服务实时 UI：它是终态同一条 Git capture 的临时重算，
  // 落盘会在 archive 对账里重复计入 diff 证据，也会让重启后回放出过期临时快照。
  const persistedItems = args.items
    .filter((event) => !(event.kind === 'harness' && isDiffPreviewStage(event.stage)))
    .map((event) => {
      const { hookConfiguredCommands: _currentConfig, ...persisted } = event
      return persisted
    })
  const turnEvidence = aggregateTurnEvidence({
    userText: args.userText,
    events: persistedItems,
    source: 'scry_provider_adapter'
  })
  const timing = canonicalOrObservedTurnTiming(persistedItems, args.providerId, args.status, args.observedTiming)
  return {
    timing,
    turn: {
      agentProfileId: args.agentProfileId,
      runId: args.runId,
      ...(args.providerTurnId ? { providerTurnId: args.providerTurnId } : {}),
      ...(args.forkTurnId ? { forkTurnId: args.forkTurnId } : {}),
      userText: args.userText,
      attachments: args.attachments?.map((attachment) =>
        storeAttachmentReference(app.getPath('userData'), args.runId, attachment)
      ),
      items: persistedItems,
      turnEvidence,
      done: args.done,
      status: args.status,
      error: args.error,
      errorHint: args.errorHint,
      ...(timing ?? {}),
      ts: timing ? Date.parse(timing.completedAt) : Date.now()
    }
  }
}

export async function persistTerminalProgress(args: ArchiveTraceTurnArgs): Promise<void> {
  await args.beforePersist?.()
  const { turn, timing } = buildTraceArchiveTurn(args)
  const archiveCwd = args.cwd ?? ''
  const managedPolicy = args.managedRecorderEnabled && archiveCwd && isManagedRecorderProvider(args.providerId)
  if (args.managedRecorderEnabled && !managedPolicy) {
    throw new Error('managed recorder launch policy has no valid workspace/provider identity')
  }
  if (!args.sessionId) {
    // Provider 在产出任何内容前就失败时没有原生 session 可恢复；不能把这类失败（参数/权限
    // 校验、CLI 缺失、pinned recorder CLI 版本不符）持久化成永久 pending，否则用户修正环境后
    // 仍无法开始下一轮。
    if (isProviderlessTerminalTurn(turn)) return
    if (managedPolicy) {
      await persistUnresolvedTraceTurnProgress({
        userDataDir: app.getPath('userData'),
        cwd: archiveCwd,
        providerId: args.providerId,
        runtimeProvider: args.runtimeProvider,
        turn,
        reason: 'missing_provider_session_id'
      })
      throw new Error('managed recorder requires an authoritative Provider session id')
    }
    return
  }
  // managed Provider 可能在拿到原生 session id 后、真正建立 turn 边界前失败（例如
  // Pi 的 prompt/recorder preflight）。这种轮次只有 Scry harness 证据，不能伪装成
  // canonical `.scry` turn；但 session id 已足够作为 Scry 本地 archive key。若仍强制
  // providerTurnId，会同时丢掉输入与真实启动错误，只在 catalog 留下一个空壳会话。
  const useManagedPersistence = shouldUseManagedTerminalPersistence(Boolean(managedPolicy), turn)
  if (useManagedPersistence) {
    const permitsMissingProviderTurnId = managedRecorderAllowsMissingProviderTurnId(args.providerId, args.status)
    if (!args.providerTurnId && !permitsMissingProviderTurnId) {
      throw new Error('managed recorder requires an authoritative Provider turn id')
    }
    if (!timing) throw new Error('managed recorder requires canonical Provider or observed interruption timing')
    await persistManagedTraceProgress({
      cwd: archiveCwd,
      sessionId: args.sessionId,
      providerTurnId: args.providerTurnId,
      providerId: args.providerId,
      runtimeProvider: args.runtimeProvider,
      userDataDir: app.getPath('userData'),
      turn,
      timing,
      status: args.status
    })
    return
  }
  await persistTraceTurnProgress({
    userDataDir: app.getPath('userData'),
    cwd: archiveCwd,
    sessionId: args.sessionId,
    providerId: args.providerId,
    runtimeProvider: args.runtimeProvider,
    turn
  })
}

export async function archiveTraceTurn(args: ArchiveTraceTurnArgs): Promise<void> {
  await args.beforePersist?.()
  const archiveCwd = args.cwd ?? ''
  const managedPolicy = args.managedRecorderEnabled && archiveCwd && isManagedRecorderProvider(args.providerId)
  if (args.managedRecorderEnabled && !managedPolicy) {
    throw new Error('managed recorder launch policy has no valid workspace/provider identity')
  }
  if (!args.sessionId) {
    if (isProviderlessTerminalTurn(args)) return
    if (managedPolicy) {
      throw new Error('managed recorder requires an authoritative Provider session id')
    }
    return
  }
  const { turn, timing } = buildTraceArchiveTurn(args)
  const useManagedPersistence = shouldUseManagedTerminalPersistence(Boolean(managedPolicy), turn)
  if (useManagedPersistence) {
    if (!timing) {
      throw new Error('managed recorder requires canonical Provider or observed interruption timing')
    }
    const permitsMissingProviderTurnId = managedRecorderAllowsMissingProviderTurnId(args.providerId, args.status)
    if (!args.providerTurnId && !permitsMissingProviderTurnId) {
      throw new Error('managed recorder requires an authoritative Provider turn id')
    }
    if (timing) {
      await commitManagedTraceTurn({
        cwd: archiveCwd,
        sessionId: args.sessionId,
        providerTurnId: args.providerTurnId,
        providerId: args.providerId,
        runtimeProvider: args.runtimeProvider,
        userDataDir: app.getPath('userData'),
        turn,
        timing,
        status: args.status
      }, { commitHookEnv: args.commitHookEnv, requireManaged: true })
      return
    }
  }
  const ok = await upsertTraceArchiveTurnAsync({
    cwd: archiveCwd,
    sessionId: args.sessionId,
    providerId: args.providerId,
    runtimeProvider: args.runtimeProvider,
    userDataDir: app.getPath('userData'),
    turn
  })
  if (!ok) throw new Error(`trace archive write failed for ${args.runId}`)
  await deleteTraceTurnProgress(app.getPath('userData'), args.runId)
}
