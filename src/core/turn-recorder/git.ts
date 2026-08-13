// P2 Files & Diff（RFC §8.4）：拿 cwd 在单轮开始/结束之间的净 diff，与工具足迹对照。
// 用 execFile（非 exec，无 shell 注入）。非 git 仓 / 出错 → 返回空，不连累 UI。
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, open, realpath, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import type {
  DiffFile,
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
const TURN_DIFF_PATCH_MAX_BYTES = 1024 * 1024
const TURN_DIFF_PATCH_MAX_FILES = 80
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
  finishPromise?: Promise<TurnDiffSnapshot>
}

export interface GitTurnDiffFinishOptions {
  structuredPaths?: string[]
  forceFull?: boolean
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

async function cleanupCapture(capture: GitTurnDiffCapture): Promise<TurnDiffSnapshot['cleanup']> {
  if (!capture.tempDir) return 'ok'
  const dir = capture.tempDir
  capture.tempDir = undefined
  try {
    await rm(dir, { recursive: true, force: true })
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
    let inside: string
    try {
      inside = (await gitCommand(['rev-parse', '--is-inside-work-tree'], { cwd: canonicalCwd, deadline })).trim()
    } catch (error) {
      if (error instanceof GitDeadlineError) throw error
      return { beforeAt, captureMs: Date.now() - started, status: 'unavailable', reason: 'not_git' }
    }
    if (inside !== 'true') return { beforeAt, captureMs: Date.now() - started, status: 'unavailable', reason: 'not_git' }
    let head = ''
    try {
      head = (await gitCommand(['rev-parse', '--verify', 'HEAD'], { cwd: canonicalCwd, deadline })).trim()
    } catch (error) {
      if (error instanceof GitDeadlineError) throw error
    }
    if (!head) return { beforeAt, captureMs: Date.now() - started, status: 'unavailable', reason: 'no_head' }
    const repoRoot = (await gitCommand(['rev-parse', '--show-toplevel'], { cwd: canonicalCwd, deadline })).trim()
    const commonDirRaw = (await gitCommand(['rev-parse', '--git-common-dir'], { cwd: canonicalCwd, deadline })).trim()
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(canonicalCwd, commonDirRaw)
    const indexPathRaw = (await gitCommand(['rev-parse', '--git-path', 'index'], { cwd: canonicalCwd, deadline })).trim()
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
    const pathspec = capturePathspec(repoRoot, scope, canonicalExcludedPaths)
    const baselineClean = !(await gitCommand(
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

async function computeGitTurnDiff(
  capture: GitTurnDiffCapture,
  deadlineMs: number,
  options: GitTurnDiffFinishOptions,
  consume: boolean
): Promise<TurnDiffSnapshot> {
  const started = Date.now()
  const afterAt = new Date(started).toISOString()
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
    // 配置可能在本轮中变化；finish 前重扫，避免新加入的 clean/process filter 执行副作用命令。
    const filterOverrides = await loadSnapshotOverrides(capture.repoRoot, capture.tempDir, deadline)
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

    let afterTree: string | undefined
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
    if (!afterTree) throw new Error('Git after tree was not created')

    const stdout = await gitCommand(
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
    )
    files = await captureTurnPatches(capture, env, afterTree, parseNumstat(stdout, capture.repoRoot))
  } catch (error) {
    reason = reasonOf(error)
    status = reason === 'deadline' ? 'timeout' : 'failed'
  }
  const finishMs = Date.now() - started
  const cleanup = consume ? await cleanupCapture(capture) : 'ok'
  return terminalSnapshot(capture, status, reason, files, afterAt, finishMs, cleanup, collection)
}

async function readPatchPrefix(path: string, maxBytes: number): Promise<{ patch: string; truncated: boolean; bytes: number }> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes) + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const bytes = Math.min(bytesRead, maxBytes)
    return {
      patch: new StringDecoder('utf8').write(buffer.subarray(0, bytes)),
      truncated: bytesRead > maxBytes,
      bytes
    }
  } finally {
    await handle.close()
  }
}

async function captureTurnPatches(
  capture: GitTurnDiffCapture,
  env: NodeJS.ProcessEnv,
  afterTree: string,
  files: DiffFile[]
): Promise<DiffFile[]> {
  if (!capture.repoRoot || !capture.beforeTree || !capture.tempDir) return files
  const deadline = Date.now() + TURN_DIFF_PATCH_DEADLINE_MS
  const filterOverrides = capture.filterOverrides ?? []
  let remainingBytes = TURN_DIFF_PATCH_MAX_BYTES
  let deadlineReached = false
  const out: DiffFile[] = []

  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    if (file.binary) {
      out.push({ ...file, patchStatus: 'binary' })
      continue
    }
    if (index >= TURN_DIFF_PATCH_MAX_FILES || remainingBytes <= 0) {
      out.push({ ...file, patchStatus: 'unavailable', patchReason: 'budget' })
      continue
    }
    if (deadlineReached || Date.now() >= deadline) {
      deadlineReached = true
      out.push({ ...file, patchStatus: 'unavailable', patchReason: 'deadline' })
      continue
    }

    const patchPath = join(capture.tempDir, `patch-${index}.diff`)
    const relPath = relative(capture.repoRoot, file.path).split('\\').join('/')
    try {
      await gitCommand(
        snapshotGitArgs(filterOverrides, [
          'diff',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--unified=3',
          `--output=${patchPath}`,
          capture.beforeTree,
          afterTree,
          '--',
          `:(top,literal)${relPath}`
        ]),
        { cwd: capture.repoRoot, env, deadline }
      )
      const captured = await readPatchPrefix(patchPath, remainingBytes)
      remainingBytes -= captured.bytes
      if (!captured.patch) {
        out.push({ ...file, patchStatus: 'unavailable', patchReason: 'git_error' })
      } else {
        out.push({
          ...file,
          patch: captured.patch,
          patchStatus: captured.truncated ? 'truncated' : 'captured'
        })
      }
    } catch (error) {
      const reason = reasonOf(error) === 'deadline' ? 'deadline' : 'git_error'
      if (reason === 'deadline') deadlineReached = true
      out.push({ ...file, patchStatus: 'unavailable', patchReason: reason })
    }
  }
  return out
}

