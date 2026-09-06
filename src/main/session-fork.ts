import type { AgentForkSessionRequest } from '../shared/runtime'
import type { TraceArchive, TraceArchiveTurn } from './transcript-archive'

export interface VerifiedForkBoundary {
  source: TraceArchiveTurn
  sourceIndex: number
  prefix: TraceArchiveTurn[]
}

/**
 * Provider fork 必须锚定 Scry 已归档的稳定原生边界；renderer 传来的 run/turn id
 * 只用于定位和比对，不能单独决定 fork 位置。
 */
export function verifyForkArchiveBoundary(
  archive: TraceArchive | null,
  request: Pick<AgentForkSessionRequest, 'sourceRunId' | 'sourceProviderTurnId' | 'sourceForkTurnId'>
): VerifiedForkBoundary {
  const sourceIndex = archive?.turns.findIndex((turn) => turn.runId === request.sourceRunId) ?? -1
  const source = sourceIndex >= 0 ? archive!.turns[sourceIndex] : undefined
  if (!source || source.done !== true || source.status !== 'completed') {
    throw new Error('找不到可分支的已完成轮次')
  }
  if (source.providerTurnId !== request.sourceProviderTurnId ||
    (source.forkTurnId ?? source.providerTurnId) !== request.sourceForkTurnId) {
    throw new Error('分支轮次边界已变化，请重新打开会话后再试')
  }
  return {
    source,
    sourceIndex,
    prefix: archive!.turns.slice(0, sourceIndex + 1)
  }
}
