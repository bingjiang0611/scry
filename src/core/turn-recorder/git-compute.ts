import {
  resolve,
  join,
  delimiter
} from 'node:path'
import {
  type GitTurnDiffCapture,
  type GitTurnDiffFinishOptions,
  type GitAfterTree,
  SCRY_DATA_EXCLUSION,
  terminalSnapshot,
  cleanupCapture
} from './git-capture.js'
import { readTurnRepositoryRemote, REPOSITORY_REMOTE_RETRY, sampleGitRepositoryLocation, withRepositoryLocation } from './git-repository-location.js'
import { rm } from 'node:fs/promises'
import {
  gitCommand,
  snapshotGitArgs,
  loadSnapshotOverrides,
  TURN_DIFF_TARGETED_DEADLINE_MS,
  copyIndexWithTimestamps,
  TURN_DIFF_CANDIDATE_LIMIT,
  writeSnapshotTree,
  reasonOf
} from './git-command.js'
import {
  type TurnDiffSnapshot,
  type TurnDiffReason,
  type DiffFile,
  type TurnDiffCollection,
  type TurnDiffFallbackReason
} from '../../shared/trace.js'
import {
  captureTurnPatches,
  parseRawNumstat
} from './git-patches.js'
import { applyTurnDiffFilePolicy } from './git-turn-diff-policy.js'
import type { TurnDiffExcludeEvidence } from '../../shared/turn-diff.js'

import { WORKSPACE_FILE_LIMIT, WORKSPACE_PATCH_BYTES, WorkspaceReadUnavailable } from './git-workspace-limits.js'

import {
  changesGitSemantics,
  parsePorcelainPaths,
  targetedPathspec,
  unchangedIndexPath,
  writeTargetedSnapshotTree
} from './git-targeted-snapshot.js'

export { parsePorcelainPaths } from './git-targeted-snapshot.js'

async function untrackedPaths(
  capture: GitTurnDiffCapture,
  filterOverrides: string[],
  pathspec: string[],
  env: NodeJS.ProcessEnv,
  deadline: number
): Promise<Set<string>> {
  const realEnv = { ...env }
  if (capture.indexPath) realEnv.GIT_INDEX_FILE = capture.indexPath
  else delete realEnv.GIT_INDEX_FILE
  try {
    const out = await gitCommand(
      snapshotGitArgs(filterOverrides, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspec]),
      { cwd: capture.repoRoot!, env: realEnv, deadline }
    )
    return new Set(out.split('\0').filter(Boolean).map((path) => resolve(capture.repoRoot!, path)))
  } catch {
    return new Set()
  }
}

async function unchangedSinceCleanBaseline(
  capture: GitTurnDiffCapture,
  options: GitTurnDiffFinishOptions,
  deadline: number
): Promise<TurnDiffCollection | undefined> {
  if (options.forceFull === true) return undefined
  if (process.env.SCRY_TURN_DIFF_STRATEGY?.trim().toLowerCase() === 'full') return undefined
  if (!capture.baselineClean || !capture.repoRoot || !capture.head) return undefined
  if (targetedPathspec(capture, options.structuredPaths ?? []).length > 0) return undefined
  const started = Date.now()
  try {
    const stdout = await gitCommand(
      snapshotGitArgs([], ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--',
        ...(capture.pathspec ?? [capture.scope ?? '.'])]),
      { cwd: capture.repoRoot, deadline }
    )
    const records = stdout.split('\0').filter(Boolean)
    const head = records.find((record) => record.startsWith('# branch.oid '))?.slice('# branch.oid '.length).trim()
    if (!head || head !== capture.head) return undefined
    if (records.some((record) => !record.startsWith('# '))) return undefined
    if (await anyAssumeUnchanged(capture, deadline)) return undefined
    return { strategy: 'unchanged', evidence: 'git_status', candidatePathCount: 0, discoveryMs: Date.now() - started }
  } catch {
    return undefined
  }
}

async function anyAssumeUnchanged(capture: GitTurnDiffCapture, deadline: number): Promise<boolean> {
  try {
    const stdout = await gitCommand(
      snapshotGitArgs([], ['ls-files', '-v', '-z', '--', ...(capture.pathspec ?? [capture.scope ?? '.'])]),
      { cwd: capture.repoRoot!, deadline }
    )
    return stdout.split('\0').some((record) => /^[a-z] /.test(record))
  } catch {
    return true
  }
}

