import type { ProviderId } from '../../shared/provider'
import type { RuntimeProvider } from '../../shared/runtime'
import { AgentRuntimeError } from '../run-outcome'
import { PerformanceTrace } from '../performance-timing'
import { recoverTraceTurnProgress } from '../trace-turn-progress'
import { isManagedRecorderProvider, managedRecorderMode, recoverManagedRecorderTurns } from '../../core/turn-recorder/managed'
import { resolveRecorderEnablement } from '../../core/turn-recorder/config'
import { resolveManagedCommitHookEnv } from './trust'
import { recoverManagedTraceProgress, recoverManagedTraceTurns } from '../managed-turn-commit'

type RecoveryDeps = {
  userDataDir: string
  startPerf: PerformanceTrace
}

export async function prepareRunRecovery(input: {
  cwd: string | undefined
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  resume: string | undefined
  isLiveManagedRun: (candidate: string | undefined, nativeIdentity?: { provider: ProviderId; sessionId: string; providerTurnId?: string }) => boolean
}, deps: RecoveryDeps) {
  const traceProgressRecovery = input.cwd
    ? await recoverTraceTurnProgress(deps.userDataDir, {
      cwd: input.cwd,
      providerId: input.providerId,
      ...(input.resume ? { sessionId: input.resume } : {}),
      isLiveManagedRun: input.isLiveManagedRun
    })
    : { recovered: 0, pending: 0, errors: [] }
  deps.startPerf.mark('trace_progress_recovery_ready', { recovered: traceProgressRecovery.recovered })
  if (traceProgressRecovery.pending > 0) {
    throw new AgentRuntimeError(`Scry trace 仍有 ${traceProgressRecovery.pending} 轮待恢复`, {
      provider: input.runtimeProvider,
      stage: 'frontdoor',
      cwd: input.cwd,
      nextAction: '保留 Scry userData/trace-turn-progress，修复 archive 写入后重试'
    })
  }
  let managedRecorderEnabled = false
  let managedRecorderEnablement: Awaited<ReturnType<typeof resolveRecorderEnablement>> | undefined
  let managedCommitHookEnv: NodeJS.ProcessEnv | undefined
  let recoveredManagedTurns = traceProgressRecovery.recovered
  if (isManagedRecorderProvider(input.providerId) && input.cwd) {
    const recorderMode = await managedRecorderMode(input.cwd)
    managedRecorderEnabled = recorderMode.status === 'enabled'
    managedRecorderEnablement = recorderMode.status === 'enabled' ? recorderMode.enablement : undefined
    managedCommitHookEnv = managedRecorderEnabled
      ? await resolveManagedCommitHookEnv(input.cwd, managedRecorderEnablement)
      : undefined
    const journalRecovery = await recoverManagedTraceTurns(deps.userDataDir, {
      cwd: input.cwd,
      providerId: input.providerId,
      ...(input.resume ? { sessionId: input.resume } : {}),
      waitMs: 250,
      commitHookEnv: managedCommitHookEnv,
      isLiveManagedRun: input.isLiveManagedRun
    })
    const progressRecovery = await recoverManagedTraceProgress(deps.userDataDir, {
      cwd: input.cwd,
      providerId: input.providerId,
      ...(input.resume ? { sessionId: input.resume } : {}),
      waitMs: 250,
      commitHookEnv: managedCommitHookEnv,
      isLiveManagedRun: input.isLiveManagedRun
    })
    // 本进程知道哪些 run 还活着，所以可以安全地弃掉“没有 Provider 证据且主已不在”的 provisional 轮次，
    // 不再把这个工作区永久卡在“仍有 N 轮待恢复”。真有证据的轮次仍然 fail closed。
    const abandonProvisionalOptions = {
      provider: input.providerId,
      // A pending canonical journal may still need its provisional lifecycle. Never discard that
      // identity merely because the originating in-memory run ended; recovery must get first use.
      abandonProvisional: journalRecovery.pending === 0 && progressRecovery.pending === 0,
      // 发送前的恢复检查不能同步排仓库回调积压，否则会卡在“正在启动”。
      commitNotifications: 'detach' as const,
      isLiveManagedRun: input.isLiveManagedRun
    }
    const recorderRecovery = input.resume
      ? await recoverManagedRecorderTurns(input.cwd, managedCommitHookEnv, { ...abandonProvisionalOptions, sessionId: input.resume })
      : await recoverManagedRecorderTurns(input.cwd, managedCommitHookEnv, abandonProvisionalOptions)
    // 同一轮可能同时留下 progress、journal 与 recorder open；三层计数不能相加，
    // 否则会把一个待恢复 turn 报成三轮。这里只需要 fail closed。
    const pending = Math.max(progressRecovery.pending, journalRecovery.pending, recorderRecovery.pending)
    recoveredManagedTurns += progressRecovery.recovered + journalRecovery.recovered + recorderRecovery.recovered
    deps.startPerf.mark('managed_recording_recovery_ready', { recovered: recoveredManagedTurns })
    if (pending > 0) {
      throw new AgentRuntimeError(`Scry 精确记录仍有 ${pending} 轮待恢复`, {
        provider: input.runtimeProvider,
        stage: 'frontdoor',
        cwd: input.cwd,
        nextAction: '保留当前工作区与 Scry Test 数据目录，先运行 scry doctor 并修复 pending canonical journal'
      })
    }
  }
  return { managedRecorderEnabled, managedRecorderEnablement, managedCommitHookEnv, recoveredManagedTurns }
}
