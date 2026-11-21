import type { ConversationStore } from '../main/conversation-store'
import type { AppEventFeed } from '../main/remote/app-event-feed'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../main/run-registry'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import { attachDaemonOrchestrationAuthority, type DaemonOrchestrationAuthority } from './orchestration-authority'
import { reconcileH1ForOffMode } from './orchestration-off-fallback'
import { attachDaemonOrchestrationShadow, type DaemonOrchestrationShadow } from './orchestration-shadow'
import type { DaemonHostProcessOptions } from './host-process-types'

/** Attaches off-fallback reconciliation, shadow mode, or authoritative on-mode orchestration for host-process. */
export async function attachHostProcessOrchestration<
  State extends RunRegistryState,
  Control extends RunRegistryControl
>(input: {
  options: DaemonHostProcessOptions
  remoteStateDirectory: string
  conversationStore: () => ConversationStore
  runs: RunRegistry<State, Control>
  requestRunStop: (runId: string) => boolean
  attentionSnapshot: () => SessionAttentionSnapshot
  events: AppEventFeed
  log: (line: string) => void
}): Promise<{
  orchestrationShadow: DaemonOrchestrationShadow | undefined
  orchestrationAuthority: DaemonOrchestrationAuthority | undefined
}> {
  const { options, remoteStateDirectory, conversationStore, runs, requestRunStop, attentionSnapshot, events, log } = input
  reconcileH1ForOffMode({ userDataDir: options.userDataDir, remoteStateDirectory, env: process.env, log })
  const orchestrationShadow = attachDaemonOrchestrationShadow({
    userDataDir: options.userDataDir,
    env: process.env,
    conversationStore,
    log,
    ...(options.orchestrationShadowBeforeCommitHook ? { beforeCommitHook: options.orchestrationShadowBeforeCommitHook } : {}),
    ...(options.orchestrationShadowPauseBackfill ? { pauseDeferredBackfill: options.orchestrationShadowPauseBackfill } : {})
  })
  const orchestrationAuthority = await attachDaemonOrchestrationAuthority({
    userDataDir: options.userDataDir,
    env: process.env,
    conversationStore,
    runs,
    requestRunStop,
    attentionSnapshot,
    log,
    ...(options.orchestrationShadowBeforeCommitHook ? { beforeCommitHook: options.orchestrationShadowBeforeCommitHook } : {}),
    ...(options.orchestrationMirrorWriteHook ? { mirrorWriteHook: options.orchestrationMirrorWriteHook } : {}),
    ...(options.orchestrationMirrorMaxPendingEvents !== undefined
      ? { mirrorMaxPendingEvents: options.orchestrationMirrorMaxPendingEvents }
      : {}),
    ...(options.orchestrationMirrorRetryIntervalMs !== undefined
      ? { mirrorRetryIntervalMs: options.orchestrationMirrorRetryIntervalMs }
      : {})
  })
  if (orchestrationAuthority) {
    events.setObserver((event) => orchestrationAuthority.forwardAppEvent(event))
  }
  return { orchestrationShadow, orchestrationAuthority }
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
