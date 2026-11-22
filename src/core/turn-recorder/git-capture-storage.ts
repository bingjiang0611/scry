import { rm } from 'node:fs/promises'
import type { TurnDiffSnapshot } from '../../shared/trace.js'
import type { GitTurnDiffCapture } from './git-capture.js'


const retainedCaptureStorage = new WeakMap<GitTurnDiffCapture, () => Promise<TurnDiffSnapshot['cleanup']>>()

export function preserveAfterStorage(capture: GitTurnDiffCapture): void {
  capture.preservedStorage = true
}

export function resumeAfterStorage(capture: GitTurnDiffCapture): void {
  capture.preservedStorage = false
}

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
