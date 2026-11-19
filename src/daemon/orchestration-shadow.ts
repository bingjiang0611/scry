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
  readonly fullfsync: boolean
  readonly checkpointFullfsync: boolean
  readonly mirror: ShadowMirror
  onLedgerEvent(event: LedgerEvent, meta?: { peerCertSHA256?: string; grantScope?: 'local' | 'remote' }): void
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
 * Isolated daemon hook for P4-1 shadow writes + off<->shadow incremental import.
 * Kept in its own module so `src/daemon/host-process.ts` stays minimal and free of conflicts.
 */
export function attachDaemonOrchestrationShadow(
  options: AttachDaemonOrchestrationShadowOptions
): DaemonOrchestrationShadow | undefined {
  const mode = parseOrchestrationMode(options.env)
  if (mode.refused) {
    options.log(
      `daemon.orchestration-refused requested=${mode.requested} reason=${mode.reason ?? 'unsupported'}`
    )
    return undefined
  }
  if (mode.effective === 'off') return undefined

  // Maintainer decision (2026-11-19): P4-1 explicitly fixes fullfsync=OFF + checkpoint_fullfsync=ON
  // even when env vars are unset; final fullfsync decision is deferred to P4-2.
  const fullfsync = parseOrchestrationFullfsync(options.env) ?? false
  const checkpointFullfsync = !fullfsync

  const mirror = ShadowMirror.open({
    userDataDir: options.userDataDir,
    fullfsync,
    checkpointFullfsync,
    ...(options.beforeCommitHook ? { beforeCommitHook: options.beforeCommitHook } : {}),
    onCommitTiming: (sample) => {
      recordOrchestrationCommitTiming({ ...sample, fullfsync })
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
        pendingTtlMs: parsePendingTtlMs(options.env),
        reconcileOpenRuns: false,
        shadowOnly: true
      })
      if (mirror.sink.isWriteIndeterminate()) {
        mirror.markFailedOpen(new Error('orchestration_write_indeterminate'))
      } else {
        options.log(
          `daemon.orchestration-shadow-ready mode=${mode.requested}/${mode.effective} fullfsync=${String(fullfsync)} checkpointFullfsync=${String(checkpointFullfsync)} importedRuns=${imported.importedRuns} importedSessions=${imported.importedSessions}`
        )
      }
    } catch (error) {
      mirror.markFailedOpen(error)
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
    checkpointFullfsync,
    mirror,
    onLedgerEvent: (event, meta) => mirror.onLedgerEvent(event, meta),
    close: () => {
      options.conversationStore().setTurnSettledObserver(undefined)
      mirror.close()
    }
  }
}
