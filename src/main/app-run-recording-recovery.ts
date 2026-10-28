import type { RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import type { resolveRecorderEnablement } from '../core/turn-recorder/config'
import { isManagedRecorderProvider, managedRecorderMode, recoverManagedRecorderTurns } from '../core/turn-recorder/managed'
import { AgentRuntimeError } from './run-outcome'
import { recoverManagedTraceProgress, recoverManagedTraceTurns } from './managed-turn-commit'
import { recoverTraceTurnProgress } from './trace-turn-progress'
import type { createProviderTrust } from './provider-trust'
import type { PerformanceTrace } from './performance-timing'
import { appRunRecordingRecoveryCopy as copy } from '../shared/constants/app-run-recording-recovery-copy'

// The recorder recovery callback must observe current run ownership on every artifact;
// it is deliberately not a startup snapshot.
type ManagedRecorderRecoveryOptions = NonNullable<Parameters<typeof recoverManagedRecorderTurns>[2]>
type IsLiveManagedRun = NonNullable<ManagedRecorderRecoveryOptions['isLiveManagedRun']>
type ResolveManagedCommitHookEnv = ReturnType<typeof createProviderTrust>['resolveManagedCommitHookEnv']
type RecorderEnablement = Awaited<ReturnType<typeof resolveRecorderEnablement>>

export async function recoverAppRunRecording(deps: {
  userDataDir: () => string
  cwd: string | undefined
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  resume: string | undefined
  isAuthoringRun: boolean
  resolveManagedCommitHookEnv: ResolveManagedCommitHookEnv
  isLiveManagedRun: IsLiveManagedRun
  startPerf: Pick<PerformanceTrace, 'mark'>
}) {
  const traceProgressRecovery = deps.cwd
    ? await recoverTraceTurnProgress(deps.userDataDir(), {
        cwd: deps.cwd,
        providerId: deps.providerId,
        ...(deps.resume ? { sessionId: deps.resume } : {}),
        isLiveManagedRun: deps.isLiveManagedRun
      })
    : { recovered: 0, pending: 0, errors: [] }
  deps.startPerf.mark('trace_progress_recovery_ready', { recovered: traceProgressRecovery.recovered })
  if (traceProgressRecovery.pending > 0) {
    throw new AgentRuntimeError(copy.tracePending(traceProgressRecovery.pending), {
      provider: deps.runtimeProvider,
      stage: 'frontdoor',
      cwd: deps.cwd,
      nextAction: copy.traceNextAction
    })
  }

  let managedRecorderEnabled = false
  let managedRecorderEnablement: RecorderEnablement | undefined
  let managedCommitHookEnv: NodeJS.ProcessEnv | undefined
  let recoveredManagedTurns = traceProgressRecovery.recovered
  // Candidate authoring keeps App trace/usage evidence, but must not execute a
  // workspace recorder or commit callback before a program has been approved.
  if (!deps.isAuthoringRun && isManagedRecorderProvider(deps.providerId) && deps.cwd) {
    const recorderMode = await managedRecorderMode(deps.cwd)
    managedRecorderEnabled = recorderMode.status === 'enabled'
    managedRecorderEnablement = recorderMode.status === 'enabled' ? recorderMode.enablement : undefined
    managedCommitHookEnv = managedRecorderEnabled
      ? await deps.resolveManagedCommitHookEnv(deps.cwd, managedRecorderEnablement)
      : undefined
    const journalRecovery = await recoverManagedTraceTurns(deps.userDataDir(), {
      cwd: deps.cwd,
      providerId: deps.providerId,
      ...(deps.resume ? { sessionId: deps.resume } : {}),
      waitMs: 250,
      commitHookEnv: managedCommitHookEnv,
      isLiveManagedRun: deps.isLiveManagedRun
    })
    const progressRecovery = await recoverManagedTraceProgress(deps.userDataDir(), {
      cwd: deps.cwd,
      providerId: deps.providerId,
      ...(deps.resume ? { sessionId: deps.resume } : {}),
      waitMs: 250,
      commitHookEnv: managedCommitHookEnv,
      isLiveManagedRun: deps.isLiveManagedRun
    })
    // 本进程知道哪些 run 还活着，所以可以安全地弃掉“没有 Provider 证据且主已不在”的 provisional 轮次，
    // 不再把这个工作区永久卡在“仍有 N 轮待恢复”。真有证据的轮次仍然 fail closed。
    const abandonProvisionalOptions = {
      provider: deps.providerId,
      // A pending canonical journal may still need its provisional lifecycle. Never discard that
      // identity merely because the originating in-memory run ended; recovery must get first use.
      abandonProvisional: journalRecovery.pending === 0 && progressRecovery.pending === 0,
      // 发送前的恢复检查不能同步排仓库回调积压，否则会卡在“正在启动”。
      commitNotifications: 'detach' as const,
      isLiveManagedRun: deps.isLiveManagedRun
    }
    const recorderRecovery = deps.resume
      ? await recoverManagedRecorderTurns(deps.cwd, managedCommitHookEnv, { ...abandonProvisionalOptions, sessionId: deps.resume })
      : await recoverManagedRecorderTurns(deps.cwd, managedCommitHookEnv, abandonProvisionalOptions)
    // 同一轮可能同时留下 progress、journal 与 recorder open；三层计数不能相加，
    // 否则会把一个待恢复 turn 报成三轮。这里只需要 fail closed。
    const pending = Math.max(progressRecovery.pending, journalRecovery.pending, recorderRecovery.pending)
    recoveredManagedTurns += progressRecovery.recovered + journalRecovery.recovered + recorderRecovery.recovered
    deps.startPerf.mark('managed_recording_recovery_ready', { recovered: recoveredManagedTurns })
    if (pending > 0) {
      throw new AgentRuntimeError(copy.managedPending(pending), {
        provider: deps.runtimeProvider,
        stage: 'frontdoor',
        cwd: deps.cwd,
        nextAction: copy.managedNextAction
      })
    }
  }
  return { managedRecorderEnabled, managedRecorderEnablement, managedCommitHookEnv, recoveredManagedTurns }
}
