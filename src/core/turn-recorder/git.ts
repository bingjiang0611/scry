// P2 Files & Diff（RFC §8.4）：拿 cwd 在单轮开始/结束之间的净 diff，与工具足迹对照。
// 用 execFile（非 exec，无 shell 注入）。采集失败保留状态与原因，不冒充成功空结果。
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import { limitToolContent } from './tool-content.js'
import type {
  DiffFile,
  WorkspaceDiffResult,
  DiffFileChange,
  TurnDiffCollection,
  TurnDiffFallbackReason,
  TurnDiffReason,
  TurnDiffSnapshot
} from '../../shared/trace.js'

const pexecFile = promisify(execFile)
// Keep the pre-turn snapshot short because the Provider waits for it before starting.
// The post-turn snapshot runs after turnDone, so it can spend longer producing an exact diff
// without making the user wait for the Agent response.
const TURN_DIFF_BEGIN_DEADLINE_MS = 5_000
const TURN_DIFF_FINISH_DEADLINE_MS = 20_000
const TURN_DIFF_PATCH_DEADLINE_MS = 2_000
const TURN_DIFF_TARGETED_DEADLINE_MS = 5_000
const TURN_DIFF_CANDIDATE_LIMIT = 1_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

class GitDeadlineError extends Error {}

interface GitCommandOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  deadline: number
  allowExitOne?: boolean
}

async function gitCommand(args: string[], options: GitCommandOptions): Promise<string> {
  const timeout = options.deadline - Date.now()
  if (timeout <= 0) throw new GitDeadlineError('Git snapshot deadline exceeded')
  try {
    const { stdout } = await pexecFile('git', args, {
      cwd: options.cwd,
      env: options.env,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: GIT_MAX_BUFFER
    })
    return stdout
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
    const exitCode = (error as { code?: unknown }).code
    if (e.killed || e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT') throw new GitDeadlineError('Git snapshot deadline exceeded')
    if (options.allowExitOne && exitCode === 1) return ''
    throw error
  }
}

function reasonOf(error: unknown): TurnDiffReason {
  return error instanceof GitDeadlineError ? 'deadline' : 'git_error'
}

function filterDriverOverrides(config: string): string[] {
  const names = new Set<string>()
  for (const line of config.split('\n')) {
    const key = line.trim().split(/\s+/, 1)[0]
    const match = /^filter\.(.+)\.(?:clean|process|required)$/i.exec(key)
    if (match?.[1]) names.add(match[1])
  }
  return [...names].flatMap((name) => [
    '-c', `filter.${name}.clean=`,
    '-c', `filter.${name}.process=`,
    '-c', `filter.${name}.required=false`
  ])
}

function snapshotGitArgs(filterOverrides: string[], command: string[]): string[] {
  return ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...filterOverrides, ...command]
}

async function copyIndexWithTimestamps(source: string, target: string): Promise<void> {
  // Git 用 index mtime 判定 racy-clean。普通 copy 会把 mtime 改成“现在”，可能漏掉
  // 本轮开始前已存在、但尺寸/mtime 恰好与 index entry 相同的内容变化。
  const sourceStat = await stat(source)
  await copyFile(source, target)
  // 向下截到毫秒，宁可让 Git 多 hash 一次，也不能因浮点进位把副本写成“比源 index 更新”。
  await utimes(target, Math.floor(sourceStat.atimeMs) / 1_000, Math.floor(sourceStat.mtimeMs) / 1_000)
}

async function loadSnapshotOverrides(cwd: string, tempDir: string, deadline: number): Promise<string[]> {
  const filterConfig = await gitCommand(['config', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'], {
    cwd,
    deadline,
    allowExitOne: true
  })
  return [...filterDriverOverrides(filterConfig), '-c', `core.hooksPath=${join(tempDir, 'hooks-disabled')}`]
}

