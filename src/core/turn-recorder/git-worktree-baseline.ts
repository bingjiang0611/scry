import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { TraceEvent, TurnDiffSnapshot, WorktreeBaselineReason } from '../../shared/trace.js'
import { withinCaptureScope } from './config.js'
import { type GitTurnDiffBaseline, beginGitTurnDiff } from './git-capture.js'
import { TURN_DIFF_TARGETED_DEADLINE_MS } from './git-command.js'
import { turnChangeHints } from './change-journal.js'
import { finishGitTurnDiff } from './git-lifecycle.js'

/**
 * 一轮最多采集 8 个新建 worktree 的 diff。超出的写 partial（per_turn_limit），
 * 不让收尾时间随 worktree 数量无上限增长。
 */
export const MAX_NEW_WORKTREE_BASELINES = 8

/** 单轮最多上报的候选条目；防止异常回合把记录撑大。超出部分不再逐条上报。 */
const MAX_NEW_WORKTREE_CANDIDATES = 32

/**
 * begin 用回合开始的 5 秒上限（与 start hook 一致），finish 沿用现有 20 秒 finish 预算。
 * 所有新 worktree 与已有仓库并发采集，所以给足 finish 不会拉长收尾墙钟时间；
 * 反而能避免「在 worktree 里跑过构建」这种可归因的回合被 5 秒截断成 timeout。
 */
const NEW_WORKTREE_BEGIN_DEADLINE_MS = TURN_DIFF_TARGETED_DEADLINE_MS

const ZERO_OBJECT_ID = '0'.repeat(40)

/**
 * reflog 时间戳只到秒。一条记录只能证明「创建发生在这个秒内的某一刻」，
 * 所以它代表区间 [createdMs, createdMs + 999]。窗口判定必须按区间相交，
 * 否则「回合开始后立刻建 worktree」会被误判成窗口之外。
 */
const REFLOG_SECOND_MS = 1_000

export interface WorktreeCreation {
  commit: string
  createdAt: string
  createdMs: number
}

export interface LinkedWorktree {
  /** `<worktree>/.git` 指向的每个 worktree 专属 Git 目录：`<common>/worktrees/<name>`。 */
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

/** `<repository>/.git` → 共享 Git 目录；直接读文件，不启动 Git 进程。 */
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

/** 列出某个仓库的 linked worktree（主工作树不在其中）。 */
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

/**
 * 只读 reflog 的第一行：`logs/HEAD` 会随 checkout 历史无上限增长，而创建记录永远是第一条。
 * 单行上限 1KB，足够容纳 `<old> <new> <ident> <ts> <tz>`；更长的行会被当成不合约形态。
 */
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

/**
 * worktree 自己的 HEAD reflog 第一条：旧值全 0、新值 = 创建时检出的提交，并带秒级时间戳。
 * `git worktree add` 从该提交干净检出，创建前目录不存在，所以这条记录就是确定的基线。
 * 只有能证明「这一条就是创建记录」时才返回 creation，否则返回拿不到基线的原因。
 */
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
  // `<old> <new> <ident...> <unix-ts> <tz>`；ident 里可能有空格，时间戳永远是倒数第二个字段。
  const seconds = Number(meta[meta.length - 2])
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return { problem: 'reflog_creation_not_first' }
  return { creation: { commit: newId, createdAt: new Date(seconds * 1_000).toISOString(), createdMs: seconds * 1_000 } }
}

export type NewWorktreeBaselinePlan =
  | { kind: 'baseline'; requestedRoot: string; root: string; baseline: GitTurnDiffBaseline }
  | { kind: 'unavailable'; requestedRoot: string; reason: WorktreeBaselineReason }

export interface NewTurnWorktreeQuery {
  /** 回合开始时已纳入采集的仓库路径（open.captures 的 repository）。同一个 worktree 不能重复计入。 */
  captures: string[]
  workspaceRoot: string
  excluded: Set<string>
  /** 回合开始时间与收尾上限：只有 reflog 创建时间落在这个窗口内才算「本轮新建」。 */
  startedMs: number
  ceilingMs: number
}

/**
 * 没有 reflog 创建记录时的粗判依据：`<common>/worktrees/<name>` 目录由 `git worktree add` 建立，
 * 它的创建/修改时间不早于回合开始，才可能是本轮新建。取 birthtime/ctime/mtime 中最新的那个：
 * 误差只会让「可能是老的」被判成「可能本轮新建」（多一条 partial 说明），不会反过来把
 * 老 worktree 说成本轮新建，也不会漏掉真正新建的 worktree。
 */
async function worktreeDirActivityMs(gitDir: string): Promise<number | undefined> {
  const info = await stat(gitDir).catch(() => undefined)
  if (!info) return undefined
  const times = [info.birthtimeMs, info.ctimeMs, info.mtimeMs]
    .filter((value) => Number.isFinite(value) && value > 0)
  return times.length > 0 ? Math.max(...times) : undefined
}

