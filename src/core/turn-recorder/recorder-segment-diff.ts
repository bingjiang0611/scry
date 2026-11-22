import { readdir, rm, rmdir } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { TraceEvent, TurnDiffSnapshot } from '../../shared/trace.js'
import type { GitAfterTree, GitTurnDiffCapture } from './git-capture.js'
import type { RecorderEnablement } from './config.js'
import type { RecorderFrozenDiff, RecorderOpenTurnState, RecorderSessionState } from './runtime-state.js'
import { beginGitTurnDiff, preserveAfterStorage } from './git-capture.js'
import { TURN_DIFF_BEGIN_DEADLINE_MS } from './git-command.js'
import { limitTurnDiffPatchBytes, finishGitTurnDiff } from './git.js'
import { turnChangeHints } from './change-journal.js'
import { persistTurnDiffContent } from './recorder-turn-state.js'
import { writeJsonAtomic } from './io.js'
import { recorderOpenPath, recorderSessionRoot } from './runtime-state.js'

export function segmentCaptureDir(sessionRoot: string, generation: number): string {
  return join(sessionRoot, 'segment-captures', String(generation))
}

export interface FrozenDiffCollector {
  option(repository: string): (after: GitAfterTree) => void
  list(): RecorderFrozenDiff[]
}

export function frozenDiffCollector(captures: GitTurnDiffCapture[]): FrozenDiffCollector {
  const byRepository = new Map<string, RecorderFrozenDiff>()
  const frozen: RecorderFrozenDiff[] = []
  return {
    option(repository) {
      const capture = captures.find(candidate => candidate.requestedRoot === repository || candidate.repoRoot === repository)
      return (after) => {
        if (byRepository.has(repository)) return
        if (!after.objectDir || !capture?.tempDir) return
        const entry: RecorderFrozenDiff = {
          requestedRoot: repository,
          ...(capture.repoRoot ? { repoRoot: capture.repoRoot } : {}),
          ...(capture.scope ? { scope: capture.scope } : {}),
          tree: after.tree,
          at: after.afterAt,
          objectDir: after.objectDir,
          tempDir: capture.tempDir,
          ...(after.alternateObjectDirs ? { alternateObjectDirs: after.alternateObjectDirs } : {})
        }
        byRepository.set(repository, entry)
        frozen.push(entry)
      }
    },
    list: () => frozen
  }
}

export async function collectTurnDiffs(args: {
  enablement: Extract<RecorderEnablement, { enabled: true }>
  open: RecorderOpenTurnState
  mergedEvents: TraceEvent[]
  worktreeDiffs: Promise<TurnDiffSnapshot[]>
  frozen: FrozenDiffCollector | undefined
}): Promise<{ diffs: TurnDiffSnapshot[]; frozen: RecorderFrozenDiff[] | undefined }> {
  const { enablement, open, frozen } = args
  const diffs = limitTurnDiffPatchBytes(await persistTurnDiffContent(
    enablement.dataRoot,
    [
      ...(open.terminalDiffs
        ? open.terminalDiffs.map(({ repository, snapshot }) => ({ ...snapshot, requestedRoot: repository }))
        : await liveTurnDiffs(enablement, open, args.mergedEvents, frozen)),
      ...await args.worktreeDiffs
    ]
  ))
  const sealed = open.frozenDiffs ?? frozen?.list()
  if (!open.frozenDiffs && sealed?.length) {
    open.frozenDiffs = sealed
    await writeJsonAtomic(recorderOpenPath(recorderSessionRoot(enablement.dataRoot, open.provider, open.sessionId)), open, { sync: false })
  }
  return { diffs, frozen: sealed }
}