async function writeSnapshotTree(options: {
  cwd: string
  pathspec: string[]
  env: NodeJS.ProcessEnv
  deadline: number
  filterOverrides: string[]
  sourceIndex: string
  targetIndex: string
}): Promise<string> {
  const { cwd, pathspec, env, deadline, filterOverrides, sourceIndex, targetIndex } = options
  let copied = false
  try {
    await copyIndexWithTimestamps(sourceIndex, targetIndex)
    copied = true
  } catch {}

  try {
    // 从 HEAD 重建逻辑内容，清掉真实 index 中与观测无关的 staged/unmerged 状态；
    // really-refresh 再强制核对 assume-unchanged，避免它让 add 漏掉真实改动。
    await gitCommand(snapshotGitArgs(filterOverrides, ['read-tree', '--reset', 'HEAD']), { cwd, env, deadline })
    await gitCommand(snapshotGitArgs(filterOverrides, ['update-index', '--really-refresh']), {
      cwd,
      env,
      deadline,
      allowExitOne: true
    })
    await gitCommand(snapshotGitArgs(filterOverrides, ['add', '-A', '--', ...pathspec]), { cwd, env, deadline })
    return (await gitCommand(snapshotGitArgs(filterOverrides, ['write-tree']), { cwd, env, deadline })).trim()
  } catch (error) {
    if (!copied || error instanceof GitDeadlineError) throw error
    await rm(targetIndex, { force: true })
    await gitCommand(snapshotGitArgs(filterOverrides, ['read-tree', 'HEAD']), { cwd, env, deadline })
    await gitCommand(snapshotGitArgs(filterOverrides, ['add', '-A', '--', ...pathspec]), { cwd, env, deadline })
    return (await gitCommand(snapshotGitArgs(filterOverrides, ['write-tree']), { cwd, env, deadline })).trim()
  }
}

