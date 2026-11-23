import { DESKTOP_HISTORY_MAX_BYTES, type DesktopHostRead, type DesktopHostReadResult } from '../../shared/desktop-remote'
import type { ProviderId } from '../../shared/provider'
import { mergeSessionTurns } from '../session-history'
import { hydrateNewestSessionSnapshots } from '../trace-diff-content'
import { readTraceArchiveRunSegment } from '../transcript-archive-read'

export async function readDesktopArchivedTrace(
  userDataDir: string, cwd: string, query: Extract<DesktopHostRead, { kind: 'trace' }>
): Promise<Extract<DesktopHostReadResult, { kind: 'trace' }>> {
  const { context, runId } = query
  const sessionId = context.externalSessionId!
  const providerId = context.providerId as ProviderId
  const turn = await readTraceArchiveRunSegment({ cwd, sessionId, providerId, userDataDir, runId, maxBytes: DESKTOP_HISTORY_MAX_BYTES })
  if (!turn) return { kind: 'trace', run: null }
  if (turn.agentProfileId !== (context.agentProfileId ?? null)) throw new Error('history_profile_unavailable')
  if (!turn.done) return { kind: 'trace', run: null }

  await hydrateNewestSessionSnapshots(userDataDir, cwd, [turn])
  const [history] = mergeSessionTurns([], { version: 3, cwd, providerId, sessionId, turns: [turn] },
    undefined, { hydrateAttachments: false })
  return {
    kind: 'trace',
    run: {
      cwd, providerId, externalSessionId: sessionId, runId, done: true,
      ...(context.agentProfileId ? { agentProfileId: context.agentProfileId } : {}),
      userText: history.userText, items: history.items
    },
    ...(query.images ? { imageCount: turn.attachments?.length ?? 0 } : {})
  }
}
