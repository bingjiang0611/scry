import type { TraceEvent } from '../shared/trace'
import { MAC_RUN_ID, UUID } from './remote/desktop-client-validation'

// What the daemon's own evidence says about a run, decoded in one place: the bind marker
// that names the run, and the growth of a run-view item the renderer already holds.

export interface BoundMarker {
  ledgerRunId?: string
  scryRunId: string
  cwd?: string
  providerId?: string
  agentProfileId?: string
}

export function boundMarker(detail: string): BoundMarker | undefined {
  try {
    const marker = JSON.parse(detail) as Record<string, unknown>
    if (marker.event !== 'bound' || typeof marker.scryRunId !== 'string') return undefined
    // The daemon's canonical id for a run it dispatches itself (a device's, or the
    // App's) is `remote-run-...`; a locally started one is `run-...`. A conversation run
    // keeps its conversation turn's UUID, as it does in process.
    if (!MAC_RUN_ID.test(marker.scryRunId) && !UUID.test(marker.scryRunId)) return undefined
    return {
      ...(typeof marker.ledgerRunId === 'string' && marker.ledgerRunId.length > 0 ? { ledgerRunId: marker.ledgerRunId } : {}),
      scryRunId: marker.scryRunId,
      ...(typeof marker.cwd === 'string' && marker.cwd.length > 0 ? { cwd: marker.cwd } : {}),
      ...(typeof marker.providerId === 'string' && marker.providerId.length > 0 ? { providerId: marker.providerId } : {}),
      ...(typeof marker.agentProfileId === 'string' && marker.agentProfileId.length > 0 ? { agentProfileId: marker.agentProfileId } : {})
    }
  } catch { return undefined }
}

/**
 * The text a run-view item appended since the copy that was delivered, when the item is
 * the same event and the new text only extends it. `undefined` means "not an append":
 * a different event, a shorter text, or a stage that does not grow.
 */
export function appendedText(previous: TraceEvent | undefined, next: TraceEvent): { text: string; at: number } | undefined {
  if (!previous || previous.id !== next.id) return undefined
  if (previous.stage !== 'text_delta' && previous.stage !== 'text') return undefined
  const before = previous.text ?? ''
  const after = next.text ?? ''
  if (after.length <= before.length || !after.startsWith(before)) return undefined
  return { text: after.slice(before.length), at: after.length }
}
