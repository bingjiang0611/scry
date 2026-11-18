import type { RemoteCommandCatalog } from '../../shared/desktop-remote'
import type { RemoteCommandQuery } from './remote-gateway-types'

export interface ProviderWarmTarget {
  providerId: string
  cwd?: string
  agentProfileId?: string
}

// Opening a session is the moment its Provider controls will be needed, and a cold
// Provider start costs seconds, so the host reads that context's catalog in the
// background right after the session read succeeded.
//
// Prewarming is only ever attached to a read that already passed device,
// workspace and trust authorization, and it decides nothing: a warm read that
// fails is dropped, because an optimization is not evidence about the session.
// One warm read per context is in flight at a time; the pooled Provider process
// then answers later reads without another start.
//
// Only a provider that keeps such a pool gains anything from this: for a
// cold-only provider the warm read is one extra process start that nothing
// reuses, so the capability decides, not the provider id.
export function createProviderPrewarmer(
  readCommands: (query: RemoteCommandQuery) => Promise<RemoteCommandCatalog>,
  hasWarmPool: (providerId: string) => boolean,
  onError?: (error: unknown) => void
) {
  const inFlight = new Set<string>()
  return function prewarmProviderCatalog(target: ProviderWarmTarget): void {
    if (!target.cwd || !hasWarmPool(target.providerId)) return
    const key = [target.providerId, target.agentProfileId ?? '', target.cwd].join('\u0000')
    if (inFlight.has(key)) return
    inFlight.add(key)
    void readCommands({
      providerId: target.providerId,
      cwd: target.cwd,
      ...(target.agentProfileId ? { agentProfileId: target.agentProfileId } : {})
    }).catch((error: unknown) => { onError?.(error) }).finally(() => { inFlight.delete(key) })
  }
}
