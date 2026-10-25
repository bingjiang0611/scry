import {
  type GitTurnDiffCapture,
  type GitTurnDiffFinishOptions,
  serializeCaptureOp,
  type GitAfterTree,
  retainAfterStorage,
  cleanupCapture,
  terminalSnapshot
} from './git-capture.js'
import {
  TURN_DIFF_FINISH_DEADLINE_MS
} from './git-command.js'
import {
  type TurnDiffSnapshot
} from '../../shared/trace.js'
import {
  computeGitTurnDiff
} from './git-compute.js'

export function finishGitTurnDiff(
  capture: GitTurnDiffCapture,
  deadlineMs = TURN_DIFF_FINISH_DEADLINE_MS,
  options: GitTurnDiffFinishOptions = {}
): Promise<TurnDiffSnapshot> {
  capture.finishPromise ??= serializeCaptureOp(capture, () => computeGitTurnDiff(capture, deadlineMs, options, true))
  return capture.finishPromise
}

function sameSnapshotScope(capture: GitTurnDiffCapture, baseline: GitTurnDiffCapture): boolean {
  const ready = (value: GitTurnDiffCapture): boolean => value.status === 'ready' &&
    !!value.repoRoot && !!value.scope && !!value.beforeTree && !!value.tempDir && !!value.objectDir
  const samePaths = (left: string[], right: string[]): boolean => {
    const a = new Set(left)
    const b = new Set(right)
    return a.size === b.size && [...a].every(path => b.has(path))
  }
  return ready(capture) && ready(baseline) && capture.repoRoot === baseline.repoRoot &&
    capture.scope === baseline.scope &&
    samePaths(capture.pathspec ?? [capture.scope!], baseline.pathspec ?? [baseline.scope!]) &&
    samePaths(capture.excludedPaths ?? [], baseline.excludedPaths ?? [])
}

/**
 * A compatible terminal pair owns one immutable endpoint. The turn releases its reference and
 * becomes observable first; the session owns the remaining reference until its projection and
 * cleanup finish. This is the same ownership rule as baseline clones, not deferred unowned work.
 */
export function finishGitTurnAndSessionDiff(
  capture: GitTurnDiffCapture,
  baseline: GitTurnDiffCapture,
  deadlineMs = TURN_DIFF_FINISH_DEADLINE_MS,
  turnOptions: GitTurnDiffFinishOptions = {},
  sessionOptions: GitTurnDiffFinishOptions = {}
): { turn: Promise<TurnDiffSnapshot>; session: Promise<TurnDiffSnapshot> } {
  if (capture.finishPromise || capture === baseline || !sameSnapshotScope(capture, baseline)) {
    const turn = finishGitTurnDiff(capture, deadlineMs, turnOptions)
    return { turn, session: turn.then(() => snapshotSessionNetDiff(baseline, deadlineMs, sessionOptions)) }
  }
  const previous = Promise.all([capture.opChain, baseline.opChain])
  let shared = false
  let after: GitAfterTree | undefined
  let captureStarted = Date.now()
  let releasePeer: (() => Promise<TurnDiffSnapshot['cleanup']>) | undefined
  const turn = previous.then(async () => {
    captureStarted = Date.now()
    shared = sameSnapshotScope(capture, baseline)
    let snapshot: TurnDiffSnapshot
    let cleanup: TurnDiffSnapshot['cleanup'] = 'ok'
    let cleanupMs = 0
    try {
      snapshot = await computeGitTurnDiff(capture, deadlineMs, shared ? {
        ...turnOptions,
        forceFull: turnOptions.forceFull === true || sessionOptions.forceFull === true,
        structuredPaths: [...(turnOptions.structuredPaths ?? []), ...(sessionOptions.structuredPaths ?? [])]
      } : turnOptions, false, undefined, shared ? value => {
        after = value
        releasePeer = retainAfterStorage(capture)
      } : undefined)
    } finally {
      const cleanupStarted = Date.now()
      cleanup = await cleanupCapture(capture)
      cleanupMs = Date.now() - cleanupStarted
    }
    return { ...snapshot, captureMs: snapshot.captureMs + cleanupMs, cleanup }
  })
  const session = turn.then(async turnSnapshot => {
    let snapshot: TurnDiffSnapshot
    let cleanup: TurnDiffSnapshot['cleanup'] = 'ok'
    let cleanupMs = 0
    try {
      snapshot = !shared
        ? await computeGitTurnDiff(baseline, deadlineMs, sessionOptions, false)
        : after
          ? await computeGitTurnDiff(baseline, deadlineMs, sessionOptions, false, after)
          : terminalSnapshot(
              baseline, turnSnapshot.status === 'timeout' ? 'timeout' : 'failed',
              turnSnapshot.reason ?? 'git_error', [], turnSnapshot.afterAt, Date.now() - captureStarted, 'ok',
              turnSnapshot.collection ? { ...turnSnapshot.collection, sharedAfter: 'turn' } : undefined
            )
    } finally {
      if (releasePeer) {
        const cleanupStarted = Date.now()
        cleanup = await releasePeer()
        cleanupMs = Date.now() - cleanupStarted
      }
    }
    return { ...snapshot, captureMs: snapshot.captureMs + cleanupMs, ...(cleanup === 'failed' ? { cleanup } : {}) }
  }, async error => {
    if (releasePeer) await releasePeer()
    throw error
  })
  // Reserving both queues synchronously also serializes registry cancellation. The turn's
  // finishPromise is independent, but neither capture may be disposed by a queued operation
  // until the session has released the last dependency on the turn's objects.
  const settled = session.then(() => undefined, () => undefined)
  capture.opChain = settled
  baseline.opChain = settled
  capture.finishPromise = turn
  return { turn, session }
}

// 会话级净改动：拿一个「会话第一轮开始前」捕获、且贯穿整个会话存活的 baseline capture，
// 把当前工作树快照进它自己的 object store，再 diff baseline.beforeTree → 当前树。
// 与逐轮 finishGitTurnDiff 的关键区别：非消费式——不清理 baseline，可跨轮多次调用，
// 每次都得到「基线 → 此刻」的真实净 diff（同一行跨轮反复改只净算一次），
// 会话开始前已有的脏改动已折进 beforeTree 因而自然被排除。
export function snapshotSessionNetDiff(
  baseline: GitTurnDiffCapture,
  deadlineMs = TURN_DIFF_FINISH_DEADLINE_MS,
  options: GitTurnDiffFinishOptions = {}
): Promise<TurnDiffSnapshot> {
  return serializeCaptureOp(baseline, () => computeGitTurnDiff(baseline, deadlineMs, options, false))
}

/**
 * 运行中预览：对同一个 capture 做非消费式重算，得到「基线 → 此刻」的临时净 diff。
 * 一旦终态重算已经开始（finishPromise 存在），capture 的 tempDir 归终态所有并会被消费，
 * 此时返回 null——调用方必须丢弃这条迟到预览，绝不能用它覆盖已发布的终态。
 */
export function previewGitTurnDiff(
  capture: GitTurnDiffCapture,
  deadlineMs = TURN_DIFF_FINISH_DEADLINE_MS,
  options: GitTurnDiffFinishOptions = {}
): Promise<TurnDiffSnapshot | null> {
  if (capture.finishPromise) return Promise.resolve(null)
  return serializeCaptureOp(capture, async () => {
    if (capture.finishPromise) return null
    return computeGitTurnDiff(capture, deadlineMs, options, false)
  })
}

export function cancelGitTurnDiff(capture: GitTurnDiffCapture): Promise<void> {
  return serializeCaptureOp(capture, async () => { await cleanupCapture(capture) })
}
