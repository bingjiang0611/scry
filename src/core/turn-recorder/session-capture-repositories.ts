import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import { beginGitTurnDiff } from './git-capture.js'
import { recorderOpenPath, recorderStatePath, recorderTurnRoot, type RecorderOpenTurnState, type RecorderSessionState } from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import { TURN_DIFF_BEGIN_DEADLINE_MS } from './git-command.js'

/** A turn cannot baseline an unbounded set of repositories; discovery from tools stays bounded. */
export const CAPTURE_REPOSITORY_LIMIT = 32

/**
 * Remember repositories this session touched so later turns baseline them at turn start. Returns
 * only the newly added roots: an already known repository keeps the baseline it already has.
 */
export async function updateCaptureRepositories(
  root: string,
  roots: string[]
): Promise<string[]> {
  const statePath = recorderStatePath(root)
  const session = await readJson<RecorderSessionState>(statePath)
  if (!session) return []
  const known = session.captureRepositories ?? []
  const added = roots.filter((item) => !known.includes(item))
  if (added.length === 0) return []
  const merged = [...known, ...added].slice(0, CAPTURE_REPOSITORY_LIMIT)
  await writeJsonAtomic(statePath, { ...session, captureRepositories: merged }, { sync: false })
  return merged.slice(known.length)
}

/**
 * Baseline a repository the moment the turn is about to change it. The PreToolUse that names the
 * file arrives before the write, so this baseline is the pre-edit state, not an approximation.
 */
export async function attachCaptureBaseline(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: RecorderOpenTurnState,
  repositories: string[],
  sessionRoot: string
): Promise<void> {
  const known = new Set(open.captures.map((item) => item.repository))
  const captureDir = join(recorderTurnRoot(sessionRoot, open.generation), 'captures')
  const additions = await Promise.all(repositories.filter((repository) => !known.has(repository)).map(async (repository) => ({
    repository,
    capture: await beginGitTurnDiff(repository, TURN_DIFF_BEGIN_DEADLINE_MS, captureDir, [enablement.dataRoot])
  })))
  if (additions.length === 0) return
  await writeJsonAtomic(recorderOpenPath(sessionRoot), {
    ...open,
    captures: [...open.captures, ...additions]
  }, { sync: false })
}
