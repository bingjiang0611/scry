import { createHash } from 'node:crypto'
import type { ProviderId } from '../shared/provider'

export function scrySessionId(providerId: ProviderId, cwd: string, externalSessionId: string): string {
  return `scry-${createHash('sha256').update(providerId).update('\0').update(cwd).update('\0').update(externalSessionId).digest('hex').slice(0, 32)}`
}

export function archiveSessionId(
  managedRecorder: boolean,
  nativeSessionId: string | undefined,
  storageSessionId: string
): string | undefined {
  return managedRecorder ? nativeSessionId : storageSessionId
}
