import type { EventSinkStatements } from './event-sink-statements'
import {
  listQueuedRunsRaw,
  listNonTerminalChildRunsBySessionRaw,
  listNonTerminalChildRunsRaw,
  readInteractionRaw,
  readNextTurnOrdinalRaw,
  readReceiptRaw,
  readRunRaw,
  readSessionRaw,
  readTurnByOrdinalRaw,
  readTurnByRunIdRaw
} from './event-sink-queries'
import { findNativeSession } from './native-session-lookup'
import type { OrchestratorReadView } from './orchestrator-handlers'
import type { EventSink } from './event-sink'

export interface OrchestratorReadViewInput {
  stmts: EventSinkStatements
  authorizedActors: ReadonlySet<string>
  maxActiveRuns: number
  isProviderAuthenticating: (provider: string, profile: string | null) => boolean
  nativeSessionSource: EventSink
}

/** Builds the zero-I/O view the pure decision function reads (core §2.1). */
export function createOrchestratorReadView(input: OrchestratorReadViewInput): OrchestratorReadView {
  const { stmts } = input
  return {
    isActorAuthorized: (actor) => actor.startsWith('effect:') || input.authorizedActors.has(actor),
    getReceipt: (commandId, actor) => readReceiptRaw(stmts, commandId, actor),
    getRun: (runId) => readRunRaw(stmts, runId),
    getSession: (sessionKey) => readSessionRaw(stmts, sessionKey),
    getNativeSession: (identity) => findNativeSession(input.nativeSessionSource, identity),
    getTurnByRunId: (runId) => readTurnByRunIdRaw(stmts, runId),
    getTurnByOrdinal: (sessionKey, ordinal) => readTurnByOrdinalRaw(stmts, sessionKey, ordinal),
    getNextTurnOrdinal: (sessionKey) => readNextTurnOrdinalRaw(stmts, sessionKey),
    getInteraction: (runId, questionId) => readInteractionRaw(stmts, runId, questionId),
    listNonTerminalChildRuns: (parentRunId) => listNonTerminalChildRunsRaw(stmts, parentRunId),
    listNonTerminalChildRunsBySession: (sessionKey) => listNonTerminalChildRunsBySessionRaw(stmts, sessionKey),
    hasActiveRunForSession: (sessionKey) => Boolean(stmts.hasActiveSessionRun.get(sessionKey)),
    nextQueuePosition: (sessionKey) =>
      Number((stmts.nextQueuePosition.get(sessionKey) as { next_position?: number } | undefined)?.next_position ?? 1),
    listQueuedRuns: (sessionKey) => listQueuedRunsRaw(stmts, sessionKey),
    activeRunCount: () => (stmts.activeRunCount.get() as { count: number }).count,
    maxActiveRuns: () => input.maxActiveRuns,
    isProviderAuthenticating: (provider, profile) => input.isProviderAuthenticating(provider, profile)
  }
}
