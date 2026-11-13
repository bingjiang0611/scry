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

/**
 * Segment diff baselines.
 *
 * A wake continues the same logical turn, so the record that covers the wake has to show what that
 * segment changed — not everything the turn changed and not nothing. The boundary is the previous
 * segment's sealed end state: whatever the work tree held when that record was published.
 *
 * Freezing means keeping that segment's object store: the end tree's blobs (edited and untracked
 * files) live only in the recorder's isolated store, never in the user's repository. The store is
 * preserved per segment and released when the next segment publishes.
 */
/**
 * Segment captures live beside the turn, not inside it: sealing removes the turn directory, and the
 * next segment still needs this one's object store as its baseline.
 */
export function segmentCaptureDir(sessionRoot: string, generation: number): string {
  return join(sessionRoot, 'segment-captures', String(generation))
}

export interface FrozenDiffCollector {
  /** The `onAfter` hook that freezes one repository's end tree. */
  option(repository: string): (after: GitAfterTree) => void
  list(): RecorderFrozenDiff[]
}

/** Collect the end tree of every repository this segment captured. */
export function frozenDiffCollector(captures: GitTurnDiffCapture[]): FrozenDiffCollector {
  const byRepository = new Map<string, RecorderFrozenDiff>()
  const frozen: RecorderFrozenDiff[] = []
  return {
    option(repository) {
      const capture = captures.find(candidate => candidate.requestedRoot === repository || candidate.repoRoot === repository)
      return (after) => {
        if (byRepository.has(repository)) return
        // A tree without its store cannot be a baseline later: the blobs are not in the repository.
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

/**
 * The diff evidence a segment publishes.
 *
 * A held segment publishes the snapshot frozen at its Provider boundary; every other segment
 * finishes its own capture here. Patch content is stored separately and bounded; the record keeps
 * only the references, which is why a held turn cannot do this inside the hook that stopped it.
 */
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
  // Durable before the record is committed: a recovery that re-finalizes this generation must keep
  // the boundary the record was committed with, not re-read a later workspace and leave the gap
  // between the two unassigned.
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
      completePatches: true,
      ...(frozen ? { onAfter: frozen.option(repository) } : {})
    }),
    // A failed Git baseline may not resolve repoRoot. Preserve the known request directory
    // separately, without inventing a successful Git-root observation.
    requestedRoot: repository
  })))
}

/**
 * Freeze the end state this segment publishes. A segment that gives up on its diff (expired
 * baseline, unmatched identity) has nothing to hand over, so it keeps no store either.
 */
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

/** Keep a segment's store on disk across processes; the diff above already read everything it needs. */
export function preserveSegmentStorage(captures: GitTurnDiffCapture[]): void {
  for (const capture of captures) {
    if (capture.status === 'ready' && capture.tempDir) preserveAfterStorage(capture)
  }
}

/**
 * The chain moves one segment forward: the store this segment used as its baseline is released once
 * its own diff is durable, and capture directories no chain owns any more are swept.
 */
export async function releaseSegmentChain(
  sessionRoot: string,
  session: RecorderSessionState,
  frozen: RecorderFrozenDiff[] | undefined,
  continuesChain: boolean
): Promise<string[]> {
  const own = [...new Set((frozen ?? []).map(entry => entry.tempDir))]
  // A continuation extends the chain: every earlier store it can still resolve a blob through stays.
  // A real prompt starts a new chain, which is where the previous one is released — including after a
  // crashed re-finalize, where the chain already names the store this turn is handing over.
  const previous = session.chainStores ?? []
  // A re-finalize after a crash can find the chain already naming this turn's own store: keep it.
  const stale = previous.filter(tempDir => !own.includes(tempDir))
  if (!continuesChain) await releaseFrozenDiffs(stale.map(tempDir => ({ tempDir } as RecorderFrozenDiff)))
  const stores = [...new Set([...(continuesChain ? previous : []), ...own])]
  await pruneSegmentCaptures(sessionRoot, new Set(stores.map(dirname)))
  return stores
}

/**
 * Drop capture directories that no segment chain owns any more: a hidden turn, a quarantined one, or
 * a generation whose store was already released. Only `segment-captures/` is swept.
 */
export async function pruneSegmentCaptures(sessionRoot: string, keep: Set<string>): Promise<void> {
  const root = join(sessionRoot, 'segment-captures')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries
    .filter(entry => entry.isDirectory() && !keep.has(join(root, entry.name)))
    .map(entry => rm(join(root, entry.name), { recursive: true, force: true }).catch(() => undefined)))
}

/** Release a superseded segment chain. The next segment's diff is the only reader. */
export async function releaseFrozenDiffs(frozen: RecorderFrozenDiff[] | undefined): Promise<void> {
  if (!frozen?.length) return
  await Promise.all(frozen.map(entry => rm(entry.tempDir, { recursive: true, force: true })
    // Only the now-empty per-generation parent goes; a sibling repository's store keeps it.
    .then(() => rmdir(dirname(entry.tempDir)).catch(() => undefined))
    .catch(() => undefined)))
}

/**
 * Captures for a continuation segment.
 *
 * The repository set is the one the session already proved it changes (including repositories
 * discovered by changed files), not something rediscovered at the wake: a wake arrives with a tight
 * hook budget and must not scan the workspace. A repository whose frozen end state is missing gets a
 * capture that reports why, instead of a fresh baseline that would attribute the previous segment's
 * work to this one.
 */
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
    // A frozen tree can name blobs from any earlier segment of the chain: a file this segment did not
    // touch keeps the blob it had when the previous store was its baseline. The whole chain stays
    // readable here, and git only writes objects this segment actually changes.
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
