import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { readJson, writeJsonAtomic } from './io.js'


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
  }
}