/**
 * 收尾时发现「本轮新建的 worktree」。全部通过文件系统完成（读 `.git/worktrees/*`、reflog、
 * index 是否存在），hook 热路径不新增任何调用。
 *
 * 能证明「不是本轮新建」的（创建时间整秒都早于回合开始）静默跳过，不产出任何快照：
 * 采集范围内本来就有一些老 worktree 没进回合开始的基线，它们不该让每一轮 diff 都降级成 partial。
 * 只有可能是本轮新建、但拿不到可信基线的，才上报一条 unavailable 计划（带原因），且绝不生成 diff。
 */
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
  // 回合开始时间不可解析时不能把任何 worktree 当成「本轮新建」：那样等于凭空造基线。
  const windowStart = Number.isFinite(query.startedMs) ? query.startedMs : Number.POSITIVE_INFINITY
  const plans: NewWorktreeBaselinePlan[] = []
  for (const candidate of candidates) {
    const canonical = await realpath(candidate.root).catch(() => resolve(candidate.root))
    if (captured.has(canonical)) continue
    // 采集范围之外的新 worktree 不记录：不扩大回合开始时的采集范围。
    if (!withinCaptureScope(canonical, query.workspaceRoot, query.excluded)) continue
    const reflog = await readWorktreeCreation(candidate.gitDir)
    if ('problem' in reflog) {
      // 没有创建记录时只能用目录自身时间粗判：更早的活动时间就证明它在本轮开始前就存在。
      const activityMs = await worktreeDirActivityMs(candidate.gitDir)
      if (activityMs !== undefined && activityMs < windowStart) continue
      plans.push({ kind: 'unavailable', requestedRoot: canonical, reason: reflog.problem })
      continue
    }
    const { creation } = reflog
    // 毫秒精度的回合开始时间 vs 秒精度的 reflog：创建那一整秒都早于窗口开始，就证明不是本轮新建。
    if (creation.createdMs + REFLOG_SECOND_MS - 1 < windowStart) continue
    // 创建时间晚于收尾上限只可能来自时钟异常：可能是本轮新建，保留原因，不编造 diff。
    if (creation.createdMs > query.ceilingMs) {
      plans.push({ kind: 'unavailable', requestedRoot: canonical, reason: 'reflog_outside_turn' })
      continue
    }
    if (!(await stat(candidate.root).catch(() => undefined))) {
      plans.push({ kind: 'unavailable', requestedRoot: canonical, reason: 'worktree_deleted' })
      continue
    }
    // `<root>/.git` 必须还指向本 worktree：缺了它就等于不再是一个独立仓库，Git 会向上解析到
    // 外层仓库，把整个 worktree 的文件算成新增。那种 diff 是编造出来的，只能记 partial。
    if (!(await stat(join(candidate.root, '.git')).catch(() => undefined))) {
      plans.push({ kind: 'unavailable', requestedRoot: canonical, reason: 'worktree_deleted' })
      continue
    }
    // `git worktree add --no-checkout` 不写 index，工作树因此没有确定的检出内容；
    // 把创建提交当成基线会把「未检出」说成「全部删除」。
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
  // 排序时把基线条目放在前面：后面的 32 条上报上限只会截掉「本来就没基线」的噪音，
  // 不能把一个已确认可采集的 worktree 连快照带原因一起丢掉。
  plans.sort((left, right) => left.kind === right.kind
    ? left.requestedRoot.localeCompare(right.requestedRoot)
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
  /** 本轮 captures 目录，新 capture 的临时对象库建在这里，随轮次清理。 */
  captureRoot: string
  excludedPaths: string[]
  events: TraceEvent[]
  patchExcludeBasenames?: string[]
  /** begin 阶段的 5 秒上限（保留给测试缩短）。 */
  deadlineMs?: number
  /** finish 阶段上限；缺省时沿用现有 finish 预算。 */
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

/**
 * 一个新建 worktree 的 diff：创建提交的树 → worktree 现在的状态（新提交 + 未提交改动 +
 * 未跟踪文件）。超时按现有 deadline 语义记 timeout，不拖住整轮收尾。
 */
export async function finishNewWorktreeBaseline(
  plan: NewWorktreeBaselinePlan,
  options: NewWorktreeBaselineOptions
): Promise<TurnDiffSnapshot> {
  const started = Date.now()
  if (plan.kind === 'unavailable') {
    return unavailableSnapshot(plan.requestedRoot, plan.reason, new Date(started).toISOString(), 0)
  }
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
    completePatches: true
  })
  return {
    ...snapshot,
    requestedRoot: snapshot.requestedRoot ?? plan.requestedRoot,
    baselineSource: 'worktree-creation-reflog',
    baselineStatus: 'available',
    baselineCommit: plan.baseline.commit,
    baselineCreatedAt: plan.baseline.at
  }
}