export interface GitTurnDiffCapture {
  beforeAt: string
  captureMs: number
  status: 'ready' | 'unavailable' | 'timeout' | 'failed'
  reason?: TurnDiffReason
  repoRoot?: string
  scope?: string
  requestedRoot?: string
  beforeTree?: string
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

function capturePathspec(repoRoot: string, scope: string, excludedPaths: string[]): string[] {
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

function terminalSnapshot(
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
function retainAfterStorage(capture: GitTurnDiffCapture): () => Promise<TurnDiffSnapshot['cleanup']> {
  const owner: GitTurnDiffCapture = { ...capture, finishPromise: undefined, opChain: undefined }
  let references = 2
  const release = async (): Promise<TurnDiffSnapshot['cleanup']> => {
    references--
    return references === 0 ? cleanupCapture(owner) : 'ok'
  }
  retainedCaptureStorage.set(capture, release)
  return release
}

async function cleanupCapture(capture: GitTurnDiffCapture): Promise<TurnDiffSnapshot['cleanup']> {
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
  excludedPaths: string[] = []
): Promise<GitTurnDiffCapture> {
  const started = Date.now()
  const beforeAt = new Date(started).toISOString()
  const deadline = started + deadlineMs
  const requestedRoot = resolve(cwd)
  let tempDir: string | undefined
  try {
    const canonicalCwd = await realpath(cwd)
    // Layout 与 status 都只读同一仓库且彼此无依赖，并行启动。porcelain v2 的 branch.oid
    // 同时给出 HEAD；没有显式排除路径时，它还直接给出 baselineClean。这样常见路径只需
    // 一轮并行 Git 进程，不再串行执行 HEAD 与 status 两轮探测。
    const [layoutResult, statusResult] = await Promise.allSettled([
      gitCommand(
        ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir', '--git-path', 'index'],
        { cwd: canonicalCwd, deadline }
      ),
      gitCommand(snapshotGitArgs([], ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.']), {
        cwd: canonicalCwd,
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
    const reason = reasonOf(error)
    return {
      beforeAt,
      captureMs: Date.now() - started,
      status: reason === 'deadline' ? 'timeout' : 'failed',
      reason
    }
  }
}

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
}): Promise<string> {
  const { cwd, baseTree, pathspec, env, deadline, filterOverrides, targetIndex } = options
  await rm(targetIndex, { force: true })
  await rm(`${targetIndex}.lock`, { force: true })
  await gitCommand(snapshotGitArgs(filterOverrides, ['read-tree', baseTree]), { cwd, env, deadline })
  if (pathspec.length > 0) {
    await gitCommand(snapshotGitArgs(filterOverrides, ['add', '-A', '--', ...pathspec]), { cwd, env, deadline })
  }
  return (await gitCommand(snapshotGitArgs(filterOverrides, ['write-tree']), { cwd, env, deadline })).trim()
}

interface GitAfterTree {
  tree: string
  afterAt: string
  indexFile: string
  objectDir: string
  alternateObjectDirs?: string
  filterOverrides: string[]
  collection?: TurnDiffCollection
}

async function computeGitTurnDiff(
  capture: GitTurnDiffCapture,
  deadlineMs: number,
  options: GitTurnDiffFinishOptions,
  consume: boolean,
  sharedAfter?: GitAfterTree,
  onAfter?: (after: GitAfterTree) => void
): Promise<TurnDiffSnapshot> {
  const started = Date.now()
  let afterAt = new Date(started).toISOString()
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
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
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
      // 配置可能在本轮中变化；finish 前重扫，避免新加入的 clean/process filter 执行副作用命令。
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
      const hasStructuredEvidence = targetedPathspec(capture, options.structuredPaths ?? []).length > 0

      if (!fallbackReason) {
        const discoveryStarted = Date.now()
        try {
          const discoveryDeadline = Math.min(
            preFallbackDeadline,
            discoveryStarted + Math.max(250, Math.floor(preFallbackBudget / 2))
          )
          const discoveryIndex = join(capture.tempDir, 'discovery.index')
          const discoveryEnv: NodeJS.ProcessEnv = { ...env, GIT_INDEX_FILE: discoveryIndex }
          await rm(discoveryIndex, { force: true })
          await rm(`${discoveryIndex}.lock`, { force: true })
          const discoverySource = capture.baselineClean
            ? capture.indexPath ?? join(capture.tempDir, 'missing.index')
            : join(capture.tempDir, 'before.index')
          await copyIndexWithTimestamps(discoverySource, discoveryIndex).catch(() => undefined)
          // 在 beforeTree 上保留可复用的 stat cache；really-refresh 同时清掉
          // assume-unchanged 对候选发现的遮蔽，不必像 git add -A 那样重写整个 scope。
          await gitCommand(snapshotGitArgs(filterOverrides, ['read-tree', '--reset', capture.beforeTree]), {
            cwd: capture.repoRoot,
            env: discoveryEnv,
            deadline: discoveryDeadline
          })
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
          afterTree = await writeTargetedSnapshotTree({
            cwd: capture.repoRoot,
            baseTree: capture.beforeTree,
            pathspec: targetPathspec,
            env,
            deadline: preFallbackDeadline,
            filterOverrides,
            targetIndex: afterIndex
          })
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

    const [numstat, nameStatus] = await Promise.all([
      gitCommand(
        snapshotGitArgs(filterOverrides, [
          'diff',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          '--numstat',
          '-z',
          capture.beforeTree,
          afterTree,
          '--',
          ...fullPathspec
        ]),
        { cwd: capture.repoRoot, env, deadline }
      ),
      gitCommand(
        snapshotGitArgs(filterOverrides, [
          'diff',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          '--name-status',
          '-z',
          capture.beforeTree,
          afterTree,
          '--',
          ...fullPathspec
        ]),
        { cwd: capture.repoRoot, env, deadline }
      )
    ])
    const changes = parseNameStatus(nameStatus, capture.repoRoot)
    files = await captureTurnPatches(
      capture,
      env,
      afterTree,
      parseNumstat(numstat, capture.repoRoot).map((file) => {
        const change = changes.get(file.path)
        return { ...file, ...(change ? { change } : {}) }
      }),
      new Set(options.patchExcludeBasenames ?? []),
      deadline,
      options.completePatches === true
    )
  } catch (error) {
    reason = reasonOf(error)
    status = reason === 'deadline' ? 'timeout' : 'failed'
  }
  const finishMs = Date.now() - started
  const cleanup = consume ? await cleanupCapture(capture) : 'ok'
  return terminalSnapshot(capture, status, reason, files, afterAt, finishMs, cleanup, collection)
}

const PATCH_BATCH_MAX_FILES = 128
const PATCH_BATCH_MAX_ARG_BYTES = 64 * 1024

interface RawPatchRecord {
  path: Buffer
}

interface ParsedPatchBody {
  end: number
  complete: boolean
}

function patchDiffArgs(filterOverrides: string[], command: string[]): string[] {
  // These are deliberately command-line settings rather than repository config. Patch framing
  // is consumed below, so diff.* and color.* config must not be able to change its markers.
  return snapshotGitArgs(filterOverrides, [
    '--no-pager',
    '-c', 'core.quotePath=true',
    '-c', 'diff.noprefix=false',
    '-c', 'diff.mnemonicprefix=false',
    '-c', 'color.ui=false',
    '-c', 'color.diff=false',
    ...command
  ])
}

function splitRawPatchOutput(bytes: Buffer): { records: RawPatchRecord[]; patchStart: number } | undefined {
  const records: RawPatchRecord[] = []
  let offset = 0
  while (offset < bytes.length) {
    // `--raw -z` emits a colon-prefixed metadata record followed by one NUL-terminated path.
    // The additional NUL after the final path is Git's native boundary to the patch stream.
    if (bytes[offset] === 0 && records.length > 0) return { records, patchStart: offset + 1 }
    if (bytes[offset] !== 0x3a) return undefined
    const metadataEnd = bytes.indexOf(0, offset)
    if (metadataEnd < 0) return undefined
    const metadata = bytes.subarray(offset, metadataEnd).toString('ascii')
    if (!/^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ [A-Z][0-9]*$/.test(metadata)) return undefined
    const pathStart = metadataEnd + 1
    const pathEnd = bytes.indexOf(0, pathStart)
    if (pathEnd < 0) return undefined
    records.push({ path: bytes.subarray(pathStart, pathEnd) })
    offset = pathEnd + 1
  }
  return records.length === 0 ? { records, patchStart: bytes.length } : undefined
}

function hunkCounts(line: Buffer): { oldLines: number; newLines: number } | undefined {
  const text = line.toString('ascii')
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
  if (!match) return undefined
  const oldLines = Number(match[2] ?? 1)
  const newLines = Number(match[4] ?? 1)
  return Number.isSafeInteger(oldLines) && Number.isSafeInteger(newLines)
    ? { oldLines, newLines }
    : undefined
}

function nextPatchLine(bytes: Buffer, offset: number): { line: Buffer; next: number } | undefined {
  if (offset >= bytes.length) return undefined
  const end = bytes.indexOf(0x0a, offset)
  const next = end < 0 ? bytes.length : end + 1
  return { line: bytes.subarray(offset, end < 0 ? bytes.length : end), next }
}

/**
 * Split Git's patch stream without trusting its quoted headers. Raw -z records determine the
 * file/order mapping; this parser only uses hunk counts to avoid mistaking header-like hunk text
 * for the next `diff --git` delimiter.
 */
function parsePatchBody(bytes: Buffer, start: number): ParsedPatchBody | undefined {
  let cursor = start
  const first = nextPatchLine(bytes, cursor)
  if (!first || !first.line.toString('ascii').startsWith('diff --git ')) return undefined
  cursor = first.next
  let sawBodyLine = false
  let oldRemaining = 0
  let newRemaining = 0
  let inHunk = false
  let sawHunk = false
  let sawOldMode = false
  let sawNewMode = false
  let sawFileMode = false
  let sawIndex = false
  let sawOldFile = false
  let sawNewFile = false

  const completeBody = (): boolean => sawHunk || (sawOldMode && sawNewMode) ||
    (sawFileMode && sawIndex) || (sawOldFile && sawNewFile)

  while (cursor < bytes.length) {
    const currentOffset = cursor
    const current = nextPatchLine(bytes, cursor)
    if (!current) break
    cursor = current.next
    const line = current.line
    if (inHunk) {
      if (line.toString('ascii') === '\\ No newline at end of file') continue
      const indicator = line[0]
      if (indicator === 0x20) {
        oldRemaining--
        newRemaining--
      } else if (indicator === 0x2b) {
        newRemaining--
      } else if (indicator === 0x2d) {
        oldRemaining--
      } else {
        return undefined
      }
      if (oldRemaining < 0 || newRemaining < 0) return undefined
      if (oldRemaining === 0 && newRemaining === 0) inHunk = false
      continue
    }

    if (line.toString('ascii').startsWith('diff --git ')) {
      return completeBody() ? { end: currentOffset, complete: true } : undefined
    }
    sawBodyLine = true
    const text = line.toString('ascii')
    sawOldMode ||= text.startsWith('old mode ')
    sawNewMode ||= text.startsWith('new mode ')
    sawFileMode ||= text.startsWith('new file mode ') || text.startsWith('deleted file mode ')
    sawIndex ||= text.startsWith('index ')
    sawOldFile ||= text.startsWith('--- ')
    sawNewFile ||= text.startsWith('+++ ')
    const counts = hunkCounts(line)
    if (counts) {
      oldRemaining = counts.oldLines
      newRemaining = counts.newLines
      inHunk = true
      sawHunk = true
    } else if (text.startsWith('@@ ')) {
      return undefined
    }
  }
  if (inHunk || !sawBodyLine || !completeBody()) return undefined
  return { end: bytes.length, complete: true }
}

function patchBatchFiles(
  files: DiffFile[],
  capture: GitTurnDiffCapture,
  excludedBasenames: ReadonlySet<string>
): { result: DiffFile[]; pending: Array<{ index: number; file: DiffFile; pathspec: string; pathBytes: Buffer }> } {
  const result = files.map((file) => {
    if (file.binary) return { ...file, patchStatus: 'binary' as const }
    if (excludedBasenames.has(basename(file.path))) {
      return { ...file, patchStatus: 'unavailable' as const, patchReason: 'policy' as const }
    }
    return file
  })
  const pending = files.flatMap((file, index) => {
    if (file.binary || excludedBasenames.has(basename(file.path))) return []
    const relPath = relative(capture.repoRoot!, file.path).split(sep).join('/')
    return [{ index, file, pathspec: `:(top,literal)${relPath}`, pathBytes: Buffer.from(relPath) }]
  })
  return { result, pending }
}

async function captureTurnPatches(
  capture: GitTurnDiffCapture,
  env: NodeJS.ProcessEnv,
  afterTree: string,
  files: DiffFile[],
  excludedBasenames: ReadonlySet<string>,
  operationDeadline: number,
  completePatches: boolean
): Promise<DiffFile[]> {
  if (!capture.repoRoot || !capture.beforeTree || !capture.tempDir) return files
  const deadline = completePatches ? operationDeadline : Date.now() + TURN_DIFF_PATCH_DEADLINE_MS
  const filterOverrides = capture.filterOverrides ?? []
  const { result, pending } = patchBatchFiles(files, capture, excludedBasenames)
  let deadlineReached = false
  let batchNumber = 0

  for (let start = 0; start < pending.length; start += PATCH_BATCH_MAX_FILES) {
    const batch = pending.slice(start, start + PATCH_BATCH_MAX_FILES)
    const argBytes = batch.reduce((total, item) => total + Buffer.byteLength(item.pathspec) + 1, 0)
    // Keep both the number and encoded size bounded. A pathspec is passed as one argv item, so
    // names containing whitespace/newlines/quotes/backslashes never undergo shell splitting.
    const bounded = argBytes <= PATCH_BATCH_MAX_ARG_BYTES
      ? batch
      : batch.slice(0, Math.max(1, batch.findIndex((_, index) => {
          return batch.slice(0, index + 1).reduce((sum, value) => sum + Buffer.byteLength(value.pathspec) + 1, 0) > PATCH_BATCH_MAX_ARG_BYTES
        })))
    const currentBatch = bounded.length > 0 ? bounded : [batch[0]]
    if (deadlineReached || Date.now() >= deadline) {
      deadlineReached = true
      for (const item of currentBatch) result[item.index] = {
        ...item.file, patchStatus: 'unavailable', patchReason: 'deadline'
      }
      continue
    }

    const patchPath = join(capture.tempDir, `patch-batch-${batchNumber++}.diff`)
    const rawPathspecs = currentBatch.map((item) => item.pathspec)
    let commandError: TurnDiffReason | undefined
    try {
      await gitCommand(
        patchDiffArgs(filterOverrides, [
          'diff',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--raw',
          '-z',
          '--patch',
          '--unified=3',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          '--line-prefix=',
          '--output-indicator-new=+',
          '--output-indicator-old=-',
          '--output-indicator-context= ',
          `--output=${patchPath}`,
          capture.beforeTree,
          afterTree,
          '--',
          ...rawPathspecs
        ]),
        { cwd: capture.repoRoot, env, deadline }
      )
    } catch (error) {
      commandError = reasonOf(error)
      if (commandError === 'deadline') deadlineReached = true
    }

    let bytes: Buffer | undefined
    try { bytes = await readFile(patchPath) } catch {}
    const parsed = bytes ? splitRawPatchOutput(bytes) : undefined
    let bodyCursor = parsed?.patchStart ?? 0
    const records = parsed?.records ?? []
    const batchByPath = new Map(currentBatch.map((item) => [item.pathBytes.toString('hex'), item]))
    for (let recordIndex = 0; recordIndex < Math.min(records.length, currentBatch.length); recordIndex++) {
      const record = records[recordIndex]
      const matching = batchByPath.get(record.path.toString('hex'))
      const body = parsed && bytes ? parsePatchBody(bytes, bodyCursor) : undefined
      if (!matching || !body?.complete) break
      result[matching.index] = {
        ...matching.file,
        patch: new StringDecoder('utf8').write(bytes!.subarray(bodyCursor, body.end)),
        patchStatus: 'captured'
      }
      bodyCursor = body.end
    }

    const capturedIndexes = new Set(result
      .map((file, index) => file.patchStatus === 'captured' ? index : -1)
      .filter((index) => index >= 0))
    for (const item of currentBatch) {
      if (capturedIndexes.has(item.index)) continue
      result[item.index] = {
        ...item.file,
        patchStatus: 'unavailable',
        patchReason: commandError === 'deadline' ? 'deadline' : 'git_error'
      }
    }
    // If a pathspec-size split left work in this 128-file window, process it as the next bounded
    // batch. No failed file is retried; only the not-yet-started suffix is processed.
    if (currentBatch.length < batch.length) start += currentBatch.length - PATCH_BATCH_MAX_FILES
  }

  if (deadlineReached) {
    for (const item of pending) {
      if (!result[item.index].patchStatus) result[item.index] = {
        ...item.file, patchStatus: 'unavailable', patchReason: 'deadline'
      }
    }
  }
  return result
}

function utf8Prefix(value: string, maxBytes: number): { value: string; bytes: number } {
  const buffer = Buffer.from(value)
  const prefix = new StringDecoder('utf8').write(buffer.subarray(0, Math.max(0, maxBytes)))
  return { value: prefix, bytes: Buffer.byteLength(prefix) }
}

export function limitTurnDiffPatchBytes(
  snapshots: TurnDiffSnapshot[],
  maxBytes = Number.POSITIVE_INFINITY
): TurnDiffSnapshot[] {
  let remainingBytes = Math.max(0, maxBytes)
  return snapshots.map((snapshot) => ({
    ...snapshot,
    files: snapshot.files.map((file) => {
      if (!file.patch) return file
      const bytes = Buffer.byteLength(file.patch)
      if (bytes <= remainingBytes) {
        remainingBytes -= bytes
        return file
      }
      const prefix = utf8Prefix(file.patch, remainingBytes)
      remainingBytes -= prefix.bytes
      if (file.patchContent?.contentRef) {
        const patchContent = limitToolContent(file.patchContent, prefix.bytes, 'turn_budget')
        return {
          ...file,
          ...(prefix.value ? { patch: prefix.value } : { patch: undefined }),
          patchContent,
          patchStatus: 'truncated',
          patchReason: undefined
        }
      }
      return prefix.value
        ? { ...file, patch: prefix.value, patchStatus: 'truncated' }
        : { ...file, patch: undefined, patchStatus: 'unavailable', patchReason: 'budget' }
    })
  }))
}

// 同一个 capture 上的重算一律排队：预览与终态共用 tempDir 下的隔离 index，
// 并发会互相踩 index.lock，得到假的空 diff 或 git_error。
function serializeCaptureOp<T>(capture: GitTurnDiffCapture, task: () => Promise<T>): Promise<T> {
  const queued = (capture.opChain ?? Promise.resolve()).then(task, task)
  capture.opChain = queued.then(() => undefined, () => undefined)
  return queued
}

export function finishGitTurnDiff(
  capture: GitTurnDiffCapture,
  deadlineMs = TURN_DIFF_FINISH_DEADLINE_MS,
  options: GitTurnDiffFinishOptions = {}
): Promise<TurnDiffSnapshot> {
  capture.finishPromise ??= serializeCaptureOp(capture, () => computeGitTurnDiff(capture, deadlineMs, options, true))
  return capture.finishPromise
}

function sameSnapshotScope(capture: GitTurnDiffCapture, baseline: GitTurnDiffCapture): boolean {
  const ready = (value: GitTurnDiffCapture): boolean => value.status === 'ready' &&
    !!value.repoRoot && !!value.scope && !!value.beforeTree && !!value.tempDir && !!value.objectDir
  const samePaths = (left: string[], right: string[]): boolean => {
    const a = new Set(left)
    const b = new Set(right)
    return a.size === b.size && [...a].every(path => b.has(path))
  }
  return ready(capture) && ready(baseline) && capture.repoRoot === baseline.repoRoot &&
    capture.scope === baseline.scope &&
    samePaths(capture.pathspec ?? [capture.scope!], baseline.pathspec ?? [baseline.scope!]) &&
    samePaths(capture.excludedPaths ?? [], baseline.excludedPaths ?? [])
}

/**
 * A compatible terminal pair owns one immutable endpoint. The turn releases its reference and
 * becomes observable first; the session owns the remaining reference until its projection and
 * cleanup finish. This is the same ownership rule as baseline clones, not deferred unowned work.
 */
export function finishGitTurnAndSessionDiff(
  capture: GitTurnDiffCapture,
  baseline: GitTurnDiffCapture,
  deadlineMs = TURN_DIFF_FINISH_DEADLINE_MS,
  turnOptions: GitTurnDiffFinishOptions = {},
  sessionOptions: GitTurnDiffFinishOptions = {}
): { turn: Promise<TurnDiffSnapshot>; session: Promise<TurnDiffSnapshot> } {
  if (capture.finishPromise || capture === baseline || !sameSnapshotScope(capture, baseline)) {
    const turn = finishGitTurnDiff(capture, deadlineMs, turnOptions)
    return { turn, session: turn.then(() => snapshotSessionNetDiff(baseline, deadlineMs, sessionOptions)) }
  }
  const previous = Promise.all([capture.opChain, baseline.opChain])
  let shared = false
  let after: GitAfterTree | undefined
  let captureStarted = Date.now()
  let releasePeer: (() => Promise<TurnDiffSnapshot['cleanup']>) | undefined
  const turn = previous.then(async () => {
    captureStarted = Date.now()
    shared = sameSnapshotScope(capture, baseline)
    let snapshot: TurnDiffSnapshot
    let cleanup: TurnDiffSnapshot['cleanup'] = 'ok'
    let cleanupMs = 0
    try {
      snapshot = await computeGitTurnDiff(capture, deadlineMs, shared ? {
        ...turnOptions,
        forceFull: turnOptions.forceFull === true || sessionOptions.forceFull === true,
        structuredPaths: [...(turnOptions.structuredPaths ?? []), ...(sessionOptions.structuredPaths ?? [])]
      } : turnOptions, false, undefined, shared ? value => {
        after = value
        releasePeer = retainAfterStorage(capture)
      } : undefined)
    } finally {
      const cleanupStarted = Date.now()
      cleanup = await cleanupCapture(capture)
      cleanupMs = Date.now() - cleanupStarted
    }
    return { ...snapshot, captureMs: snapshot.captureMs + cleanupMs, cleanup }
  })
  const session = turn.then(async turnSnapshot => {
    let snapshot: TurnDiffSnapshot
    let cleanup: TurnDiffSnapshot['cleanup'] = 'ok'
    let cleanupMs = 0
    try {
      snapshot = !shared
        ? await computeGitTurnDiff(baseline, deadlineMs, sessionOptions, false)
        : after
          ? await computeGitTurnDiff(baseline, deadlineMs, sessionOptions, false, after)
          : terminalSnapshot(
              baseline, turnSnapshot.status === 'timeout' ? 'timeout' : 'failed',
              turnSnapshot.reason ?? 'git_error', [], turnSnapshot.afterAt, Date.now() - captureStarted, 'ok',
              turnSnapshot.collection ? { ...turnSnapshot.collection, sharedAfter: 'turn' } : undefined
            )
    } finally {
      if (releasePeer) {
        const cleanupStarted = Date.now()
        cleanup = await releasePeer()
        cleanupMs = Date.now() - cleanupStarted
      }
    }
    return { ...snapshot, captureMs: snapshot.captureMs + cleanupMs, ...(cleanup === 'failed' ? { cleanup } : {}) }
  }, async error => {
    if (releasePeer) await releasePeer()
    throw error
  })
  // Reserving both queues synchronously also serializes registry cancellation. The turn's
  // finishPromise is independent, but neither capture may be disposed by a queued operation
  // until the session has released the last dependency on the turn's objects.
  const settled = session.then(() => undefined, () => undefined)
  capture.opChain = settled
  baseline.opChain = settled
  capture.finishPromise = turn
  return { turn, session }
}

// 会话级净改动：拿一个「会话第一轮开始前」捕获、且贯穿整个会话存活的 baseline capture，
// 把当前工作树快照进它自己的 object store，再 diff baseline.beforeTree → 当前树。
// 与逐轮 finishGitTurnDiff 的关键区别：非消费式——不清理 baseline，可跨轮多次调用，
// 每次都得到「基线 → 此刻」的真实净 diff（同一行跨轮反复改只净算一次），
// 会话开始前已有的脏改动已折进 beforeTree 因而自然被排除。
export function snapshotSessionNetDiff(
  baseline: GitTurnDiffCapture,
  deadlineMs = TURN_DIFF_FINISH_DEADLINE_MS,
  options: GitTurnDiffFinishOptions = {}
): Promise<TurnDiffSnapshot> {
  return serializeCaptureOp(baseline, () => computeGitTurnDiff(baseline, deadlineMs, options, false))
}

/**
 * 运行中预览：对同一个 capture 做非消费式重算，得到「基线 → 此刻」的临时净 diff。
 * 一旦终态重算已经开始（finishPromise 存在），capture 的 tempDir 归终态所有并会被消费，
 * 此时返回 null——调用方必须丢弃这条迟到预览，绝不能用它覆盖已发布的终态。
 */
export function previewGitTurnDiff(
  capture: GitTurnDiffCapture,
  deadlineMs = TURN_DIFF_FINISH_DEADLINE_MS,
  options: GitTurnDiffFinishOptions = {}
): Promise<TurnDiffSnapshot | null> {
  if (capture.finishPromise) return Promise.resolve(null)
  return serializeCaptureOp(capture, async () => {
    if (capture.finishPromise) return null
    return computeGitTurnDiff(capture, deadlineMs, options, false)
  })
}

export function cancelGitTurnDiff(capture: GitTurnDiffCapture): Promise<void> {
  return serializeCaptureOp(capture, async () => { await cleanupCapture(capture) })
}

// `git diff --numstat -z` 的输出：每条 `added\tdeleted\tpath\0`（二进制文件增删为 `-`）。
// 必须用 -z，否则 Git 会按 core.quotePath 把中文路径转成 `\345\...` 这类 C-style/octal 字符串。
// 路径相对 repo root → 拼成绝对路径，便于和工具足迹（绝对 file_path）对照。
export function parseNameStatus(stdout: string, repoRoot: string): Map<string, DiffFileChange> {
  const fields = stdout.split('\0').filter(Boolean)
  const out = new Map<string, DiffFileChange>()
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index][0]
    const change = status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'M' ? 'modified' : undefined
    if (change) out.set(join(repoRoot, fields[index + 1]), change)
  }
  return out
}

export function parseNumstat(stdout: string, repoRoot: string): DiffFile[] {
  const out: DiffFile[] = []
  const records = stdout.includes('\0') ? stdout.split('\0') : stdout.split('\n')
  for (const record of records) {
    if (!record.trim()) continue
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const addedRaw = record.slice(0, firstTab)
    const deletedRaw = record.slice(firstTab + 1, secondTab)
    const rel = record.slice(secondTab + 1)
    const binary = addedRaw === '-' || deletedRaw === '-'
    const added = binary ? 0 : Number(addedRaw) || 0
    const deleted = binary ? 0 : Number(deletedRaw) || 0
    out.push({ path: join(repoRoot, rel), added, deleted, ...(binary ? { binary: true } : {}) })
  }
  return out
}

// 「工作区未提交改动」= 当前工作树 vs HEAD，语义上独立于每轮 turn diff。
// 直接 `git diff HEAD` 会漏掉未跟踪新文件，所以复用 beginGitTurnDiff 的快照树：
// 它已经把 untracked（排除 ignored）用隔离 index/object dir 暂存成一棵 tree，不动真实 index。
export interface WorkspaceGitDiff {
  status: 'captured' | 'unavailable' | 'timeout' | 'failed'
  reason?: TurnDiffReason
  patch: string
  truncated: boolean
}

// A bounded current-worktree vs HEAD view, including untracked files. Reuse the
// isolated, filter-disabled snapshot; never refresh/write the user's real index.
// Unlike gitNumstat, failure is not an empty/clean diff. Huge output fails at the
// existing 16 MiB subprocess bound; the phone preview retains at most 64 KiB.
export async function readWorkspaceGitDiff(cwd: string): Promise<WorkspaceGitDiff> {
  const capture = await beginGitTurnDiff(cwd)
  try {
    if (capture.status !== 'ready' || !capture.repoRoot || !capture.beforeTree) {
      return { status: capture.status === 'ready' ? 'failed' : capture.status,
        reason: capture.reason ?? 'git_error', patch: '', truncated: false }
    }
    const patch = await gitCommand(snapshotGitArgs(capture.filterOverrides ?? [], [
      'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
      'HEAD', capture.beforeTree, '--', ...(capture.pathspec ?? ['.'])
    ]), {
      cwd: capture.repoRoot,
      env: { ...process.env, GIT_OBJECT_DIRECTORY: capture.objectDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: capture.alternateObjectDirs },
      deadline: Date.now() + TURN_DIFF_BEGIN_DEADLINE_MS
    })
    return { status: 'captured', patch: utf8Prefix(patch, 64 * 1024).value,
      truncated: Buffer.byteLength(patch) > 64 * 1024 }
  } catch (error) {
    return { status: error instanceof GitDeadlineError ? 'timeout' : 'failed',
      reason: error instanceof GitDeadlineError ? 'deadline' : 'git_error', patch: '', truncated: false }
  } finally {
    await cancelGitTurnDiff(capture)
  }
}

export async function gitNumstat(cwd: string): Promise<WorkspaceDiffResult> {
  const capture = await beginGitTurnDiff(cwd)
  try {
    if (capture.status !== 'ready') {
      return { status: capture.status, reason: capture.reason ?? 'git_error', files: [] }
    }
    if (!capture.repoRoot || !capture.beforeTree) return { status: 'failed', reason: 'no_baseline', files: [] }
    if (capture.baselineClean) return { status: 'captured', files: [] }
    const stdout = await gitCommand(
      snapshotGitArgs(capture.filterOverrides ?? [], [
        'diff',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '-z',
        'HEAD',
        capture.beforeTree,
        '--',
        ...(capture.pathspec ?? ['.'])
      ]),
      {
        cwd: capture.repoRoot,
        env: {
          ...process.env,
          GIT_OBJECT_DIRECTORY: capture.objectDir,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: capture.alternateObjectDirs
        },
        deadline: Date.now() + TURN_DIFF_BEGIN_DEADLINE_MS
      }
    )
    return { status: 'captured', files: parseNumstat(stdout, capture.repoRoot) }
  } catch (error) {
    return { status: error instanceof GitDeadlineError ? 'timeout' : 'failed', reason: reasonOf(error), files: [] }
  } finally {
    await cancelGitTurnDiff(capture)
  }
}
