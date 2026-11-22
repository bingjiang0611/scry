import {
  resolve,
  isAbsolute,
  relative,
  join,
  delimiter
} from 'node:path'
import {
  type GitTurnDiffCapture,
  type GitTurnDiffFinishOptions,
  type GitAfterTree,
  terminalSnapshot,
  cleanupCapture
} from './git-capture.js'
import {
  rm,
  stat
} from 'node:fs/promises'
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

export function parsePorcelainPaths(stdout: string, repoRoot: string): string[] {
  const records = stdout.split('\0')
  const paths = new Set<string>()
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (path) paths.add(resolve(repoRoot, path))
    if (/[RC]/.test(status)) {
      const original = records[++index]
      if (original) paths.add(resolve(repoRoot, original))
    }
  }
  return [...paths]
}

function targetedPathspec(capture: GitTurnDiffCapture, paths: string[]): string[] {
  if (!capture.repoRoot || !capture.scope) return []
  const scopeRoot = capture.scope === '.' ? capture.repoRoot : resolve(capture.repoRoot, capture.scope)
  const exclusions = capture.excludedPaths ?? []
  const out = new Set<string>()
  for (const candidate of paths) {
    let absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(scopeRoot, candidate)
    if (capture.requestedRoot) {
      const fromRequested = relative(capture.requestedRoot, absolute)
      if (!fromRequested.startsWith('..') && !isAbsolute(fromRequested)) absolute = resolve(scopeRoot, fromRequested)
    }
    const fromScope = relative(scopeRoot, absolute)
    if (fromScope.startsWith('..') || isAbsolute(fromScope)) continue
    if (exclusions.some((excluded) => {
      const fromExcluded = relative(excluded, absolute)
      return fromExcluded === '' || (!fromExcluded.startsWith('..') && !isAbsolute(fromExcluded))
    })) continue
    const fromRoot = relative(capture.repoRoot, absolute).split('\\').join('/')
    if (fromRoot && !fromRoot.startsWith('..')) out.add(`:(top,literal)${fromRoot}`)
  }
  return [...out]
}

function changesGitSemantics(pathspec: string[]): boolean {
  return pathspec.some((path) =>
    /(?:^|\/)(?:\.gitignore|\.gitattributes|\.gitmodules)$/.test(path.replace(/^:\(top,literal\)/, ''))
  )
}

async function writeTargetedSnapshotTree(options: {
  cwd: string
  baseTree: string
  pathspec: string[]
  env: NodeJS.ProcessEnv
  deadline: number
  filterOverrides: string[]
  targetIndex: string
  sourceIndex?: string
}): Promise<string> {
  const { cwd, baseTree, pathspec, env, deadline, filterOverrides, targetIndex, sourceIndex } = options
  await rm(targetIndex, { force: true })
  await rm(`${targetIndex}.lock`, { force: true })
  if (sourceIndex) await copyIndexWithTimestamps(sourceIndex, targetIndex)
  else await gitCommand(snapshotGitArgs(filterOverrides, ['read-tree', baseTree]), { cwd, env, deadline })
  await gitCommand(snapshotGitArgs(filterOverrides, ['add', '-A', '--', ...pathspec]), { cwd, env, deadline })
  return (await gitCommand(snapshotGitArgs(filterOverrides, ['write-tree']), { cwd, env, deadline })).trim()
}

async function unchangedIndexPath(capture: GitTurnDiffCapture): Promise<string | undefined> {
  const { indexPath, indexState } = capture
  if (!capture.baselineClean || !indexPath || !indexState) return undefined
  const now = await stat(indexPath).catch(() => undefined)
  if (!now) return undefined
  const same = now.mtimeMs === indexState.mtimeMs && now.ctimeMs === indexState.ctimeMs &&
    now.size === indexState.size && now.ino === indexState.ino
  return same ? indexPath : undefined
}

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
  if (!sharedAfter && capture.status === 'ready' && capture.beforeTree && capture.tempDir && capture.objectDir) {
    const unchanged = await unchangedSinceCleanBaseline(capture, options, started + deadlineMs)
    if (unchanged) {
      if (onAfter) {
        onAfter({
          tree: capture.beforeTree,
          afterAt,
          indexFile: join(capture.tempDir, 'after.index'),
          objectDir: capture.objectDir,
          ...(capture.alternateObjectDirs ? { alternateObjectDirs: capture.alternateObjectDirs } : {}),
          filterOverrides: [],
          collection: unchanged
        })
      }
      return terminalSnapshot(
        capture,
        'captured',
        undefined,
        [],
        afterAt,
        Date.now() - started,
        consume ? await cleanupCapture(capture) : 'ok',
        unchanged
      )
    }
  }
  if (capture.status !== 'ready' || !capture.repoRoot || !capture.scope || !capture.beforeTree || !capture.tempDir || !capture.objectDir) {
    return terminalSnapshot(
      capture,
      capture.status === 'ready' ? 'failed' : capture.status,
      capture.reason ?? (capture.status === 'ready' ? 'git_error' : undefined),
      [],
      afterAt,
      0,
      consume ? await cleanupCapture(capture) : 'ok'
    )
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
              pathspec: targetPathspec,
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
      tree: afterTree, afterAt, indexFile: env.GIT_INDEX_FILE!, objectDir: capture.objectDir,
      alternateObjectDirs: capture.alternateObjectDirs, filterOverrides, collection
    })

    if (capture.beforeTree === afterTree) {
      return terminalSnapshot(
        capture, 'captured', undefined, [], afterAt, Date.now() - started,
        consume ? await cleanupCapture(capture) : 'ok', collection
      )
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
  const snapshot = terminalSnapshot(capture, status, reason, files, afterAt, finishMs, cleanup, collection)
  return exclusion ? { ...snapshot, diffExclude: exclusion } : snapshot
}
