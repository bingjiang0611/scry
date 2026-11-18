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
import { redeliverGrantedCommitHooksAtStartup } from '../commit-hook-startup'
import { resolveGrantedManagedCommitHookEnv, withoutCommitHookCapability } from './trust'

export async function runStartupRecovery({
  userDataDir, recorderCli, startupPerf, conversationStore, runs, deferMs = 250
}: {
  userDataDir: string
  recorderCli?: string
  startupPerf: Pick<PerformanceTrace, 'mark' | 'finish'>
  conversationStore: () => Pick<ConversationStore, 'recoverAll'>
  runs: { unsettledStates: () => ActiveRun[] }
  deferMs?: number
}): Promise<void> {
  // Let the first window render before touching historical recovery trees.
  if (deferMs > 0) await new Promise((resolve) => setTimeout(resolve, deferMs))
  await replayDatabaseTurnOutbox()
  startupPerf.mark('recovery_outbox_replayed')
  cleanupAppStoreAtomicTemps(userDataDir)
  cleanupUsageAtomicTemps(userDataDir)
  cleanupManagedTurnTemps(userDataDir)
  cleanupTraceTurnProgressTemps(userDataDir)
  await cleanupTraceArchiveTemps(userDataDir)
  startupPerf.mark('recovery_temps_cleaned')
  try {
    await conversationStore().recoverAll(new Set(runs.unsettledStates().map((run) => run.runId)))
  } catch (error) {
    // Do not discard corrupt ownership. Every legacy write still checks the store
    // and rejects unreadable/conflicting ledgers or pending/unknown ownership.
    console.warn('[scry] conversation startup recovery failed:', error)
  }
  try {
    const traceProgress = await recoverTraceTurnProgress(userDataDir, {
      isLiveManagedRun: (runId) => runs.unsettledStates().some((run) => run.runId === runId)
    })
    if (traceProgress.pending > 0) console.warn('[scry] trace turn progress recovery pending:', traceProgress)
    for (const scope of await managedRecoveryScopes(userDataDir)) {
      const commitHookEnv = await resolveGrantedManagedCommitHookEnv(scope.cwd)
      const journals = await recoverManagedTraceTurns(userDataDir, { ...scope, commitHookEnv })
      if (journals.pending > 0) console.warn('[scry] managed turn recovery pending:', scope, journals)
      const progress = await recoverManagedTraceProgress(userDataDir, { ...scope, commitHookEnv })
      if (progress.pending > 0) console.warn('[scry] managed turn progress recovery pending:', scope, progress)
    }
  } catch (error) {
    console.warn('[scry] managed turn startup recovery failed:', error)
  }
  startupPerf.mark('recovery_trace_and_managed_turns')
  try {
    const redelivery = await redeliverGrantedCommitHooksAtStartup(userDataDir, {
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
