import { app } from 'electron'
import type { ActiveRun } from '../../shared/trace'
import type { ConversationStore } from '../conversation-store'
import type { PerformanceTrace } from '../performance-timing'
import { replayDatabaseTurnOutbox } from '../db'
import { cleanupAppStoreAtomicTemps } from '../app-store'
import { cleanupUsageAtomicTemps } from '../usage-jsonl'
import { cleanupTraceArchiveTemps } from '../transcript-archive'
import { cleanupTraceTurnProgressTemps, recoverTraceTurnProgress } from '../trace-turn-progress'
import {
  cleanupManagedTurnTemps,
  managedRecoveryScopes,
  recoverManagedTraceTurns,
  recoverManagedTraceProgress
} from '../managed-turn-commit'
import { packagedRecorderCliPath } from '../claude-locate'
import { redeliverGrantedCommitHooksAtStartup } from '../commit-hook-startup'
import { resolveGrantedManagedCommitHookEnv, withoutCommitHookCapability } from './trust'

export async function runStartupRecovery({
  startupPerf, conversationStore, runs
}: {
  startupPerf: PerformanceTrace
  conversationStore: () => Pick<ConversationStore, 'recoverAll'>
  runs: { unsettledStates: () => ActiveRun[] }
}): Promise<void> {
  // Let the first window render before touching historical recovery trees.
  await new Promise((resolve) => setTimeout(resolve, 250))
  await replayDatabaseTurnOutbox()
  startupPerf.mark('recovery_outbox_replayed')
  cleanupAppStoreAtomicTemps(app.getPath('userData'))
  cleanupUsageAtomicTemps(app.getPath('userData'))
  cleanupManagedTurnTemps(app.getPath('userData'))
  cleanupTraceTurnProgressTemps(app.getPath('userData'))
  await cleanupTraceArchiveTemps(app.getPath('userData'))
  startupPerf.mark('recovery_temps_cleaned')
  try {
    await conversationStore().recoverAll(new Set(runs.unsettledStates().map((run) => run.runId)))
  } catch (error) {
    // Do not discard corrupt ownership. Every legacy write still checks the store
    // and rejects unreadable/conflicting ledgers or pending/unknown ownership.
    console.warn('[scry] conversation startup recovery failed:', error)
  }
  try {
    const traceProgress = await recoverTraceTurnProgress(app.getPath('userData'), {
      isLiveManagedRun: (runId) => runs.unsettledStates().some((run) => run.runId === runId)
    })
    if (traceProgress.pending > 0) console.warn('[scry] trace turn progress recovery pending:', traceProgress)
    for (const scope of await managedRecoveryScopes(app.getPath('userData'))) {
      const commitHookEnv = await resolveGrantedManagedCommitHookEnv(scope.cwd)
      const journals = await recoverManagedTraceTurns(app.getPath('userData'), { ...scope, commitHookEnv })
      if (journals.pending > 0) console.warn('[scry] managed turn recovery pending:', scope, journals)
      const progress = await recoverManagedTraceProgress(app.getPath('userData'), { ...scope, commitHookEnv })
      if (progress.pending > 0) console.warn('[scry] managed turn progress recovery pending:', scope, progress)
    }
  } catch (error) {
    console.warn('[scry] managed turn startup recovery failed:', error)
  }
  startupPerf.mark('recovery_trace_and_managed_turns')
  try {
    const recorderCli = packagedRecorderCliPath() ?? process.env.SCRY_CLI_PATH
    const redelivery = await redeliverGrantedCommitHooksAtStartup(app.getPath('userData'), {
      env: withoutCommitHookCapability(),
      extendCapabilityEnv: () => ({
        ...(recorderCli ? { SCRY_CLI_PATH: recorderCli } : {}),
        SCRY_RECORDER_MANAGED: '1'
      })
    })
    if (redelivery.errors.length > 0) {
      console.warn('[scry] recorder commit hook startup redelivery failed:', redelivery.errors)
    }
  } catch (error) {
    console.warn('[scry] recorder commit hook startup redelivery failed:', error)
  }
  startupPerf.mark('recovery_commit_hooks_complete')
  startupPerf.mark('recovery_complete')
  startupPerf.finish()
}
