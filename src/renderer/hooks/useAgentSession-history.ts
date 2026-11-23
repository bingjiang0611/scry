import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { ParsedTurn } from '../env'
import type { Turn } from '../format'
import { applyTraceBatch } from '../trace-batch'
import {
  mergeActiveRun,
  replayRunLifecycleDeltas,
  sessionTurnsWithActiveRun,
  type OlderSessionPage,
  type RunLifecycleDelta
} from './useAgentSession-helpers'

export function restoreSessionTurns(
  previous: Turn[],
  sessionId: string,
  parsed: ParsedTurn[],
  activeRun: ActiveRun | null,
  page: OlderSessionPage | null | undefined,
  traceDeltas: TraceEvent[],
  lifecycleDeltas: RunLifecycleDelta[],
  clearedRuns: Set<string>
): Turn[] {
  const snapshot = sessionTurnsWithActiveRun(sessionId, parsed, activeRun, page?.offset ?? 0)
  if (!activeRun) return snapshot
  if (page?.projection) {
    const items = new Map(activeRun.items.map((item) => [item.id, item]))
    const fresh = traceDeltas.filter((item) => {
      const previous = items.get(item.id)
      return !previous || item.stage === 'result_superseded' || Date.parse(item.ts) > Date.parse(previous.ts)
    })
    return replayRunLifecycleDeltas(applyTraceBatch(snapshot, fresh, clearedRuns), lifecycleDeltas)
  }
  const local = previous.find((turn) => turn.runId === activeRun.runId)
  const merged = local ? mergeActiveRun([local], activeRun)[0] : activeRun
  return replayRunLifecycleDeltas(
    snapshot.map((turn) => (turn.runId === activeRun.runId ? merged : turn)),
    lifecycleDeltas
  )
}

export async function readTerminalEvidence(turn: Turn): Promise<TraceEvent[]> {
  const { providerId, cwd, externalSessionId } = turn
  if (!providerId || !cwd || !externalSessionId || !window.scry.turnTerminalEvidence) return []
  return window.scry.turnTerminalEvidence({
    providerId, agentProfileId: turn.agentProfileId, cwd, externalSessionId
  }, turn.runId)
}
