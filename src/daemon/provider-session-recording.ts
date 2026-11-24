import type { EventSink } from '../host-runtime/orchestration/event-sink'
import {
  recordProviderSessionNativeId,
  recordProviderSessionOpened,
  recordProviderSessionReleased
} from '../host-runtime/orchestration/provider-session-records'
import { ProviderSessionHost } from '../host-runtime/provider-sessions/session-host'
import type { AntigravityProcessSession } from '../main/providers/antigravity-session'

/**
 * C1: the daemon owns Provider session lifetime, so opening, learning the native id, and releasing
 * a session become durable rows with a reason. The sink is resolved per call because the
 * orchestration authority is created after the Provider runtime.
 */
export function createDaemonProviderSessions(
  getSink: () => Pick<EventSink, 'handle' | 'isWriteIndeterminate'> | undefined
): ProviderSessionHost<AntigravityProcessSession> {
  const db = () => {
    const sink = getSink()
    if (!sink || !sink.handle.db.open || sink.isWriteIndeterminate()) return undefined
    return sink.handle.db
  }
  return new ProviderSessionHost<AntigravityProcessSession>({
    onOpened: (record) => {
      const live = db()
      if (live) recordProviderSessionOpened(live, record)
    },
    onNativeSessionId: (record) => {
      const live = db()
      if (live) recordProviderSessionNativeId(live, record.key, record.nativeSessionId)
    },
    onReleased: (record) => {
      const live = db()
      if (live) recordProviderSessionReleased(live, record.key, record.reason, record.at)
    }
  })
}
