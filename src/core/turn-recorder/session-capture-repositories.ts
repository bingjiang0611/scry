import { readJson, writeJsonAtomic } from './io.js'
import { beginGitTurnDiff } from './git-capture.js'
import { recorderOpenPath, recorderStatePath, type RecorderOpenTurnState, type RecorderSessionState } from './runtime-state.js'
import { segmentCaptureDir } from './recorder-segment-diff.js'
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
 * 这一段证明过的仓库留在会话上：段链的 object store 被清掉之后，接续段仍要说得出自己缺的是
 * 哪几段的基线，而不是只报一句「没有抓到 diff」。托管轮没有仓库，不动会话里的列表。
 */
export function segmentCaptureRepositories(
  session: RecorderSessionState,
  open: RecorderOpenTurnState
): string[] | undefined {
  if (open.managedByScry) return undefined
  const merged = [...new Set([...(session.captureRepositories ?? []), ...open.captures.map((item) => item.repository)])]
  return merged.length > 0 ? merged.slice(0, CAPTURE_REPOSITORY_LIMIT) : undefined
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
  // Beside the turn, not inside it: sealing removes the turn directory, and a background wake may
  // continue this turn with this capture's end state as its baseline.
  const captureDir = segmentCaptureDir(sessionRoot, open.generation)
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
