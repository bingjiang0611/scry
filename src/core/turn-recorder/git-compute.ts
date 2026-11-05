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
  /**
   * `discovery.index` whose content already equals `baseTree` and whose stat cache is warm.
   * Publishing it as `after.index` skips expanding the whole before-tree again; `add -A` then only
   * has to hash the candidate paths. Sparsity and reused-index proof stay the caller's decision.
   */
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

/** 启动时的 index 在这一轮里没有被改写时，它仍然是 beforeTree 的可用基线。 */
async function unchangedIndexPath(capture: GitTurnDiffCapture): Promise<string | undefined> {
  const { indexPath, indexState } = capture
  if (!capture.baselineClean || !indexPath || !indexState) return undefined
  const now = await stat(indexPath).catch(() => undefined)
  if (!now) return undefined
  const same = now.mtimeMs === indexState.mtimeMs && now.ctimeMs === indexState.ctimeMs &&
    now.size === indexState.size && now.ino === indexState.ino
  return same ? indexPath : undefined
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
      let discoveryIndex: string | undefined
      // Only a discovery index seeded from an index that already equalled beforeTree may be
      // published as the after index. The `read-tree --reset` seed also handles sparse checkout,
      // where the skip-worktree marks are rebuilt by read-tree; that case keeps the read-tree build.
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
          // 启动快照自带的 index（worktree 脏时由 writeSnapshotTree 写出，或启动后没被改写的
          // 真实 index）内容已经等于 beforeTree，且 stat cache 有效。直接沿用它就省掉一次
          // read-tree --reset；只有无法证明时才重建，保持原来的语义。
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
          // 在 beforeTree 上保留可复用的 stat cache；really-refresh 同时清掉
          // assume-unchanged 对候选发现的遮蔽，不必像 git add -A 那样重写整个 scope。
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
            // Successful discovery already reset/refreshed this index against beforeTree.
            // With no candidates, rebuilding that same tree cannot add evidence. Retain
            // the discovery index so a paired session still gets an owned after-view.
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
              // Do not mutate discovery.index in place: a shared preview/terminal pair may still
              // need it, and the zero-candidate branch above publishes it as the after view.
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

    // One tree comparison yields both the change kinds and the line counts: `--raw` and
    // `--numstat` are independent output sections of the same diff, so a second Git process
    // cannot produce anything the first one did not already decide.
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
    files = await captureTurnPatches(
      capture,
      env,
      afterTree,
      files,
      new Set(options.patchExcludeBasenames ?? []),
      deadline,
      options.completePatches === true,
      options.workspaceSnapshot ? WORKSPACE_PATCH_BYTES : undefined,
      // Review context comes from the same immutable tree pair, within the existing byte cap.
      // Recorder history keeps its original three-line capture contract.
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
  return terminalSnapshot(capture, status, reason, files, afterAt, finishMs, cleanup, collection)
}
