import type { ProviderId } from '../shared/provider'
import type { Conversation } from '../shared/conversation'
import type { LoadedSessionTurn } from '../shared/session-history'
import { mergeSessionTurns } from './session-history'
import { readTraceArchiveTurnsAsync, type TraceArchiveTurn } from './transcript-archive'

type ConversationTurn = Conversation['turns'][number]

/**
 * Batched archived-history projection for one visible conversation page.
 *
 * A page shows up to 40 turns that usually belong to one or two bindings. Reading the
 * whole native archive once per turn made a pure tab/page change reread the same
 * session up to 40 times, so requested run ids are grouped per binding and session and
 * read in one indexed pass. `readTraceArchiveTurnsAsync` already reads only the
 * canonical segments it was asked for; its own legacy-monolith fallback stays intact,
 * which is why an old archive still reports what it actually holds instead of a fake
 * empty history.
 */
export function createConversationTurnLoader({
  userDataDir, readTurns = readTraceArchiveTurnsAsync
}: {
  userDataDir: string
  /** Injected for the batching regression; production always uses the indexed reader. */
  readTurns?: (args: { cwd: string; sessionId: string; userDataDir: string; providerId: ProviderId },
    runIds: readonly string[]) => Promise<TraceArchiveTurn[]>
}): (conversation: Conversation, turns: readonly ConversationTurn[]) => Promise<Map<string, LoadedSessionTurn>> {
  return async (conversation, turns) => {
    const groups = new Map<string, { sessionId: string; providerId: ProviderId; runIds: string[] }>()
    for (const turn of turns) {
      if (!turn.archive) continue
      const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)
      if (!binding) continue
      const key = `${binding.id}\0${turn.archive.sessionId}`
      const group = groups.get(key)
      if (group) group.runIds.push(turn.runId)
      else groups.set(key, { sessionId: turn.archive.sessionId, providerId: binding.providerId, runIds: [turn.runId] })
    }
    const loaded = new Map<string, LoadedSessionTurn>()
    await Promise.all([...groups.values()].map(async (group) => {
      const args = { cwd: conversation.cwd, sessionId: group.sessionId, userDataDir, providerId: group.providerId }
      let archiveTurns: TraceArchiveTurn[]
      try {
        archiveTurns = await readTurns(args, group.runIds)
      } catch {
        // A corrupt archive is reported as unavailable history by the page projection,
        // never as a turn that ran without content.
        return
      }
      const context = { userDataDir }
      for (const archiveTurn of archiveTurns) {
        // Project one real archived turn at a time. The synthetic archive carries only
        // provenance fields readTraceArchiveTurnsAsync already validated; no coverage
        // marker is invented here.
        const projected = mergeSessionTurns([], {
          version: 3, cwd: conversation.cwd, sessionId: group.sessionId, providerId: group.providerId,
          turns: [archiveTurn]
        }, context)[0]
        if (projected) loaded.set(archiveTurn.runId, projected)
      }
    }))
    return loaded
  }
}