export async function computeGitTurnDiff(
  capture: GitTurnDiffCapture,
  deadlineMs: number,
  options: GitTurnDiffFinishOptions,
  consume: boolean,
  sharedAfter?: GitAfterTree,
  onAfter?: (after: GitAfterTree) => void
): Promise<TurnDiffSnapshot> {
  const started = Date.now()
  let afterAt = new Date(started).toISOString()
  const location = !sharedAfter && !options.workspaceSnapshot && capture.repoRoot
    ? sampleGitRepositoryLocation(capture.repoRoot, false) : undefined
  let repositoryEnd = sharedAfter?.repositoryEnd
  const readEnd = () => {
    if (repositoryEnd) return repositoryEnd
    const observed = location?.()
    if (observed?.branch !== undefined || observed?.commit !== undefined) repositoryEnd = observed
    return repositoryEnd
  }
  // Start HEAD and branch head come from this capture's own `status` read, so an incomplete 50 ms
  // location sample no longer costs `commitBefore` or `branch`.
  const start = { ...(capture.turnStartHead ? { head: capture.turnStartHead } : {}), ...(capture.branchHead ? { branchHead: capture.branchHead } : {}) }
  const located = (snapshot: TurnDiffSnapshot, before = capture.repositoryStart): TurnDiffSnapshot =>
    withRepositoryLocation(snapshot, before, readEnd(), start)
  if (!sharedAfter && capture.status === 'ready' && capture.beforeTree && capture.tempDir && capture.objectDir) {
    const unchanged = await unchangedSinceCleanBaseline(capture, options, started + deadlineMs)
    if (unchanged) {
      if (onAfter) {
        onAfter({
          tree: capture.beforeTree,
          repositoryEnd: readEnd(),
          afterAt,
          indexFile: join(capture.tempDir, 'after.index'),
          objectDir: capture.objectDir,
          ...(capture.alternateObjectDirs ? { alternateObjectDirs: capture.alternateObjectDirs } : {}),
          filterOverrides: [],
          collection: unchanged
        })
      }
      return located(terminalSnapshot(
        capture,
        'captured',
        undefined,
        [],
        afterAt,
        Date.now() - started,
        consume ? await cleanupCapture(capture) : 'ok',
        unchanged
      ))
    }
  }
  if (capture.status !== 'ready' || !capture.repoRoot || !capture.scope || !capture.beforeTree || !capture.tempDir || !capture.objectDir) {
    return located(terminalSnapshot(
      capture,
      capture.status === 'ready' ? 'failed' : capture.status,
      capture.reason ?? (capture.status === 'ready' ? 'git_error' : undefined),
      [],
      afterAt,
      0,
      consume ? await cleanupCapture(capture) : 'ok'
    ))
  }
  const deadline = started + deadlineMs
  let status: TurnDiffSnapshot['status'] = 'captured'
  let reason: TurnDiffReason | undefined
  let files: DiffFile[] = []
  let collection: TurnDiffCollection | undefined
  let exclusion: TurnDiffExcludeEvidence | undefined
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options.workspaceSnapshot ? { GIT_NO_LAZY_FETCH: '1' } : {}),
      GIT_INDEX_FILE: join(capture.tempDir, 'after.index'),
      GIT_OBJECT_DIRECTORY: capture.objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: capture.alternateObjectDirs
    }
    const fullPathspec = capture.pathspec ?? [capture.scope]
    let afterTree: string | undefined
    let filterOverrides: string[]
    if (sharedAfter) {
      afterAt = sharedAfter.afterAt
      afterTree = sharedAfter.tree
      filterOverrides = sharedAfter.filterOverrides
      collection = sharedAfter.collection ? { ...sharedAfter.collection, sharedAfter: 'turn' } : undefined
      env.GIT_INDEX_FILE = sharedAfter.indexFile
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = [...new Set([
        sharedAfter.objectDir,
        sharedAfter.alternateObjectDirs,
        capture.alternateObjectDirs
      ].flatMap(value => value?.split(delimiter) ?? []).filter(value => value && value !== capture.objectDir))].join(delimiter)
    } else {
      filterOverrides = await loadSnapshotOverrides(capture.repoRoot, capture.tempDir, deadline)
      capture.filterOverrides = filterOverrides
      const afterIndex = join(capture.tempDir, 'after.index')
      const forceFull =
        options.forceFull === true ||
        process.env.SCRY_TURN_DIFF_STRATEGY?.trim().toLowerCase() === 'full'
      const preFallbackBudget = Math.min(TURN_DIFF_TARGETED_DEADLINE_MS, Math.max(500, Math.floor(deadlineMs / 4)))
      const preFallbackDeadline = Math.min(deadline, started + preFallbackBudget)
      let discoveryMs = 0
      let targetedMs: number | undefined
      let fallbackMs: number | undefined
      let fallbackReason: TurnDiffFallbackReason | undefined = forceFull ? 'forced' : undefined
      let candidates = [...(options.structuredPaths ?? [])]
      let targetPathspec: string[] = []
      let discoveryIndex: string | undefined
      let discoveryBaseIsBeforeTree = false
      const hasStructuredEvidence = targetedPathspec(capture, options.structuredPaths ?? []).length > 0

      if (!fallbackReason) {
        const discoveryStarted = Date.now()
        try {
          const discoveryDeadline = Math.min(
            preFallbackDeadline,
            discoveryStarted + Math.max(250, Math.floor(preFallbackBudget / 2))
          )
          discoveryIndex = join(capture.tempDir, 'discovery.index')
          const discoveryEnv: NodeJS.ProcessEnv = { ...env, GIT_INDEX_FILE: discoveryIndex }
          await rm(discoveryIndex, { force: true })
          await rm(`${discoveryIndex}.lock`, { force: true })
          const reusableBase = capture.beforeIndex ?? await unchangedIndexPath(capture)
          let copiedBase = false
          if (reusableBase) {
            copiedBase = await copyIndexWithTimestamps(reusableBase, discoveryIndex).then(() => true, () => false)
          }
          discoveryBaseIsBeforeTree = copiedBase
          if (!copiedBase) {
            const discoverySource = capture.baselineClean
              ? capture.indexPath ?? join(capture.tempDir, 'missing.index')
              : join(capture.tempDir, 'before.index')
            await copyIndexWithTimestamps(discoverySource, discoveryIndex).catch(() => undefined)
            await gitCommand(snapshotGitArgs(filterOverrides, ['read-tree', '--reset', capture.beforeTree]), {
              cwd: capture.repoRoot,
              env: discoveryEnv,
              deadline: discoveryDeadline
            })
          }
          await gitCommand(snapshotGitArgs(filterOverrides, ['update-index', '--really-refresh']), {
            cwd: capture.repoRoot,
            env: discoveryEnv,
            deadline: discoveryDeadline,
            allowExitOne: true
          })
          const porcelain = await gitCommand(
            snapshotGitArgs(filterOverrides, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...fullPathspec]),
            { cwd: capture.repoRoot, env: discoveryEnv, deadline: discoveryDeadline }
          )
          candidates = [...new Set([...candidates, ...parsePorcelainPaths(porcelain, capture.repoRoot)])]
        } catch {
          fallbackReason = 'discovery_failed'
        } finally {
          discoveryMs = Date.now() - discoveryStarted
        }
      }

      if (!fallbackReason) {
        targetPathspec = targetedPathspec(capture, candidates)
        if (targetPathspec.length > TURN_DIFF_CANDIDATE_LIMIT) fallbackReason = 'candidate_limit'
        else if (changesGitSemantics(targetPathspec)) fallbackReason = 'git_semantics'
      }

      if (!fallbackReason) {
        const targetedStarted = Date.now()
        try {
          if (targetPathspec.length === 0) {
            afterTree = capture.beforeTree
            env.GIT_INDEX_FILE = discoveryIndex!
          } else {
            afterTree = await writeTargetedSnapshotTree({
              cwd: capture.repoRoot,
              baseTree: capture.beforeTree,
              pathspec: fullPathspec.includes(SCRY_DATA_EXCLUSION)
                ? [...targetPathspec, SCRY_DATA_EXCLUSION]
                : targetPathspec,
              env,
              deadline: preFallbackDeadline,
              filterOverrides,
              targetIndex: afterIndex,
              ...(discoveryBaseIsBeforeTree && discoveryIndex ? { sourceIndex: discoveryIndex } : {})
            })
          }
        } catch {
          fallbackReason = 'targeted_failed'
        } finally {
          targetedMs = Date.now() - targetedStarted
        }
      }

      if (fallbackReason) {
        const fallbackStarted = Date.now()
        try {
          await rm(afterIndex, { force: true })
          await rm(`${afterIndex}.lock`, { force: true })
          afterTree = await writeSnapshotTree({
            cwd: capture.repoRoot,
            pathspec: fullPathspec,
            env,
            deadline,
            filterOverrides,
            sourceIndex: capture.baselineClean
              ? capture.indexPath ?? join(capture.tempDir, 'missing.index')
              : join(capture.tempDir, 'before.index'),
            targetIndex: afterIndex
          })
        } finally {
          fallbackMs = Date.now() - fallbackStarted
          collection = {
            strategy: 'full_fallback',
            evidence: 'fallback',
            candidatePathCount: targetPathspec.length,
            discoveryMs,
            ...(targetedMs != null ? { targetedMs } : {}),
            fallbackMs,
            fallbackReason
          }
        }
      } else {
        collection = {
          strategy: 'targeted',
          evidence: hasStructuredEvidence ? 'git_status+structured' : 'git_status',
          candidatePathCount: targetPathspec.length,
          discoveryMs,
          ...(targetedMs != null ? { targetedMs } : {})
        }
      }
    }
    if (!afterTree) throw new Error('Git after tree was not created')
    if (!sharedAfter) onAfter?.({
      tree: afterTree, repositoryEnd: readEnd(), afterAt, indexFile: env.GIT_INDEX_FILE!, objectDir: capture.objectDir,
      alternateObjectDirs: capture.alternateObjectDirs, filterOverrides, collection
    })

    if (capture.beforeTree === afterTree) {
      return located(terminalSnapshot(
        capture, 'captured', undefined, [], afterAt, Date.now() - started,
        consume ? await cleanupCapture(capture) : 'ok', collection
      ))
    }

    const numstat = await gitCommand(
      snapshotGitArgs(filterOverrides, [
        'diff',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--raw',
        '--numstat',
        '-z',
        capture.beforeTree,
        afterTree,
        '--',
        ...fullPathspec
      ]),
      { cwd: capture.repoRoot, env, deadline }
    )
    files = parseRawNumstat(numstat, capture.repoRoot)
    if (options.workspaceSnapshot && files.length > WORKSPACE_FILE_LIMIT) {
      throw new WorkspaceReadUnavailable('workspace_limit')
    }
    const untracked = files.some((file) => file.change === 'added') && !options.workspaceSnapshot
      ? await untrackedPaths(capture, filterOverrides, fullPathspec, env, deadline)
      : undefined
    const policy = applyTurnDiffFilePolicy({
      files,
      repoRoot: capture.repoRoot,
      diffExclude: options.diffExclude ?? [],
      untracked,
      untrackedLimit: options.untrackedPatchLimit
    })
    files = policy.files
    exclusion = policy.excluded.files > 0 ? policy.excluded : undefined
    files = await captureTurnPatches(
      capture,
      env,
      afterTree,
      files,
      new Set(options.patchExcludeBasenames ?? []),
      deadline,
      options.completePatches === true,
      options.workspaceSnapshot ? WORKSPACE_PATCH_BYTES : undefined,
      options.workspaceSnapshot ? 20 : 3
    )
  } catch (error) {
    if (error instanceof WorkspaceReadUnavailable) {
      if (consume) await cleanupCapture(capture)
      throw error
    }
    reason = reasonOf(error)
    status = reason === 'deadline' ? 'timeout' : 'failed'
  }
  const finishMs = Date.now() - started
  const cleanup = consume ? await cleanupCapture(capture) : 'ok'
  // Only a repository this turn actually changed earns a second read, and only for the origin the
  // start sample may have lost. Its own pool and the turn ceiling keep the host's Stop hook bounded.
  // A start read that named the origin, or proved there is none, is already an answer: only a read
  // that did not finish earns the second attempt.
  const startRemoteStatus = capture.repositoryStart?.remoteStatus
  const startProvedRemote = !!capture.repositoryStart?.remote || startRemoteStatus === 'absent' || startRemoteStatus === 'unsupported'
  const retryRemote = consume && files.length > 0 && !startProvedRemote && capture.repoRoot
    ? await readTurnRepositoryRemote(capture.repoRoot, options.locationRetryDeadline ?? Date.now() + REPOSITORY_REMOTE_RETRY.turnMs)
    : undefined
  const snapshot = located(
    terminalSnapshot(capture, status, reason, files, afterAt, finishMs, cleanup, collection),
    retryRemote ? { ...capture.repositoryStart, ...retryRemote } : capture.repositoryStart
  )
  return exclusion ? { ...snapshot, diffExclude: exclusion } : snapshot
}
