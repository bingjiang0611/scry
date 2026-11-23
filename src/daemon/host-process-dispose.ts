import type { ConversationStore } from '../main/conversation-store'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../main/run-registry'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import { attachDaemonOrchestrationAuthority, type DaemonOrchestrationAuthority } from './orchestration-authority'
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
  return attachDaemonOrchestrationAuthority({
    userDataDir: options.userDataDir,
    env: process.env,
    conversationStore,
    runs,
    requestRunStop,
    attentionSnapshot,
    log,
    ...(options.orchestrationPauseBackfill ? { pauseDeferredImport: options.orchestrationPauseBackfill } : {}),
    ...(options.orchestrationBeforeCommitHook ? { beforeCommitHook: options.orchestrationBeforeCommitHook } : {})
  })
}

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