export function finishGitTurnDiff(
  capture: GitTurnDiffCapture,
  deadlineMs = TURN_DIFF_FINISH_DEADLINE_MS,
  options: GitTurnDiffFinishOptions = {}
): Promise<TurnDiffSnapshot> {
  capture.finishPromise ??= computeGitTurnDiff(capture, deadlineMs, options, true)
  return capture.finishPromise
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
  return computeGitTurnDiff(baseline, deadlineMs, options, false)
}

export async function cancelGitTurnDiff(capture: GitTurnDiffCapture): Promise<void> {
  await cleanupCapture(capture)
}

// `git diff --numstat -z` 的输出：每条 `added\tdeleted\tpath\0`（二进制文件增删为 `-`）。
// 必须用 -z，否则 Git 会按 core.quotePath 把中文路径转成 `\345\...` 这类 C-style/octal 字符串。
// 路径相对 repo root → 拼成绝对路径，便于和工具足迹（绝对 file_path）对照。
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
export async function gitNumstat(cwd: string): Promise<DiffFile[]> {
  const capture = await beginGitTurnDiff(cwd)
  try {
    if (capture.status !== 'ready' || !capture.repoRoot || !capture.beforeTree) return []
    if (capture.baselineClean) return [] // 工作树与 HEAD 一致
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
    return parseNumstat(stdout, capture.repoRoot)
  } catch {
    return [] // 非 git 仓 / git 不可用 / 无 HEAD / 超时：静默空
  } finally {
    await cancelGitTurnDiff(capture)
  }
}
