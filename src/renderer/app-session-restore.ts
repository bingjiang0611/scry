import type { ProviderId } from '@shared/provider'
import type { ActiveRun } from '@shared/trace'
import type { ParsedTurn, SessionHistoryPage } from './env'

type PrepareHistoryFocus = (runId: string, captureTrace?: boolean) => void | (() => void)

export async function restoreActiveSessionSelection(
  args: {
    runId?: string
    sessionId: string
    externalSessionId?: string
    cwd: string
    providerId: ProviderId
    agentProfileId?: string
  },
  effects: {
    prepareRunFocus: PrepareHistoryFocus
    adoptActiveRun: (runId: string) => Promise<ActiveRun | null>
    loadSession: (context: {
      providerId: ProviderId
      agentProfileId?: string
      cwd: string
      externalSessionId: string
    }) => Promise<SessionHistoryPage | null>
    replaceWithParsedSession: (
      sessionId: string,
      parsed: ParsedTurn[],
      options: { activeRun: ActiveRun; page?: SessionHistoryPage | null }
    ) => void
    onHistoryLoaded?: (page: SessionHistoryPage | null, activeRun: ActiveRun | null) => void
    isCurrent?: () => boolean
  }
): Promise<boolean> {
  if (!args.runId) return false
  if (effects.isCurrent && !effects.isCurrent()) return false
  const finishCapture = effects.prepareRunFocus(args.runId, Boolean(args.externalSessionId))
  try {
    const activeRun = await effects.adoptActiveRun(args.runId)
    if (!activeRun || (effects.isCurrent && !effects.isCurrent())) return false
    const page = args.externalSessionId
      ? await effects.loadSession({
        providerId: args.providerId,
        agentProfileId: args.agentProfileId,
        cwd: args.cwd,
        externalSessionId: args.externalSessionId
      })
      : null
    if (effects.isCurrent && !effects.isCurrent()) return false
    effects.replaceWithParsedSession(args.sessionId, page?.turns ?? [], { activeRun, page })
    effects.onHistoryLoaded?.(page, page?.projection ? page.projection.activeRun : activeRun)
    return true
  } finally {
    finishCapture?.()
  }
}

export async function restoreFocusedRunSelection(
  run: ActiveRun,
  effects: {
    prepareRunFocus: PrepareHistoryFocus
    selectContext: (context: { providerId: ProviderId; agentProfileId?: string; cwd: string | null; sessionId: string }) => void
    loadSession: (context: {
      providerId: ProviderId
      agentProfileId?: string
      cwd: string
      externalSessionId: string
    }) => Promise<SessionHistoryPage | null>
    replaceWithParsedSession: (
      sessionId: string,
      parsed: ParsedTurn[],
      options: { activeRun: ActiveRun; preserveFocusDeltas?: boolean; page?: SessionHistoryPage | null }
    ) => void
    isCurrent?: () => boolean
  }
): Promise<boolean> {
  if (run.done || !run.providerId || (effects.isCurrent && !effects.isCurrent())) return false
  const externalSessionId = run.externalSessionId ?? run.sessionId
  const sessionId = externalSessionId ?? run.runId
  const cwd = run.cwd ?? ''
  const finishCapture = effects.prepareRunFocus(run.runId, Boolean(externalSessionId))
  try {
    effects.selectContext({ providerId: run.providerId, agentProfileId: run.agentProfileId, cwd: run.cwd ?? null, sessionId })
    effects.replaceWithParsedSession(sessionId, [], {
      activeRun: run,
      preserveFocusDeltas: Boolean(externalSessionId)
    })
    if (!externalSessionId) return true
    const page = await effects.loadSession({
      providerId: run.providerId,
      agentProfileId: run.agentProfileId,
      cwd,
      externalSessionId
    })
    if (effects.isCurrent && !effects.isCurrent()) return false
    effects.replaceWithParsedSession(sessionId, page?.turns ?? [], { activeRun: run, page })
    return true
  } finally {
    finishCapture?.()
  }
}
