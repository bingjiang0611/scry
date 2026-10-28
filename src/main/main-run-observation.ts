import type { BrowserWindow } from 'electron'
import { sanitizeToolEvents } from '../core/turn-recorder/tool-content'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { AgentIntervention, AgentQuestionRequest } from '../shared/runtime'
import type { RunRegistry } from './run-registry'
import type { RunControl } from './app-run-lifecycle-types'
import type { DockBadgeState } from './dock-badge'
import { TraceOutputBridge } from './trace-output'
import { UserQuestionBroker, type UserQuestionChange } from './user-question'

export interface MainRunObservationDeps {
  runs: RunRegistry<ActiveRun, RunControl>
  dockBadge: DockBadgeState
  getWindow: () => BrowserWindow | null
  rendererCanReceive: () => boolean
  mainEventId: (prefix: string, runId: string) => string
  activeRunSessionKey: (run: ActiveRun) => string | null
  appendTrace: (items: TraceEvent[], event: TraceEvent) => void
}

export const LIVE_TOOL_CONTENT_POLICY = {
  toolOutput: 'full' as const,
  toolContentFieldBytes: 8 * 1024,
  toolContentTurnBytes: 128 * 1024
}

export function createMainRunObservation(deps: MainRunObservationDeps): {
  userQuestionBroker: UserQuestionBroker
  traceOutput: TraceOutputBridge
  publishQuestionOpened: (request: AgentQuestionRequest) => void
  publishQuestionClosed: (runId: string, questionId: string, intervention?: AgentIntervention) => void
  flushTraceSend: () => void
  queueTrace: (event: TraceEvent) => void
  boundedLiveRun: (run: ActiveRun) => ActiveRun
} {
  let queueTrace: (event: TraceEvent) => void = () => {}
  const publishQuestionOpened = (request: AgentQuestionRequest): void => {
    const run = deps.runs.get(request.runId)?.state
    if (run) {
      run.pendingQuestions = [
        ...(run.pendingQuestions ?? []).filter(item => item.questionId !== request.questionId),
        request
      ]
      const sessionKey = deps.activeRunSessionKey(run)
      if (sessionKey) deps.dockBadge.markAttention(sessionKey, {
        windowFocused: Boolean(deps.getWindow()?.isFocused()),
        sessionViewed: deps.runs.isViewed(run.runId),
        needsAttention: true
      })
    }
    deps.getWindow()?.webContents.send('agent:questionAttention', {
      runId: request.runId,
      pendingCount: run?.pendingQuestions?.length ?? 1
    })
    if (deps.runs.isFocused(request.runId)) deps.getWindow()?.webContents.send('agent:userQuestion', request)
  }
  const publishQuestionClosed = (runId: string, questionId: string, intervention?: AgentIntervention): void => {
    const run = deps.runs.get(runId)?.state
    if (run) {
      run.pendingQuestions = (run.pendingQuestions ?? []).filter(item => item.questionId !== questionId)
      if (intervention) {
        const event: TraceEvent = {
          id: deps.mainEventId('intervention', runId), ts: intervention.closedAt, runId, kind: 'human', stage: 'intervention',
          toolUseId: questionId, providerId: intervention.request.providerId, agentId: intervention.request.agentId,
          durationMs: intervention.durationMs, intervention
        }
        deps.appendTrace(run.items, event)
        if (deps.runs.isFocused(runId)) queueTrace(event)
      }
    }
    deps.getWindow()?.webContents.send('agent:questionAttention', { runId, pendingCount: run?.pendingQuestions?.length ?? 0 })
    if (deps.runs.isFocused(runId)) deps.getWindow()?.webContents.send('agent:userQuestionClosed', { kind: 'closed', runId, questionId, ...(intervention ? { intervention } : {}) })
  }
  const userQuestionBroker = new UserQuestionBroker((change: UserQuestionChange) => {
    if (change.kind === 'open') publishQuestionOpened(change.request)
    else publishQuestionClosed(change.runId, change.questionId, change.intervention)
  })
  const traceOutput = new TraceOutputBridge({
    canSend: deps.rendererCanReceive,
    flushMs: 16,
    send: payload => deps.getWindow()?.webContents.send('agent:trace', payload),
    publishHealth: state => { if (deps.rendererCanReceive()) deps.getWindow()?.webContents.send('agent:traceHealth', state) },
    warn: (message, state) => console.warn(`[scry] ${message}:`, state)
  })
  const flushTraceSend = (): void => traceOutput.flushAll()
  queueTrace = (event: TraceEvent): void => traceOutput.push(event)
  const boundedLiveRun = (run: ActiveRun): ActiveRun => ({
    ...run,
    items: sanitizeToolEvents(run.items, LIVE_TOOL_CONTENT_POLICY, 'live_renderer')
  })
  return { userQuestionBroker, traceOutput, publishQuestionOpened, publishQuestionClosed, flushTraceSend, queueTrace, boundedLiveRun }
}
