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
/**
 * C1: Pi keeps its own process pool, so it reports its lifecycle through this observer instead of
 * the Antigravity host. The rows land in the same table, so both providers' release reasons read
 * the same way.
 */
export function createPiSessionObserver(
  getSink: () => Pick<EventSink, 'handle' | 'isWriteIndeterminate'> | undefined
): {
  onOpened: (key: string, provider: 'pi', at: number) => void
  onNativeSessionId: (key: string, nativeSessionId: string) => void
  onReleased: (key: string, reason: string, at: number) => void
} {
  const db = () => {
    const sink = getSink()
    if (!sink || !sink.handle.db.open || sink.isWriteIndeterminate()) return undefined
    return sink.handle.db
  }
  return {
    onOpened: (key, provider, at) => {
      const live = db()
      if (live) recordProviderSessionOpened(live, { key, provider, at })
    },
    onNativeSessionId: (key, nativeSessionId) => {
      const live = db()
      if (live) recordProviderSessionNativeId(live, key, nativeSessionId)
    },
    onReleased: (key, reason, at) => {
      const live = db()
      if (live) recordProviderSessionReleased(live, key, reason, at)
    }
  }
}

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

/** C1: both Provider session observers read the same authority, so the host builds them together. */
export function createProviderSessionObservers(getSink: () => EventSink | undefined) {
  return { providerSessions: createDaemonProviderSessions(getSink), piSessions: createPiSessionObserver(getSink) }
}
