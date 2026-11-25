import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { TraceEvent, TurnDiffSnapshot, WorktreeBaselineReason } from '../../shared/trace.js'
import { withinCaptureScope } from './config.js'
import { type GitTurnDiffBaseline, beginGitTurnDiff } from './git-capture.js'
import { TURN_DIFF_TARGETED_DEADLINE_MS } from './git-command.js'
import { turnChangeHints } from './change-journal.js'
import { finishGitTurnDiff } from './git-lifecycle.js'

export const MAX_NEW_WORKTREE_BASELINES = 8

const MAX_NEW_WORKTREE_CANDIDATES = 32

const NEW_WORKTREE_BEGIN_DEADLINE_MS = TURN_DIFF_TARGETED_DEADLINE_MS

const ZERO_OBJECT_ID = '0'.repeat(40)

const REFLOG_SECOND_MS = 1_000

export interface WorktreeCreation {
  commit: string
  createdAt: string
  createdMs: number
}

export interface LinkedWorktree {
  gitDir: string
  root: string
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

export async function gitCommonDir(repository: string): Promise<string | undefined> {
  const dotGit = join(repository, '.git')
  const info = await stat(dotGit).catch(() => undefined)
  if (!info) return undefined
  if (info.isDirectory()) return dotGit
  const pointer = await readText(dotGit)
  const match = pointer ? /^gitdir:[ \t]*(.+)$/m.exec(pointer) : null
  if (!match) return undefined
  const gitDir = isAbsolute(match[1].trim()) ? match[1].trim() : resolve(repository, match[1].trim())
  const common = (await readText(join(gitDir, 'commondir')))?.trim()
  if (!common) return gitDir
  return isAbsolute(common) ? common : resolve(gitDir, common)
}

export async function linkedWorktreesOfRepository(repository: string): Promise<LinkedWorktree[]> {
  const commonDir = await gitCommonDir(repository)
  if (!commonDir) return []
  const names = await readdir(join(commonDir, 'worktrees')).catch(() => [] as string[])
  const worktrees: LinkedWorktree[] = []
  for (const name of [...names].sort()) {
    const gitDir = join(commonDir, 'worktrees', name)
    const pointer = (await readText(join(gitDir, 'gitdir')))?.trim()
    if (!pointer) continue
    worktrees.push({ gitDir, root: dirname(pointer) })
  }
  return worktrees
}

async function readReflogFirstLine(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r').catch(() => undefined)
  if (!handle) return undefined
  try {
    const buffer = Buffer.allocUnsafe(1_024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    return (newline === -1 ? text : text.slice(0, newline)).trim()
  } finally {
    await handle.close()
  }
}

export async function readWorktreeCreation(
  gitDir: string
): Promise<{ creation: WorktreeCreation } | { problem: WorktreeBaselineReason }> {
  const first = await readReflogFirstLine(join(gitDir, 'logs', 'HEAD'))
  if (!first) return { problem: 'reflog_missing' }
  const meta = first.split('\t')[0].trim().split(' ')
  if (meta.length < 5) return { problem: 'reflog_creation_not_first' }
  const [oldId, newId] = meta
  if (!/^[0-9a-f]{40}$/.test(oldId) || !/^[0-9a-f]{40}$/.test(newId)) return { problem: 'reflog_creation_not_first' }
  if (oldId !== ZERO_OBJECT_ID) return { problem: 'reflog_creation_not_first' }
  const seconds = Number(meta[meta.length - 2])
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds * 1_000 > 8.64e15) {
    return { problem: 'reflog_creation_not_first' }
  }
  return { creation: { commit: newId, createdAt: new Date(seconds * 1_000).toISOString(), createdMs: seconds * 1_000 } }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export type NewWorktreeBaselinePlan =
  | { kind: 'baseline'; requestedRoot: string; root: string; baseline: GitTurnDiffBaseline }
  | { kind: 'unavailable'; requestedRoot: string; reason: WorktreeBaselineReason }

export interface NewTurnWorktreeQuery {
  captures: string[]
  workspaceRoot: string
  excluded: Set<string>
  startedMs: number
  ceilingMs: number
}

async function worktreeDirActivityMs(gitDir: string): Promise<number | undefined> {
  const info = await stat(gitDir).catch(() => undefined)
  if (!info) return undefined
  const times = [info.birthtimeMs, info.ctimeMs, info.mtimeMs]
    .filter((value) => Number.isFinite(value) && value > 0)
  return times.length > 0 ? Math.max(...times) : undefined
}

export async function findNewTurnWorktrees(query: NewTurnWorktreeQuery): Promise<NewWorktreeBaselinePlan[]> {
  const captured = new Set(await Promise.all(query.captures.map(async (root) =>
    realpath(root).catch(() => resolve(root))
  )))
  const seen = new Set<string>()
  const candidates: LinkedWorktree[] = []
  for (const repository of query.captures) {
    for (const worktree of await linkedWorktreesOfRepository(repository)) {
      if (seen.has(worktree.gitDir)) continue
      seen.add(worktree.gitDir)
      candidates.push(worktree)
    }
  }
  const windowStart = Number.isFinite(query.startedMs) ? query.startedMs : Number.POSITIVE_INFINITY
  const plans: NewWorktreeBaselinePlan[] = []
  for (const candidate of candidates) {
    const canonical = await realpath(candidate.root).catch(() => resolve(candidate.root))
    if (captured.has(canonical)) continue
    if (!withinCaptureScope(canonical, query.workspaceRoot, query.excluded)) continue
    const reflog = await readWorktreeCreation(candidate.gitDir)
    if ('problem' in reflog) {
      const activityMs = await worktreeDirActivityMs(candidate.gitDir)
      if (activityMs !== undefined && activityMs < windowStart) continue
      plans.push({ kind: 'unavailable', requestedRoot: canonical, reason: reflog.problem })
      continue
    }
    const { creation } = reflog
    if (creation.createdMs + REFLOG_SECOND_MS - 1 < windowStart) continue
    if (creation.createdMs > query.ceilingMs) {
      plans.push({ kind: 'unavailable', requestedRoot: canonical, reason: 'reflog_outside_turn' })
      continue
    }
    if (!(await stat(candidate.root).catch(() => undefined))) {
      plans.push({ kind: 'unavailable', requestedRoot: canonical, reason: 'worktree_deleted' })
      continue
    }
    if (!(await stat(join(candidate.root, '.git')).catch(() => undefined))) {
      plans.push({ kind: 'unavailable', requestedRoot: canonical, reason: 'worktree_deleted' })
      continue
    }
    if (!(await stat(join(candidate.gitDir, 'index')).catch(() => undefined))) {
      plans.push({ kind: 'unavailable', requestedRoot: canonical, reason: 'no_checkout' })
      continue
    }
    plans.push({
      kind: 'baseline',
      requestedRoot: canonical,
      root: canonical,
      baseline: { commit: creation.commit, at: creation.createdAt }
    })
  }
  plans.sort((left, right) => left.kind === right.kind
    ? comparePaths(left.requestedRoot, right.requestedRoot)
    : left.kind === 'baseline' ? -1 : 1)
  const baselines = plans.filter((plan) => plan.kind === 'baseline')
  const overLimit = new Set(baselines.slice(MAX_NEW_WORKTREE_BASELINES).map((plan) => plan.requestedRoot))
  return plans
    .map((plan) => plan.kind === 'baseline' && overLimit.has(plan.requestedRoot)
      ? { kind: 'unavailable' as const, requestedRoot: plan.requestedRoot, reason: 'per_turn_limit' as const }
      : plan)
    .slice(0, MAX_NEW_WORKTREE_CANDIDATES)
}

export interface NewWorktreeBaselineOptions {
  captureRoot: string
  excludedPaths: string[]
  events: TraceEvent[]
  patchExcludeBasenames?: string[]
  diffExclude?: string[]
  deadlineMs?: number
  finishDeadlineMs?: number
}

function unavailableSnapshot(
  requestedRoot: string,
  reason: WorktreeBaselineReason,
  at: string,
  captureMs: number
): TurnDiffSnapshot {
  return {
    version: 1,
    status: 'unavailable',
    reason: 'no_baseline',
    files: [],
    requestedRoot,
    beforeAt: at,
    afterAt: at,
    captureMs,
    cleanup: 'ok',
    baselineSource: 'worktree-creation-reflog',
    baselineStatus: 'partial',
    baselineReason: reason
  }
}

export async function finishNewWorktreeBaseline(
  plan: NewWorktreeBaselinePlan,
  options: NewWorktreeBaselineOptions
): Promise<TurnDiffSnapshot> {
  const started = Date.now()
  if (plan.kind === 'unavailable') {
    return unavailableSnapshot(plan.requestedRoot, plan.reason, new Date(started).toISOString(), 0)
  }
  try {
    const capture = await beginGitTurnDiff(
      plan.root,
      Math.max(1, started + (options.deadlineMs ?? NEW_WORKTREE_BEGIN_DEADLINE_MS) - Date.now()),
      options.captureRoot,
      options.excludedPaths,
      false,
      plan.baseline
    )
    const snapshot = await finishGitTurnDiff(capture, options.finishDeadlineMs, {
      ...turnChangeHints(plan.root, options.events),
      patchExcludeBasenames: options.patchExcludeBasenames,
      diffExclude: options.diffExclude,
      completePatches: true
    })
    if (snapshot.status !== 'captured') {
      return {
        ...snapshot,
        requestedRoot: snapshot.requestedRoot ?? plan.requestedRoot,
        baselineSource: 'worktree-creation-reflog',
        baselineStatus: 'partial',
        baselineReason: 'capture_failed'
      }
    }
    return {
      ...snapshot,
      requestedRoot: snapshot.requestedRoot ?? plan.requestedRoot,
      baselineSource: 'worktree-creation-reflog',
      baselineStatus: 'available',
      baselineCommit: plan.baseline.commit,
      baselineCreatedAt: plan.baseline.at
    }
  } catch {
    return unavailableSnapshot(plan.requestedRoot, 'capture_failed', new Date().toISOString(), Date.now() - started)
  }
}
