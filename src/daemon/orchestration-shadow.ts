import type { ConversationStore } from '../main/conversation-store'
import type { LedgerEvent } from '../main/remote/session-ledger'
import { recordOrchestrationCommitTiming } from '../main/run-stage-timing'
import { importLegacyStateIncrementally } from '../host-runtime/orchestration/legacy-import'
import {
  parseOrchestrationFullfsync,
  parseOrchestrationMode,
  parsePendingTtlMs,
  type OrchestrationModeResolution
} from '../host-runtime/orchestration/mode'
import { ShadowMirror } from '../host-runtime/orchestration/shadow-mirror'

export interface DaemonOrchestrationShadow {
  readonly mode: OrchestrationModeResolution
  readonly fullfsync: boolean | undefined
  readonly mirror: ShadowMirror
  onLedgerEvent(event: LedgerEvent): void
  close(): void
}

export interface AttachDaemonOrchestrationShadowOptions {
  userDataDir: string
  env: NodeJS.ProcessEnv
  conversationStore: () => ConversationStore
  log: (line: string) => void
  /** Test seam: inject a commit failure into the shadow EventSink. */
  beforeCommitHook?: () => void
}

/**
 * Isolated daemon hook for P4-1 shadow writes + off<->on incremental import.
 * Kept in its own module so `src/daemon/host-process.ts` stays minimal and free of conflicts.
 */
export function attachDaemonOrchestrationShadow(
  options: AttachDaemonOrchestrationShadowOptions
): DaemonOrchestrationShadow | undefined {
  const mode = parseOrchestrationMode(options.env)
  if (mode.effective === 'off') return undefined

  const fullfsync = parseOrchestrationFullfsync(options.env)
  const checkpointFullfsync = fullfsync === false ? true : undefined

  const mirror = ShadowMirror.open({
    userDataDir: options.userDataDir,
    ...(fullfsync !== undefined ? { fullfsync } : {}),
    ...(checkpointFullfsync !== undefined ? { checkpointFullfsync } : {}),
    ...(options.beforeCommitHook ? { beforeCommitHook: options.beforeCommitHook } : {}),
    onCommitTiming: (sample) => {
      recordOrchestrationCommitTiming({ ...sample, ...(fullfsync !== undefined ? { fullfsync } : {}) })
    },
    onError: (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      options.log(`daemon.orchestration-shadow-fail-open ${msg}`)
    }
  })

  if (mirror.sink && !mirror.stats().failedOpen) {
    try {
      const imported = importLegacyStateIncrementally({
        sink: mirror.sink,
        userDataDir: options.userDataDir,
        pendingTtlMs: parsePendingTtlMs(options.env)
      })
      options.log(
        `daemon.orchestration-shadow-ready mode=${mode.requested}/${mode.effective} fullfsync=${String(fullfsync ?? 'default')} importedRuns=${imported.importedRuns} importedSessions=${imported.importedSessions}`
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      options.log(`daemon.orchestration-shadow-import-failed ${msg}`)
    }
  }

  options.conversationStore().setTurnSettledObserver((info) => {
    mirror.onConversationTurnSettled(info)
  })

  return {
    mode,
    fullfsync,
    mirror,
    onLedgerEvent: (event) => mirror.onLedgerEvent(event),
    close: () => {
      options.conversationStore().setTurnSettledObserver(undefined)
      mirror.close()
    }
  }
}
