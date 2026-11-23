import {
  type TurnDiffReason,
  type TurnDiffSnapshot,
  type DiffFile,
  type TurnDiffCollection
} from '../../shared/trace.js'
import {
  mkdtemp,
  mkdir,
  rm,
  realpath,
  stat
} from 'node:fs/promises'
import {
  join,
  dirname,
  delimiter,
  resolve,
  relative,
  isAbsolute
} from 'node:path'
import {
  gitCommand,
  TURN_DIFF_BEGIN_DEADLINE_MS,
  snapshotGitArgs,
  GitDeadlineError,
  loadSnapshotOverrides,
  writeSnapshotTree,
  reasonOf
} from './git-command.js'
import {
  tmpdir
} from 'node:os'

import { checkWorkspaceCaptureLimits, WorkspaceReadUnavailable } from './git-workspace-limits.js'
import { sampleGitRepositoryLocation, type GitRepositoryHead, type GitRepositoryLocation } from './git-repository-location.js'

// Match contents of .scry directories at every depth, including the Git root.
export const SCRY_DATA_EXCLUSION = ':(top,exclude,glob)**/.scry/**'

export interface GitTurnDiffCapture {
  beforeAt: string
  captureMs: number
  status: 'ready' | 'unavailable' | 'timeout' | 'failed'
  reason?: TurnDiffReason
  repoRoot?: string
  scope?: string
  requestedRoot?: string
  beforeTree?: string
  repositoryStart?: GitRepositoryLocation
  head?: string
  branch?: string
  baselineClean?: boolean
  indexPath?: string
  indexState?: { mtimeMs: number; ctimeMs: number; size: number; ino: number }
  beforeIndex?: string
  tempDir?: string
  objectDir?: string
  alternateObjectDirs?: string
  filterOverrides?: string[]
  preservedStorage?: boolean
  pathspec?: string[]
  excludedPaths?: string[]
  sharedStorage?: { rootDir: string; objectDir: string; alternateObjectDirs?: string; refs: number }
  finishPromise?: Promise<TurnDiffSnapshot>
  opChain?: Promise<void>
}

export interface GitTurnDiffBaseline {
  commit: string
  at: string
  objectDirs?: string[]
}

export interface GitTurnDiffFinishOptions {
  structuredPaths?: string[]
  forceFull?: boolean
  patchExcludeBasenames?: string[]
  diffExclude?: string[]
  completePatches?: boolean
  workspaceSnapshot?: boolean
  untrackedPatchLimit?: number
  onAfter?: (after: GitAfterTree) => void
}

