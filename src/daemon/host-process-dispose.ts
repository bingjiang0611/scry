import type { ConversationStore } from '../main/conversation-store'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../main/run-registry'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import { attachDaemonOrchestrationAuthority, type DaemonOrchestrationAuthority } from './orchestration-authority'
import { createUsageLimitScheduler } from './usage-limit-scheduler'
import type { DaemonHostProcessOptions } from './host-process-types'

/** Attaches the daemon’s authoritative event log and subscription hub. */
export async function attachHostProcessOrchestration<
  State extends RunRegistryState,
  Control extends RunRegistryControl
>(input: {
  options: DaemonHostProcessOptions
  conversationStore: () => ConversationStore
  runs: RunRegistry<State, Control>
  requestRunStop: (runId: string) => boolean
  attentionSnapshot: () => SessionAttentionSnapshot
  log: (line: string) => void
}): Promise<DaemonOrchestrationAuthority> {
  const { options, conversationStore, runs, requestRunStop, attentionSnapshot, log } = input
  // C4: the scheduler is created before the authority and reads it lazily, because the authority
  // owns the database the pending items live in. Off unless the user turned it on.
  let attached: DaemonOrchestrationAuthority | undefined
  const usageLimits = createUsageLimitScheduler({
    db: () => {
      const db = attached?.sink.handle.db
      return db?.open ? db : undefined
    },
    sink: () => attached?.sink,
    settings: () => ({ autoResume: process.env.SCRY_USAGE_LIMIT_AUTO_RESUME === '1' })
  })
  const authority = await attachDaemonOrchestrationAuthority({
    userDataDir: options.userDataDir,
    env: process.env,
    conversationStore,
    runs,
    requestRunStop,
    attentionSnapshot,
    log,
    ...(options.orchestrationPauseBackfill ? { pauseDeferredImport: options.orchestrationPauseBackfill } : {}),
    ...(options.orchestrationBeforeCommitHook ? { beforeCommitHook: options.orchestrationBeforeCommitHook } : {}),
    usageLimits
  })
  attached = authority
  // A restart re-arms exactly the items that are still pending; a stored item that already resumed
  // is not resumed again.
  usageLimits.pump()
  return authority
}

/** Bounded provider registry shutdown helper extracted from host-process.ts to stay within the 20 KB file budget. */
export async function disposeProviderRegistryBounded(
  providerRegistry: { dispose(): Promise<void> },
  timeoutMs: number,
  log: (line: string) => void
): Promise<void> {
  const effectiveTimeoutMs = Math.max(1, timeoutMs)
  await new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      log(`daemon.provider-dispose-timeout timeoutMs=${effectiveTimeoutMs}`)
      done()
    }, effectiveTimeoutMs)
    timer.unref()
    void providerRegistry.dispose().then(done, (error) => {
      log(`daemon.provider-dispose-failed ${(error as Error)?.message ?? String(error)}`)
      done()
    })
  })
}
