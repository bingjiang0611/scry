import { rm } from 'node:fs/promises'
import type { TurnDiffSnapshot } from '../../shared/trace.js'
import type { GitTurnDiffCapture } from './git-capture.js'

/**
 * Who owns a capture's temporary object store.
 *
 * The store outlives the process that created it while a continuation segment still needs its
 * blobs, and it is released by the next segment's finalize. Keeping that lifecycle in one module
 * means `git-capture.ts` states how a store is created and this module states when it disappears.
 */

const retainedCaptureStorage = new WeakMap<GitTurnDiffCapture, () => Promise<TurnDiffSnapshot['cleanup']>>()

/**
 * 保留本 capture 的 object store 到本段之后：下一段以本段结束时的树为基线，需要这里的 blob。
 * 逐段链式保留，释放由下一段封箱负责。标记必须随 open 状态持久化：hold 与封箱是不同进程，
 * 进程内的 set 在恢复时认不出重新读出来的 capture。
 */
export function preserveAfterStorage(capture: GitTurnDiffCapture): void {
  capture.preservedStorage = true
}

/** The segment chain was dropped (a real prompt resumed the turn): clean up normally again. */
export function resumeAfterStorage(capture: GitTurnDiffCapture): void {
  capture.preservedStorage = false
}

/** A terminal peer owns one reference to the complete source store, including clone-only objects. */
export function retainAfterStorage(capture: GitTurnDiffCapture): () => Promise<TurnDiffSnapshot['cleanup']> {
  const owner: GitTurnDiffCapture = { ...capture, finishPromise: undefined, opChain: undefined }
  let references = 2
  const release = async (): Promise<TurnDiffSnapshot['cleanup']> => {
    references--
    return references === 0 ? cleanupCapture(owner) : 'ok'
  }
  retainedCaptureStorage.set(capture, release)
  return release
}

export async function cleanupCapture(capture: GitTurnDiffCapture): Promise<TurnDiffSnapshot['cleanup']> {
  if (capture.preservedStorage) {
    // The next segment still needs this store. The shared session baseline keeps its reference so
    // blobs that predate it stay resolvable for that segment's diff.
    capture.tempDir = undefined
    capture.sharedStorage = undefined
    return 'ok'
  }
  const release = retainedCaptureStorage.get(capture)
  if (release) {
    retainedCaptureStorage.delete(capture)
    capture.tempDir = undefined
    capture.sharedStorage = undefined
    return release()
  }
  if (!capture.tempDir) return 'ok'
  const dir = capture.tempDir
  const sharedStorage = capture.sharedStorage
  capture.tempDir = undefined
  capture.sharedStorage = undefined
  const remove = new Set<string>()
  if (!sharedStorage) {
    remove.add(dir)
  } else {
    if (dir !== sharedStorage.rootDir) remove.add(dir)
    sharedStorage.refs = Math.max(0, sharedStorage.refs - 1)
    if (sharedStorage.refs === 0) remove.add(sharedStorage.rootDir)
  }
  try {
    await Promise.all([...remove].map((path) => rm(path, { recursive: true, force: true })))
    return 'ok'
  } catch {
    return 'failed'
  }
}
