import type { AgentStartRequest, RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import { appRunEditLastTurnCopy as copy } from '../shared/constants/app-run-edit-last-turn-copy'
import type { TraceArchiveTurn } from './transcript-archive'
import { readTraceArchiveAsync } from './transcript-archive'
import { canRestartInterruptedLocalOnlySession } from './context-admission'
import { AgentRuntimeError } from './run-outcome'
import type { ForkLastTurnFacet } from './providers/types'

type EditRequest = Pick<AgentStartRequest, 'forkLastTurn' | 'restartLastTurn'>
type ForkRequest = Parameters<ForkLastTurnFacet['fork']>[0]

export type EditLastTurnInput = {
  request: EditRequest
  forkSourceSessionId?: string
  restartSourceSessionId?: string
  expectedSessionId: string | null | undefined
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  cwd?: string
  catalogCwd: string
  agentProfileId?: string
  model?: AgentStartRequest['model']
  permissionMode?: AgentStartRequest['permissionMode']
  codexHookTrust: ForkRequest['codexHookTrust']
  openCodePluginTrust: ForkRequest['openCodePluginTrust']
  getMcpExecution: () => ForkRequest['mcpExecution']
  forkLastTurnFacet: () => ForkLastTurnFacet | undefined
  userDataDir: () => string
  cloneForkArchiveTurns: (args: { turns: TraceArchiveTurn[]; targetSessionId: string; providerId: ProviderId; runtimeProvider: RuntimeProvider; cwd: string }) => void
  commitSession: (sessionId: string | undefined) => void
  contextChangedError: () => AgentRuntimeError
}

/** Prepares the existing native/archive edit; Main owns the synchronous session commit. */
export async function prepareAppRunEditLastTurn(input: EditLastTurnInput): Promise<void> {
  const { request } = input
  if (request.forkLastTurn) {
    if (!input.forkSourceSessionId || input.forkSourceSessionId !== input.expectedSessionId) throw input.contextChangedError()
    const archive = await readTraceArchiveAsync({
      cwd: input.catalogCwd,
      sessionId: input.forkSourceSessionId,
      providerId: input.providerId,
      userDataDir: input.userDataDir()
    })
    const head = archive?.turns.at(-1)
    if (!archive || head?.runId !== request.forkLastTurn.replaceRunId ||
      head.providerTurnId !== request.forkLastTurn.replaceProviderTurnId ||
      (head.forkTurnId ?? head.providerTurnId) !== request.forkLastTurn.replaceForkTurnId) {
      throw new AgentRuntimeError(copy.lastTurnChanged, {
        provider: input.runtimeProvider,
        stage: 'frontdoor',
        cwd: input.cwd,
        nextAction: copy.reloadLastTurn
      })
    }
    if (request.forkLastTurn.previousProviderTurnId && request.forkLastTurn.previousForkTurnId) {
      const previous = archive.turns.at(-2)
      if (previous?.providerTurnId !== request.forkLastTurn.previousProviderTurnId ||
        (previous.forkTurnId ?? previous.providerTurnId) !== request.forkLastTurn.previousForkTurnId) {
        throw new AgentRuntimeError(copy.previousBoundaryChanged, {
          provider: input.runtimeProvider,
          stage: 'frontdoor',
          cwd: input.cwd,
          nextAction: copy.reloadLastTurn
        })
      }
      const facet = input.forkLastTurnFacet()
      if (!facet) {
        throw new AgentRuntimeError(copy.forkUnavailable, {
          provider: input.runtimeProvider,
          stage: 'capability',
          cwd: input.cwd,
          nextAction: copy.upgradeProvider
        })
      }
      const forked = await facet.fork({
        ...request.forkLastTurn,
        sourceSessionId: input.forkSourceSessionId,
        originalPrompt: head.userText,
        cwd: input.cwd,
        agentProfileId: input.agentProfileId,
        model: input.model,
        permissionMode: input.permissionMode,
        codexHookTrust: input.codexHookTrust,
        openCodePluginTrust: input.openCodePluginTrust,
        mcpExecution: input.getMcpExecution()
      })
      if (!forked.externalSessionId) throw new Error(copy.missingForkSession)
      input.cloneForkArchiveTurns({
        turns: archive.turns.slice(0, -1),
        targetSessionId: forked.externalSessionId,
        providerId: input.providerId,
        runtimeProvider: input.runtimeProvider,
        cwd: input.catalogCwd
      })
      input.commitSession(forked.externalSessionId)
    } else {
      if (archive.turns.length !== 1) {
        throw new AgentRuntimeError(copy.missingPreviousBoundary, {
          provider: input.runtimeProvider,
          stage: 'frontdoor',
          cwd: input.cwd,
          nextAction: copy.loadFullSession
        })
      }
      input.commitSession(undefined)
    }
  } else if (request.restartLastTurn) {
    if (!input.restartSourceSessionId) throw input.contextChangedError()
    const archive = await readTraceArchiveAsync({
      cwd: input.catalogCwd,
      sessionId: input.restartSourceSessionId,
      providerId: input.providerId,
      userDataDir: input.userDataDir()
    })
    if (!canRestartInterruptedLocalOnlySession(archive, request.restartLastTurn.replaceRunId)) {
      throw new AgentRuntimeError(copy.restartChanged, {
        provider: input.runtimeProvider,
        stage: 'frontdoor',
        cwd: input.cwd,
        nextAction: copy.reloadRestart
      })
    }
    input.commitSession(undefined)
  }
}
