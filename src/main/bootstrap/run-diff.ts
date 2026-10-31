import type { ActiveRun, TraceEvent, TurnDiffBaselineOrigin, TurnDiffReason, TurnDiffSnapshot } from '../../shared/trace'
import type { RuntimeProvider } from '../../shared/runtime'
import type { ProviderId } from '../../shared/provider'
import type { GitTurnDiffCapture } from '../git'
import { cancelGitTurnDiff, finishGitTurnAndSessionDiff, finishGitTurnDiff, snapshotSessionNetDiff } from '../git'
import { RunDiffPreviewer, SessionDiffBaselineRegistry } from '../session-diff'
import type { TurnChangeJournal } from '../../core/turn-recorder/change-journal'

type PairedSessionDiff = { capture: GitTurnDiffCapture; snapshot: Promise<TurnDiffSnapshot> }
export type RunDiffLifecycle = {
  setDiffPreviewDemand: ((demanded: boolean) => void) | undefined
  finalizeTurnDiff: () => Promise<void>
  cancelTurnDiff: () => Promise<void>
  finalizeSessionDiff: () => Promise<void>
  getPairedSessionDiff: () => PairedSessionDiff | undefined
}
export type RunDiffDependencies = {
  isRemoteRun: boolean
  diffPreviewer: RunDiffPreviewer
  turnDiffCapture: Promise<GitTurnDiffCapture>
  turnChangeJournal: TurnChangeJournal | null
  patchExcludeBasenames: string[]
  cwd: string | undefined
  contextKey: string
  runId: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  runState: ActiveRun
  sessionDiffBaselines: SessionDiffBaselineRegistry
  getDiffContextKey: () => string
  getObservedSessionId: () => string | undefined
  getResume: () => string | undefined
  getContextRevision: () => number
  mainEventId: (prefix: string, runId: string) => string
  appendCoalescedTrace: (items: ActiveRun['items'], event: TraceEvent) => void
  publishTrace: (event: TraceEvent) => void
}

