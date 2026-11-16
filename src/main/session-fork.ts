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
  // A provider-settled failure is still a stable native boundary. Pi/Rotom users can
  // navigate to that point in the terminal and continue on a new branch; Scry must not
  // hide the equivalent recovery path merely because the assistant response failed.
  // Interrupted/cancelled/running turns remain unsafe because their native boundary may
  // still be incomplete or locally synthesized.
  if (!source || source.done !== true || (source.status !== 'completed' && source.status !== 'failed')) {
    // Say which check failed, without IDs or paths (round seven G4 could not tell them apart).
    const reason = !archive ? '没有找到该会话的归档'
      : !source ? `该会话归档的 ${archive.turns.length} 轮中没有这一轮`
        : `这一轮${source.done === true ? '' : '尚未结束，'}状态为 ${source.status ?? '未知'}`
    throw new Error(`找不到可分支的已结束轮次：${reason}`)
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

/**
 * Why no archive was found for a fork source (round eight H3): the same session archived under
 * another workspace key, or this workspace holding other sessions, point at different bugs.
 * Counts only; no IDs or paths.
 */
export function describeMissingForkArchive(
  summaries: ReadonlyArray<{ cwd: string; sessionId: string }>,
  key: { cwd: string; sessionId: string }
): string {
  const sameSessionElsewhere = summaries.filter((entry) => entry.sessionId === key.sessionId && entry.cwd !== key.cwd).length
  const sameWorkspace = summaries.filter((entry) => entry.cwd === key.cwd).length
  return `找不到可分支的已结束轮次：没有找到该会话的归档（该会话在其他工作目录下有 ${sameSessionElsewhere} 份归档；本工作目录下有 ${sameWorkspace} 个其他会话的归档）`
}