export async function cloneGitTurnDiffCapture(capture: GitTurnDiffCapture): Promise<GitTurnDiffCapture> {
  if (capture.status !== 'ready') {
    return { ...capture, finishPromise: undefined, opChain: undefined }
  }
  if (!capture.tempDir || !capture.objectDir) throw new Error('ready Git capture is missing isolated storage')

  const started = Date.now()
  const sourceTempDir = capture.tempDir
  const clonedTempDir = await mkdtemp(join(dirname(sourceTempDir), 'scry-turn-diff-clone-'))
  try {
    const clonedObjectDir = join(clonedTempDir, 'objects')
    await mkdir(clonedObjectDir)
    const sharedStorage = capture.sharedStorage ?? {
      rootDir: sourceTempDir,
      objectDir: capture.objectDir,
      alternateObjectDirs: capture.alternateObjectDirs,
      refs: 1
    }
    capture.sharedStorage = sharedStorage
    sharedStorage.refs += 1
    const clonedHooksPath = `core.hooksPath=${join(clonedTempDir, 'hooks-disabled')}`
    return {
      ...capture,
      captureMs: capture.captureMs + (Date.now() - started),
      tempDir: clonedTempDir,
      objectDir: clonedObjectDir,
      alternateObjectDirs: [sharedStorage.objectDir, sharedStorage.alternateObjectDirs]
        .filter((value): value is string => !!value)
        .join(delimiter),
      filterOverrides: capture.filterOverrides?.map((value) => value.startsWith('core.hooksPath=') ? clonedHooksPath : value),
      sharedStorage,
      finishPromise: undefined,
      opChain: undefined
    }
  } catch (error) {
    await rm(clonedTempDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export function capturePathspec(repoRoot: string, scope: string, excludedPaths: string[]): string[] {
  const scopeRoot = scope === '.' ? repoRoot : resolve(repoRoot, scope)
  const exclusions = excludedPaths.flatMap((path) => {
    const absolute = resolve(path)
    const fromScope = relative(scopeRoot, absolute)
    if (fromScope.startsWith('..') || isAbsolute(fromScope)) return []
    const fromRoot = relative(repoRoot, absolute).split('\\').join('/')
    return fromRoot && !fromRoot.startsWith('..') ? [`:(top,exclude,literal)${fromRoot}`] : []
  })
  const literalScope = scope === '.' ? '.' : `:(top,literal)${scope.split('\\').join('/')}`
  return [literalScope, ...new Set(exclusions)]
}

async function ignoredByGit(cwd: string, path: string, deadline: number): Promise<boolean> {
  try {
    await gitCommand(['check-ignore', '-q', '--', path], { cwd, deadline })
    return true
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false
    throw error
  }
}

export function terminalSnapshot(
  capture: GitTurnDiffCapture,
  status: TurnDiffSnapshot['status'],
  reason: TurnDiffReason | undefined,
  files: DiffFile[],
  afterAt: string,
  finishMs: number,
  cleanup: TurnDiffSnapshot['cleanup'],
  collection?: TurnDiffCollection
): TurnDiffSnapshot {
  return {
    version: 1,
    status,
    ...(reason ? { reason } : {}),
    files,
    ...(capture.repoRoot ? { repoRoot: capture.repoRoot } : {}),
    ...(capture.scope != null ? { scope: capture.scope } : {}),
    beforeAt: capture.beforeAt,
    afterAt,
    captureMs: capture.captureMs + finishMs,
    cleanup,
    ...(collection ? { collection } : {})
  }
}

export { cleanupCapture, preserveAfterStorage, resumeAfterStorage, retainAfterStorage } from './git-capture-storage.js'

export async function beginGitTurnDiff(
  cwd: string,
  deadlineMs = TURN_DIFF_BEGIN_DEADLINE_MS,
  captureRoot?: string,
  excludedPaths: string[] = [],
  workspaceSnapshot = false,
  baseline?: GitTurnDiffBaseline,
  options: { excludeScryData?: true } = {}
): Promise<GitTurnDiffCapture> {
  const started = Date.now()
  const beforeAt = new Date(started).toISOString()
  const deadline = started + deadlineMs
  const requestedRoot = resolve(cwd)
  let tempDir: string | undefined
  try {
    const canonicalCwd = await realpath(cwd)
    const readEnv = workspaceSnapshot ? { ...process.env, GIT_NO_LAZY_FETCH: '1' } : undefined
    // The recursive glob also matches the root .scry directory's contents.
    // Git add treats a literal excluded ignored directory as an explicit path.
    const dataPathspec = options.excludeScryData ? [SCRY_DATA_EXCLUSION] : []
    const cwdLocation = workspaceSnapshot ? undefined : sampleGitRepositoryLocation(canonicalCwd, true)
    const [layoutResult, statusResult] = await Promise.allSettled([
      gitCommand(
        [
          'rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir',
          '--git-path', 'index', '--git-path', 'info/sparse-checkout'
        ],
        { cwd: canonicalCwd, env: readEnv, deadline }
      ),
      gitCommand(snapshotGitArgs([], ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.', ...dataPathspec]), {
        cwd: canonicalCwd,
        env: readEnv,
        deadline
      })
    ])
    if (layoutResult.status === 'rejected') {
      if (layoutResult.reason instanceof GitDeadlineError) throw layoutResult.reason
      return { beforeAt, captureMs: Date.now() - started, status: 'unavailable', reason: 'not_git' }
    }
    const [inside, repoRoot, commonDirRaw, indexPathRaw, sparsePathRaw] = layoutResult.value
      .split('\n').map((line) => line.trim())
    if (inside !== 'true' || !repoRoot || !commonDirRaw || !indexPathRaw || !sparsePathRaw) {
      return { beforeAt, captureMs: Date.now() - started, status: 'unavailable', reason: 'not_git' }
    }
    const location = repoRoot === canonicalCwd ? cwdLocation
      : workspaceSnapshot ? undefined : sampleGitRepositoryLocation(repoRoot, true)
    if (statusResult.status === 'rejected') throw statusResult.reason
    const statusRecords = statusResult.value.split('\0').filter(Boolean)
    const headRecord = statusRecords.find((record) => record.startsWith('# branch.oid '))
    const head = headRecord?.slice('# branch.oid '.length).trim() ?? ''
    if (!head || head === '(initial)') {
      return { beforeAt, captureMs: Date.now() - started, status: 'unavailable', reason: 'no_head',
        repoRoot, requestedRoot, repositoryStart: location?.() }
    }
    const branchName = statusRecords.find(record => record.startsWith('# branch.head '))?.slice('# branch.head '.length)
    const branch = branchName && branchName !== '(detached)' ? branchName : undefined
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(canonicalCwd, commonDirRaw)
    const indexPath = isAbsolute(indexPathRaw) ? indexPathRaw : resolve(canonicalCwd, indexPathRaw)
    const scope = relative(repoRoot, canonicalCwd) || '.'
    if (scope.startsWith('..')) throw new Error('Selected cwd is outside the Git worktree')
    const canonicalExcludedPaths = await Promise.all(excludedPaths.map(async (path) => {
      try {
        return await realpath(path)
      } catch {
        return resolve(path)
      }
    }))
    const explicitExcludedPaths = (await Promise.all(canonicalExcludedPaths.map(async (path) => {
      const fromRepo = relative(repoRoot, path)
      if (fromRepo.startsWith('..') || isAbsolute(fromRepo)) return undefined
      return await ignoredByGit(repoRoot, path, deadline) ? undefined : path
    }))).filter((path): path is string => path != null)
    const pathspec = [...capturePathspec(repoRoot, scope, explicitExcludedPaths), ...dataPathspec]
    const snapshotExcludedPaths = options.excludeScryData
      ? [...canonicalExcludedPaths, join(canonicalCwd, '.scry')]
      : canonicalExcludedPaths
    if (workspaceSnapshot) await checkWorkspaceCaptureLimits({
      repoRoot, cwd: canonicalCwd, head, records: statusRecords, pathspec,
      excludedPaths: snapshotExcludedPaths, deadline
    })
    const baselineClean = explicitExcludedPaths.length === 0
      ? statusRecords.every((record) => record.startsWith('# '))
      : !(await gitCommand(
          snapshotGitArgs([], ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspec]),
          { cwd: repoRoot, deadline }
        ))
    if (captureRoot) await mkdir(captureRoot, { recursive: true, mode: 0o700 })
    tempDir = await mkdtemp(join(captureRoot ?? tmpdir(), 'scry-turn-diff-'))
    const objectDir = join(tempDir, 'objects')
    await mkdir(objectDir)
    const alternateObjectDirs = [...new Set([
      join(commonDir, 'objects'),
      ...(baseline?.objectDirs ?? []),
      ...(process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES ? process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES.split(delimiter) : [])
    ].filter((value): value is string => !!value))].join(delimiter)
    const sparsePath = isAbsolute(sparsePathRaw) ? sparsePathRaw : resolve(canonicalCwd, sparsePathRaw)
    if (baseline) {
      const baselineTree = (await gitCommand(
        ['rev-parse', '--verify', '--end-of-options', `${baseline.commit}^{tree}`],
        {
          cwd: repoRoot,
          env: baseline.objectDirs?.length ? { ...readEnv, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirs } : readEnv,
          deadline
        }
      )).trim()
      return {
        beforeAt: baseline.at,
        captureMs: Date.now() - started,
        status: 'ready',
        repoRoot,
        scope,
        requestedRoot,
        beforeTree: baselineTree,
        head: baseline.commit,
        branch,
        repositoryStart: location?.(),
        baselineClean: false,
        indexPath,
        tempDir,
        objectDir,
        alternateObjectDirs,
        pathspec,
        excludedPaths: snapshotExcludedPaths
      }
    }
    const [indexState, sparseCheckout] = await Promise.all([
      stat(indexPath).then(
        (value) => ({ mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, size: value.size, ino: value.ino }),
        () => undefined
      ),
      stat(sparsePath).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT')
    ])
    if (baselineClean) {
      return {
        beforeAt,
        captureMs: Date.now() - started,
        status: 'ready',
        repoRoot,
        scope,
        requestedRoot,
        beforeTree: head,
        head,
        branch,
        repositoryStart: location?.(),
        baselineClean,
        indexPath,
        ...(indexState && !sparseCheckout ? { indexState } : {}),
        tempDir,
        objectDir,
        alternateObjectDirs,
        pathspec,
        excludedPaths: snapshotExcludedPaths
      }
    }
    const filterOverrides = await loadSnapshotOverrides(canonicalCwd, tempDir, deadline)
    const beforeIndex = join(tempDir, 'before.index')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...readEnv,
      GIT_INDEX_FILE: beforeIndex,
      GIT_OBJECT_DIRECTORY: objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirs
    }
    const beforeTree = await writeSnapshotTree({
      cwd: repoRoot,
      pathspec,
      env,
      deadline,
      filterOverrides,
      sourceIndex: indexPath,
      targetIndex: beforeIndex
    })
    return {
      beforeAt,
      captureMs: Date.now() - started,
      status: 'ready',
      repoRoot,
      scope,
      requestedRoot,
      beforeTree,
      head,
      branch,
      repositoryStart: location?.(),
      baselineClean,
      indexPath,
      ...(sparseCheckout ? {} : { beforeIndex }),
      tempDir,
      objectDir,
      alternateObjectDirs,
      filterOverrides,
      pathspec,
      excludedPaths: snapshotExcludedPaths
    }
  } catch (error) {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof WorkspaceReadUnavailable) throw error
    const reason = reasonOf(error)
    return {
      beforeAt,
      captureMs: Date.now() - started,
      status: reason === 'deadline' ? 'timeout' : 'failed',
      reason
    }
  }
}

export interface GitAfterTree {
  repositoryEnd?: GitRepositoryHead
  tree: string
  afterAt: string
  indexFile: string
  objectDir: string
  alternateObjectDirs?: string
  filterOverrides: string[]
  collection?: TurnDiffCollection
}

export function serializeCaptureOp<T>(capture: GitTurnDiffCapture, task: () => Promise<T>): Promise<T> {
  const queued = (capture.opChain ?? Promise.resolve()).then(task, task)
  capture.opChain = queued.then(() => undefined, () => undefined)
  return queued
}
