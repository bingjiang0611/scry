import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { readJson, writeJsonAtomic } from './io.js'

// Observational only: proves a provider lifecycle hook actually reached the recorder, which
// is the difference between "configured" and "capturing". It sits on the hook critical path,
// so writes skip fsync and every failure is swallowed — losing an activity stamp must never
// break a turn. Concurrent hooks race benignly (last writer wins for that provider).

export interface ProviderActivityEntry {
  lastEvent: string
  lastEventAt: string
  events: number
}

export interface ProviderActivityFile {
  schemaVersion: 1
  providers: Partial<Record<ProviderId, ProviderActivityEntry>>
}

function activityPath(dataRoot: string): string {
  return join(dataRoot, 'state', 'provider-activity.json')
}

export async function readProviderActivity(dataRoot: string): Promise<ProviderActivityFile> {
  const file = await readJson<ProviderActivityFile>(activityPath(dataRoot))
  if (file?.schemaVersion !== 1 || !file.providers || typeof file.providers !== 'object') {
    return { schemaVersion: 1, providers: {} }
  }
  return file
}

export async function recordProviderActivity(
  dataRoot: string,
  provider: ProviderId,
  event: string
): Promise<void> {
  try {
    const file = await readProviderActivity(dataRoot)
    const previous = file.providers[provider]
    file.providers[provider] = {
      lastEvent: event,
      lastEventAt: new Date().toISOString(),
      events: (Number.isSafeInteger(previous?.events) ? previous!.events : 0) + 1
    }
    await writeJsonAtomic(activityPath(dataRoot), file, { sync: false })
  } catch {
    // fail open: activity evidence is never worth failing a turn for
  }
}