export function createRunDiffLifecycle(deps: RunDiffDependencies): RunDiffLifecycle {
  let pairedSessionDiff: PairedSessionDiff | undefined
  const { diffPreviewer, turnDiffCapture, turnChangeJournal, patchExcludeBasenames, cwd, contextKey, runId, providerId, runtimeProvider, runState, sessionDiffBaselines, mainEventId, appendCoalescedTrace, publishTrace } = deps
  // Remote owners have no view-demand protocol. Missing evidence is not a hidden
  // view: only local views opt out of previews until they explicitly subscribe.
  const setDiffPreviewDemand = deps.isRemoteRun ? undefined : (demanded: boolean): void => {
    void diffPreviewer.setDemanded(demanded)
  }
  setDiffPreviewDemand?.(false)
  let turnDiffPromise: Promise<void> | null = null
  // 并行工作区重叠证据：缺失就是未观测（旧记录/无基线），不能当成独占归因。
  const withOverlap = (snapshot: TurnDiffSnapshot, from?: number): TurnDiffSnapshot => {
    if (snapshot.status !== 'captured') return snapshot
    const overlap = sessionDiffBaselines.workspaceOverlap(runId, from)
    return overlap ? { ...snapshot, workspaceOverlap: overlap } : snapshot
  }
  const finalizeTurnDiff = (): Promise<void> => {
    // 终态第一次进入收口就把所有 scope 封口，再等全局 idle：idle 等的是全部在途预览链，
    // 只封 turn 的话 session 链还能继续续 trailing，收口要么白等，要么让迟到的预览
    // 落到终态之后。封口后算完的预览一律丢弃——终态覆盖预览，不倒退。
    diffPreviewer.sealAll()
    turnDiffPromise ??= diffPreviewer.idle()
      .then(() => turnDiffCapture)
      .then(async (capture) => {
        const options = { ...turnChangeJournal?.snapshot(), patchExcludeBasenames }
        const entry = cwd && contextKey
          ? sessionDiffBaselines.get(deps.getDiffContextKey(), 0, deps.getObservedSessionId() ?? deps.getResume())
          : undefined
        if (!entry) return finishGitTurnDiff(capture, undefined, options)
        let baseline: GitTurnDiffCapture
        try { baseline = await entry.capture } catch {
          // Session finalization retains its existing no_baseline reporting; turn evidence is independent.
          return finishGitTurnDiff(capture, undefined, options)
        }
        if (baseline.status !== 'ready') return finishGitTurnDiff(capture, undefined, options)
        const pair = finishGitTurnAndSessionDiff(capture, baseline, undefined, options, { patchExcludeBasenames })
        pairedSessionDiff = { capture: baseline, snapshot: pair.session }
        void pair.session.catch(error => console.warn('[scry] paired session diff failed:', runId, error))
        return pair.turn
      })
      .then((captured) => {
        const turnDiff = withOverlap(captured)
        const event: TraceEvent = {
          id: mainEventId('turn-diff', runId),
          ts: new Date().toISOString(),
          runId,
          kind: 'harness',
          stage: 'turn_diff',
          providerId,
          runtimeProvider,
          turnDiff
        }
        appendCoalescedTrace(runState.items, event)
        // 终态在 done=true 之后才算完，isFocused 此刻已是 false。publishTrace 用「仍在看」判定
        // legacy 焦点通道，同时把这条终态 diff 交给该 run 的 scoped 流，归档里有的不会收不到。
        publishTrace(event)
        if (turnDiff.status === 'failed' || turnDiff.status === 'timeout') {
          console.warn('[scry] turn diff capture degraded:', runId, turnDiff.reason, turnDiff.captureMs)
        }
        if (turnDiff.collection?.strategy === 'full_fallback' && turnDiff.collection.fallbackReason !== 'forced') {
          console.warn(
            '[scry] turn diff used full fallback:',
            runId,
            turnDiff.collection.fallbackReason,
            turnDiff.collection.candidatePathCount,
            turnDiff.collection.discoveryMs,
            turnDiff.collection.targetedMs
          )
        }
        const patchUnavailable = turnDiff.files.filter((file) => file.patchStatus === 'unavailable')
        if (patchUnavailable.length > 0) {
          console.warn(
            '[scry] turn diff patch partially unavailable:',
            runId,
            patchUnavailable.length,
            [...new Set(patchUnavailable.map((file) => file.patchReason))]
          )
        }
      })
      .catch(async (error) => {
        try {
          const capture = await turnDiffCapture
          await cancelGitTurnDiff(capture)
        } catch {
          // Capture may itself have failed before allocating a snapshot.
        }
        console.warn('[scry] turn diff finalization failed:', runId, error)
      })
    return turnDiffPromise
  }
  const cancelTurnDiff = (): Promise<void> => {
    diffPreviewer.sealAll()
    turnDiffPromise ??= diffPreviewer.idle()
      .then(() => turnDiffCapture)
      .then((capture) => cancelGitTurnDiff(capture))
      .catch((error) => console.warn('[scry] turn diff cancellation failed:', runId, error))
    return turnDiffPromise
  }
  // 会话级净 diff：在逐轮 turnDone 后，用贯穿会话的 baseline 对当前工作树重算「基线 → 此刻」，
  // 落一条 harness/session_diff。它是右栏会话 diff 与对话末尾会话摘要的权威来源。
  //
  // 每一轮都必须落一条，失败也要落 unavailable + reason：renderer 的会话快照选取是「从最近一轮
  // 往前找第一条带快照的轮次并停下」，静默跳过会让它越过本轮回退到上一轮的旧快照，把过期数字
  // 当成当前会话净改动展示（实测：只有首轮落过 session_diff，后续轮次一直显示首轮的文件与行数）。
  // 非消费式，baseline 继续供后续轮复用。
  let sessionDiffPromise: Promise<void> | null = null
  const finalizeSessionDiff = (): Promise<void> => {
    if (!cwd || !contextKey) return Promise.resolve()
    // 同 finalizeTurnDiff：终态收口先全封口，再等全局 idle，不给任何 scope 留续 trailing 的机会。
    diffPreviewer.sealAll()
    sessionDiffPromise ??= (async () => {
      await diffPreviewer.idle()
      const entry = sessionDiffBaselines.get(deps.getDiffContextKey(), 0, deps.getObservedSessionId() ?? deps.getResume())
      const publishSessionDiff = (published: TurnDiffSnapshot, origin?: TurnDiffBaselineOrigin): void => {
        // 会话净 diff 跨前面的轮次与空闲时间：窗口回溯到会话基线，而不是本轮基线。
        const snapshot = withOverlap(published, entry?.observedAt)
        const event: TraceEvent = {
          id: mainEventId('session-diff', runId),
          ts: new Date().toISOString(),
          runId,
          kind: 'harness',
          stage: 'session_diff',
          providerId,
          runtimeProvider,
          turnDiff: origin ? { ...snapshot, baseline: origin } : snapshot
        }
        appendCoalescedTrace(runState.items, event)
        publishTrace(event)
      }
      const unavailableSnapshot = (reason: TurnDiffReason): TurnDiffSnapshot => {
        const at = new Date().toISOString()
        return { version: 1, status: 'unavailable', reason, files: [], beforeAt: at, afterAt: at, captureMs: 0, cleanup: 'ok' }
      }
      if (!entry) {
        console.warn('[scry] session diff baseline not found:', runId, {
          contextRevision: deps.getContextRevision(),
          sessionId: deps.getObservedSessionId() ?? deps.getResume()
        })
        publishSessionDiff(unavailableSnapshot('no_baseline'))
        return
      }
      let baseline: GitTurnDiffCapture
      try {
        baseline = await entry.capture
      } catch (error) {
        console.warn('[scry] session diff baseline capture rejected:', runId, error)
        publishSessionDiff(unavailableSnapshot('no_baseline'), entry.origin)
        return
      }
      if (baseline.status !== 'ready') {
        console.warn('[scry] session diff baseline not ready:', runId, baseline.status, baseline.reason)
        publishSessionDiff(
          { ...unavailableSnapshot(baseline.reason ?? 'no_baseline'), status: baseline.status },
          entry.origin
        )
        return
      }
      let snapshot: TurnDiffSnapshot
      try {
        snapshot = await (pairedSessionDiff?.capture === baseline
          ? pairedSessionDiff.snapshot
          : snapshotSessionNetDiff(baseline, undefined, { patchExcludeBasenames }))
      } catch (error) {
        console.warn('[scry] session diff capture failed:', runId, error)
        publishSessionDiff(unavailableSnapshot('git_error'), entry.origin)
        return
      }
      publishSessionDiff(snapshot, entry.origin)
    })().catch((error) => console.warn('[scry] session diff finalization failed:', runId, error))
    return sessionDiffPromise
  }
  return { setDiffPreviewDemand, finalizeTurnDiff, cancelTurnDiff, finalizeSessionDiff, getPairedSessionDiff: () => pairedSessionDiff }
}
