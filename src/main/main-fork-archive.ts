import { createHash } from 'node:crypto'
import { deleteTranscriptCopies, upsertTraceArchiveTurn, type TraceArchiveTurn } from './transcript-archive'
import { restoreTraceArchiveTurn } from './session-history'
import { deleteRunAttachments, prepareRunAttachments } from './attachment-store'
import type { ProviderId } from '../shared/provider'
import type { RuntimeProvider } from '../shared/runtime'

export interface ForkArchiveDeps {
  getUserData: () => string
}

export function cloneForkArchiveTurns(args: {
  turns: TraceArchiveTurn[]
  targetSessionId: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  cwd: string
}, deps: ForkArchiveDeps): void {
  const userDataDir = deps.getUserData()
  const clonedRunIds: string[] = []
  try {
    for (const source of args.turns) {
      const runId = `fork-${createHash('sha256')
        .update(`${args.targetSessionId}\0${source.runId}`)
        .digest('hex')
        .slice(0, 24)}`
      clonedRunIds.push(runId)
      const restored = restoreTraceArchiveTurn(source, { userDataDir })
      const attachments = prepareRunAttachments(userDataDir, runId, restored.attachments ?? [], {
        providerId: args.providerId,
        cwd: args.cwd,
        sessionId: args.targetSessionId
      })
      const ok = upsertTraceArchiveTurn({
        cwd: args.cwd,
        sessionId: args.targetSessionId,
        providerId: args.providerId,
        runtimeProvider: args.runtimeProvider,
        userDataDir,
        turn: {
          ...source,
          runId,
          attachments,
          items: source.items.map(event => ({ ...event, runId }))
        }
      })
      if (!ok) throw new Error('Scry 无法复制分支前缀归档')
    }
  } catch (error) {
    deleteTranscriptCopies({
      cwd: args.cwd,
      sessionId: args.targetSessionId,
      userDataDir,
      providerId: args.providerId
    })
    for (const runId of clonedRunIds) deleteRunAttachments(userDataDir, runId)
    throw error
  }
}
