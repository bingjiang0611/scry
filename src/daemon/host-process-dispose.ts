import type { ConversationStore } from '../main/conversation-store'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../main/run-registry'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import { attachDaemonOrchestrationAuthority, type DaemonOrchestrationAuthority } from './orchestration-authority'
import { createUsageLimitScheduler } from './usage-limit-scheduler'
import { wakeBackgroundSession } from './agent-wake'
import { findRestartBackgroundNotes, storeRestartBackgroundNotes } from './restart-background-note'
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
  /** C4: the resume is an outbox write, so the scheduler needs the dispatcher's pump. */
  pumpDispatcher?: () => void
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
    settings: () => ({ autoResume: process.env.SCRY_USAGE_LIMIT_AUTO_RESUME === '1' }),
    ...(input.pumpDispatcher ? { pump: input.pumpDispatcher } : {}),
    log
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
    usageLimits,
    ...(input.pumpDispatcher ? { pumpDispatcher: input.pumpDispatcher } : {})
  })
  attached = authority
  // C3: the answered run ended while Provider-native work continued. The wake reuses C4's pump: a
  // queued agent run is an outbox row, and nothing drains it unless something pumps.
  authority.hooks.wakeBackground = (wake) => { wakeBackgroundSession(authority.sink, wake, input.pumpDispatcher) }
  // A restart re-arms exactly the items that are still pending; a stored item that already resumed
  // is not resumed again.
  usageLimits.pump()
  // C4: the background work the previous process was waiting on is gone; the next turn of that
  // session is told so once.
  try {
    storeRestartBackgroundNotes(authority.sink.handle.db, findRestartBackgroundNotes(authority.sink.handle.db))
  } catch (error) {
    log(`[scry] restart background note failed: ${(error as Error).message}`)
  }
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
