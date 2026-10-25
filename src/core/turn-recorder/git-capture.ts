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
  realpath
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

export interface GitTurnDiffCapture {
  beforeAt: string
  captureMs: number
  status: 'ready' | 'unavailable' | 'timeout' | 'failed'
  reason?: TurnDiffReason
  repoRoot?: string
  scope?: string
  requestedRoot?: string
  beforeTree?: string
  /** HEAD observed by the same layout/status read that starts this capture. */
  head?: string
  branch?: string
  baselineClean?: boolean
  indexPath?: string
  tempDir?: string
  objectDir?: string
  alternateObjectDirs?: string
  filterOverrides?: string[]
  pathspec?: string[]
  excludedPaths?: string[]
  /** clone 之间共享的只读 baseline object store；引用归零后才删除 owner 根目录。 */
  sharedStorage?: { rootDir: string; objectDir: string; alternateObjectDirs?: string; refs: number }
  finishPromise?: Promise<TurnDiffSnapshot>
  /**
   * 同一个 capture 上所有重算的串行链。运行中预览与终态都用 capture.tempDir 下同名的
   * after.index / discovery.index，并发会互相踩锁；一律排队执行。
   */
  opChain?: Promise<void>
}

export interface GitTurnDiffFinishOptions {
  structuredPaths?: string[]
  forceFull?: boolean
  patchExcludeBasenames?: string[]
  /** Recorder-only capture: retain complete patches before producing bounded inline previews. */
  completePatches?: boolean
  /** Bounded, read-only workspace inspector; not the recorder retention policy. */
  workspaceSnapshot?: boolean
}

/**
 * 复制一个已经完成的启动快照，生成清理与操作队列完全独立的 capture。
 *
 * 新会话首轮的 turn baseline 与 session baseline 描述的是同一个时刻；重新扫描工作树既浪费
 * 启动时间，也可能因外部写入得到两个不同锚点。clone 只新建独立 scratch/index/object 目录，
 * 并通过 alternates 只读原 baseline object store；引用计数保证 turn 清理不会破坏跨轮基线。
 */
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

const retainedCaptureStorage = new WeakMap<GitTurnDiffCapture, () => Promise<TurnDiffSnapshot['cleanup']>>()

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

export async function beginGitTurnDiff(
  cwd: string,
  deadlineMs = TURN_DIFF_BEGIN_DEADLINE_MS,
  captureRoot?: string,
  excludedPaths: string[] = [],
  workspaceSnapshot = false
): Promise<GitTurnDiffCapture> {
  const started = Date.now()
  const beforeAt = new Date(started).toISOString()
  const deadline = started + deadlineMs
  const requestedRoot = resolve(cwd)
  let tempDir: string | undefined
  try {
    const canonicalCwd = await realpath(cwd)
    const readEnv = workspaceSnapshot ? { ...process.env, GIT_NO_LAZY_FETCH: '1' } : undefined
    // Layout 与 status 都只读同一仓库且彼此无依赖，并行启动。porcelain v2 的 branch.oid
    // 同时给出 HEAD；没有显式排除路径时，它还直接给出 baselineClean。这样常见路径只需
    // 一轮并行 Git 进程，不再串行执行 HEAD 与 status 两轮探测。
    const [layoutResult, statusResult] = await Promise.allSettled([
      gitCommand(
        ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir', '--git-path', 'index'],
        { cwd: canonicalCwd, env: readEnv, deadline }
      ),
      gitCommand(snapshotGitArgs([], ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.']), {
        cwd: canonicalCwd,
        env: readEnv,
        deadline
      })
    ])
    if (layoutResult.status === 'rejected') {
      // Bare repositories exit 128 on `--show-toplevel`, and non-repositories exit 128 immediately;
      // both meant `not_git` when the work-tree probe was a separate call.
      if (layoutResult.reason instanceof GitDeadlineError) throw layoutResult.reason
      return { beforeAt, captureMs: Date.now() - started, status: 'unavailable', reason: 'not_git' }
    }
    const [inside, repoRoot, commonDirRaw, indexPathRaw] = layoutResult.value
      .split('\n').map((line) => line.trim())
    if (inside !== 'true' || !repoRoot || !commonDirRaw || !indexPathRaw) {
      return { beforeAt, captureMs: Date.now() - started, status: 'unavailable', reason: 'not_git' }
    }
    if (statusResult.status === 'rejected') throw statusResult.reason
    const statusRecords = statusResult.value.split('\0').filter(Boolean)
    const headRecord = statusRecords.find((record) => record.startsWith('# branch.oid '))
    const head = headRecord?.slice('# branch.oid '.length).trim() ?? ''
    if (!head || head === '(initial)') {
      return { beforeAt, captureMs: Date.now() - started, status: 'unavailable', reason: 'no_head' }
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
    // `git add -- . :(exclude)<path>` exits 1 when <path> is already ignored,
    // even though the positive pathspec alone would naturally skip it. Keep an
    // explicit exclusion only for visible/tracked paths; ignored dataDir paths
    // are already absent from the temporary snapshot index.
    const explicitExcludedPaths = (await Promise.all(canonicalExcludedPaths.map(async (path) => {
      const fromRepo = relative(repoRoot, path)
      if (fromRepo.startsWith('..') || isAbsolute(fromRepo)) return undefined
      return await ignoredByGit(repoRoot, path, deadline) ? undefined : path
    }))).filter((path): path is string => path != null)
    const pathspec = capturePathspec(repoRoot, scope, explicitExcludedPaths)
    if (workspaceSnapshot) await checkWorkspaceCaptureLimits({
      repoRoot, cwd: canonicalCwd, head, records: statusRecords, pathspec,
      excludedPaths: canonicalExcludedPaths, deadline
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
    const alternateObjectDirs = [join(commonDir, 'objects'), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]
      .filter((value): value is string => !!value)
      .join(delimiter)
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
        baselineClean,
        indexPath,
        tempDir,
        objectDir,
        alternateObjectDirs,
        pathspec,
        excludedPaths: canonicalExcludedPaths
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
      baselineClean,
      indexPath,
      tempDir,
      objectDir,
      alternateObjectDirs,
      filterOverrides,
      pathspec,
      excludedPaths: canonicalExcludedPaths
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
  tree: string
  afterAt: string
  indexFile: string
  objectDir: string
  alternateObjectDirs?: string
  filterOverrides: string[]
  collection?: TurnDiffCollection
}

// 同一个 capture 上的重算一律排队：预览与终态共用 tempDir 下的隔离 index，
// 并发会互相踩 index.lock，得到假的空 diff 或 git_error。
export function serializeCaptureOp<T>(capture: GitTurnDiffCapture, task: () => Promise<T>): Promise<T> {
  const queued = (capture.opChain ?? Promise.resolve()).then(task, task)
  capture.opChain = queued.then(() => undefined, () => undefined)
  return queued
}
