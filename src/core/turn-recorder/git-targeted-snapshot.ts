import { rm, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { SCRY_DATA_EXCLUSION, type GitTurnDiffCapture } from './git-capture.js'
import { copyIndexWithTimestamps, gitCommand, snapshotGitArgs } from './git-command.js'

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

export function targetedPathspec(capture: GitTurnDiffCapture, paths: string[]): string[] {
  if (!capture.repoRoot || !capture.scope) return []
  const scopeRoot = capture.scope === '.' ? capture.repoRoot : resolve(capture.repoRoot, capture.scope)
  const exclusions = capture.excludedPaths ?? []
  const excludeScryData = capture.pathspec?.includes(SCRY_DATA_EXCLUSION)
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
    if (excludeScryData && /(?:^|\/)\.scry\//.test(fromRoot)) continue
    if (fromRoot && !fromRoot.startsWith('..')) out.add(`:(top,literal)${fromRoot}`)
  }
  return [...out]
}

export function changesGitSemantics(pathspec: string[]): boolean {
  return pathspec.some((path) =>
    /(?:^|\/)(?:\.gitignore|\.gitattributes|\.gitmodules)$/.test(path.replace(/^:\(top,literal\)/, ''))
  )
}

export async function writeTargetedSnapshotTree(options: {
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
export async function unchangedIndexPath(capture: GitTurnDiffCapture): Promise<string | undefined> {
  const { indexPath, indexState } = capture
  if (!capture.baselineClean || !indexPath || !indexState) return undefined
  const now = await stat(indexPath).catch(() => undefined)
  if (!now) return undefined
  const same = now.mtimeMs === indexState.mtimeMs && now.ctimeMs === indexState.ctimeMs &&
    now.size === indexState.size && now.ino === indexState.ino
  return same ? indexPath : undefined
}
