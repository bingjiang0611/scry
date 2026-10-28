import type { ActiveRun } from '../shared/trace'
import type { PreparedAttachment } from './attachment-store'

export type AppRunSessionEvent = Readonly<{
  runId: string
  sessionId: string
  previousSessionId?: string
  externalSessionId?: string
  providerId: ActiveRun['providerId']
  agentProfileId?: string
  pending?: true
}>

type SessionRunState = Pick<ActiveRun, 'sessionId' | 'externalSessionId' | 'attachments'>

type AppRunSessionPublicationDependencies = Readonly<{
  runId: string
  initialSessionId?: string
  initialDiffContextKey: string
  editSourceSessionId?: string
  providerId: ActiveRun['providerId']
  agentProfileId?: string
  runState: SessionRunState
  initialRendererEnabled: boolean
  recordInitialSession: () => void
  prepareAttachments: () => PreparedAttachment[]
  preparePrompt: (attachments: PreparedAttachment[]) => { prompt: string; inputTextHash?: string }
  cleanupProvisional: () => void
  deleteAttachments: () => void
  promoteDiffContext: (currentKey: string, sessionId: string) => string
  commitSelectedSession: (sessionId: string) => void
  badgeKey: (sessionId: string) => string
  rekeyBadge: (previousKey: string, nextKey: string) => void
  viewBadge: (key: string, focused: boolean) => void
  isRunViewed: () => boolean
  isWindowFocused: () => boolean
  updateAttachmentOwner?: (sessionId: string) => void
  recordNativeSession: (sessionId: string) => void
  onExternalSession?: (sessionId: string) => void
  sendRendererSession: (event: AppRunSessionEvent) => void
  warn: (message: string, error: unknown) => void
}>

export type AppRunSessionPublication = Readonly<{
  attachments: PreparedAttachment[]
  runtimePrompt: string
  managedInputTextHash?: string
  observedSessionId: () => string | undefined
  diffContextKey: () => string
  publishSessionId: (sessionId: string | undefined) => void
}>

/** Owns provisional-to-native run identity publication only. Provider dispatch,
 * selected-session authority and terminal settlement remain in Main callbacks. */
export function createAppRunSessionPublication(
  deps: AppRunSessionPublicationDependencies
): AppRunSessionPublication {
  let observedSessionId = deps.initialSessionId
  let diffContextKey = deps.initialDiffContextKey
  let notifiedSessionId = deps.initialSessionId
  let attachments: PreparedAttachment[] = []
  let preparedPrompt: { prompt: string; inputTextHash?: string }

  try {
    deps.recordInitialSession()
    attachments = deps.prepareAttachments()
    deps.runState.attachments = attachments
    preparedPrompt = deps.preparePrompt(attachments)
    if (deps.initialRendererEnabled) {
      if (deps.initialSessionId) {
        deps.sendRendererSession({
          runId: deps.runId,
          sessionId: deps.initialSessionId,
          ...(deps.editSourceSessionId ? { previousSessionId: deps.editSourceSessionId } : {}),
          externalSessionId: deps.initialSessionId,
          providerId: deps.providerId,
          agentProfileId: deps.agentProfileId
        })
      } else {
        deps.sendRendererSession({
          runId: deps.runId,
          sessionId: deps.runId,
          ...(deps.editSourceSessionId ? { previousSessionId: deps.editSourceSessionId } : {}),
          providerId: deps.providerId,
          agentProfileId: deps.agentProfileId,
          pending: true
        })
      }
    }
  } catch (error) {
    try { deps.cleanupProvisional() } catch { /* preserve the frontdoor error */ }
    deps.deleteAttachments()
    throw error
  }

  const publishSessionId = (sessionId: string | undefined): void => {
    if (!sessionId) return
    observedSessionId = sessionId
    deps.onExternalSession?.(sessionId)
    diffContextKey = deps.promoteDiffContext(diffContextKey, sessionId)
    deps.commitSelectedSession(sessionId)

    const previousSessionKey = deps.badgeKey(deps.runState.externalSessionId ?? deps.runState.sessionId ?? deps.runId)
    deps.runState.sessionId = sessionId
    deps.runState.externalSessionId = sessionId
    const nextSessionKey = deps.badgeKey(sessionId)
    deps.rekeyBadge(previousSessionKey, nextSessionKey)

    if (deps.updateAttachmentOwner) {
      try { deps.updateAttachmentOwner(sessionId) } catch (error) {
        deps.warn('attachment ownership update deferred', error)
      }
    }
    try { deps.recordNativeSession(sessionId) } catch (error) {
      deps.warn('native session catalog update deferred', error)
    }
    if (deps.isRunViewed()) deps.viewBadge(nextSessionKey, deps.isWindowFocused())

    if (notifiedSessionId === sessionId) return
    notifiedSessionId = sessionId
    try {
      deps.sendRendererSession({
        runId: deps.runId,
        sessionId,
        previousSessionId: deps.editSourceSessionId ?? deps.runId,
        externalSessionId: sessionId,
        providerId: deps.providerId,
        agentProfileId: deps.agentProfileId
      })
    } catch (error) {
      deps.warn('native session renderer notification failed', error)
    }
  }

  return {
    attachments,
    runtimePrompt: preparedPrompt.prompt,
    ...(preparedPrompt.inputTextHash !== undefined ? { managedInputTextHash: preparedPrompt.inputTextHash } : {}),
    observedSessionId: () => observedSessionId,
    diffContextKey: () => diffContextKey,
    publishSessionId
  }
}