function liveTurnDiffs(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: RecorderOpenTurnState,
  mergedEvents: TraceEvent[],
  frozen: FrozenDiffCollector | undefined
): Promise<TurnDiffSnapshot[]> {
  return Promise.all(open.captures.map(async ({ repository, capture }) => ({
    ...await finishGitTurnDiff(capture, undefined, {
      ...turnChangeHints(repository, mergedEvents),
      patchExcludeBasenames: enablement.config.capture.patchExcludeBasenames,
      diffExclude: [...(enablement.config.capture.diffExclude ?? []), ...(open.capture?.diffExclude ?? [])],
      completePatches: true,
      ...(frozen ? { onAfter: frozen.option(repository) } : {})
    }),
    requestedRoot: repository
  })))
}

export function segmentFreeze(args: {
  enabled: boolean
  open: RecorderOpenTurnState
  gaveUp: boolean
}): FrozenDiffCollector | undefined {
  if (!args.enabled || args.gaveUp || args.open.terminalDiffs) return undefined
  const captures = args.open.captures.map(({ capture }) => capture)
  const collector = frozenDiffCollector(captures)
  preserveSegmentStorage(captures)
  return collector
}

export function preserveSegmentStorage(captures: GitTurnDiffCapture[]): void {
  for (const capture of captures) {
    if (capture.status === 'ready' && capture.tempDir) preserveAfterStorage(capture)
  }
}

export async function releaseSegmentChain(
  sessionRoot: string,
  session: RecorderSessionState,
  frozen: RecorderFrozenDiff[] | undefined,
  continuesChain: boolean
): Promise<string[]> {
  const own = [...new Set((frozen ?? []).map(entry => entry.tempDir))]
  const previous = session.chainStores ?? []
  const stale = previous.filter(tempDir => !own.includes(tempDir))
  if (!continuesChain) await releaseFrozenDiffs(stale.map(tempDir => ({ tempDir } as RecorderFrozenDiff)))
  const stores = [...new Set([...(continuesChain ? previous : []), ...own])]
  await pruneSegmentCaptures(sessionRoot, new Set(stores.map(dirname)))
  return stores
}

export async function pruneSegmentCaptures(sessionRoot: string, keep: Set<string>): Promise<void> {
  const root = join(sessionRoot, 'segment-captures')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries
    .filter(entry => entry.isDirectory() && !keep.has(join(root, entry.name)))
    .map(entry => rm(join(root, entry.name), { recursive: true, force: true }).catch(() => undefined)))
}

export async function releaseFrozenDiffs(frozen: RecorderFrozenDiff[] | undefined): Promise<void> {
  if (!frozen?.length) return
  await Promise.all(frozen.map(entry => rm(entry.tempDir, { recursive: true, force: true })
    .then(() => rmdir(dirname(entry.tempDir)).catch(() => undefined))
    .catch(() => undefined)))
}

export async function continuationCaptures(args: {
  frozen: RecorderFrozenDiff[] | undefined
  repositories: string[]
  captureRoot: string
  excludedPaths: string[]
}): Promise<Array<{ repository: string; capture: GitTurnDiffCapture }>> {
  const frozen = args.frozen ?? []
  const repositories = [...new Set([...frozen.map(entry => entry.requestedRoot), ...args.repositories])]
  return Promise.all(repositories.map(async (repository) => {
    const prior = frozen.find(entry => entry.requestedRoot === repository)
    if (!prior) {
      return {
        repository,
        capture: {
          beforeAt: new Date().toISOString(),
          captureMs: 0,
          status: 'unavailable' as const,
          reason: 'no_baseline' as const,
          requestedRoot: repository
        }
      }
    }
    const objectDirs = [prior.objectDir, ...(prior.alternateObjectDirs?.split(delimiter) ?? [])]
    const capture = await beginGitTurnDiff(
      prior.requestedRoot,
      TURN_DIFF_BEGIN_DEADLINE_MS,
      args.captureRoot,
      args.excludedPaths,
      false,
      { commit: prior.tree, at: prior.at, objectDirs }
    )
    return { repository, capture }
  }))
}
