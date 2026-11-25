import { realpath } from 'node:fs/promises'
import { readJson, writeJsonAtomic } from './io.js'
import { beginGitTurnDiff } from './git-capture.js'
import { recorderOpenPath, recorderStatePath, type RecorderOpenTurnState, type RecorderSessionState } from './runtime-state.js'
import { segmentCaptureDir } from './recorder-segment-diff.js'
import type { RecorderEnablement } from './config.js'
import { TURN_DIFF_BEGIN_DEADLINE_MS } from './git-command.js'

export const CAPTURE_REPOSITORY_LIMIT = 32

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

export async function attachCaptureBaseline(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: RecorderOpenTurnState,
  repositories: string[],
  sessionRoot: string
): Promise<void> {
  const known = new Set(open.captures.map(item => item.repository))
  let newRepositories = repositories.filter(repository => !known.has(repository))
  if (enablement.config.capture.sessions === 'opt-in' && newRepositories.length) {
    // Keep tool-path spelling in session state, but don't take another baseline for a repo
    // mounted under an alias. Mounted captures already carry the canonical Git root.
    const canonical = new Set(open.captures.map(item => item.capture.repoRoot ?? item.repository))
    const identities = await Promise.all(newRepositories.map(path => realpath(path).catch(() => path)))
    newRepositories = newRepositories.filter((_, index) => {
      const identity = identities[index]
      if (canonical.has(identity)) return false
      canonical.add(identity)
      return true
    })
  }
  const captureDir = segmentCaptureDir(sessionRoot, open.generation)
  const additions = await Promise.all(newRepositories.map(async (repository) => ({
    repository,
    capture: await beginGitTurnDiff(repository, TURN_DIFF_BEGIN_DEADLINE_MS, captureDir, [enablement.dataRoot])
  })))
  if (additions.length === 0) return
  await writeJsonAtomic(recorderOpenPath(sessionRoot), {
    ...open,
    captures: [...open.captures, ...additions]
  }, { sync: false })
}
