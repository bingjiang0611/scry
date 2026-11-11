import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { TraceEvent, TurnDiffSnapshot } from '../../shared/trace.js'
import { captureExcludedNames, type RecorderEnablement } from './config.js'
import { findNewTurnWorktrees, finishNewWorktreeBaseline } from './git-worktree-baseline.js'
import { TERMINAL_CLOCK_SKEW_MS } from './recorder-contracts.js'
import {
  recorderSessionRoot as sessionRoot,
  recorderTurnRoot as turnRoot,
  type RecorderOpenTurnState as OpenTurnState
} from './runtime-state.js'

/**
 * 本轮新建 worktree 的 diff。发现只读文件系统（`.git/worktrees/*`、reflog、index 是否存在），
 * 基线只来自创建记录的提交；没有可信基线时只报 unavailable + 原因，不生成 diff。
 *
 * 只由收尾调用：hook 热路径不新增任何调用。
 */
export async function newWorktreeTurnDiffs(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: OpenTurnState,
  events: TraceEvent[]
): Promise<TurnDiffSnapshot[]> {
  const root = sessionRoot(enablement.dataRoot, open.provider, open.sessionId)
  const workspaceRoot = await realpath(enablement.workspaceRoot).catch(() => enablement.workspaceRoot)
  const plans = await findNewTurnWorktrees({
    captures: open.captures.map(({ repository }) => repository),
    workspaceRoot,
    excluded: captureExcludedNames(enablement.config),
    startedMs: Date.parse(open.startedAt),
    ceilingMs: Date.now() + TERMINAL_CLOCK_SKEW_MS
  })
  if (plans.length === 0) return []
  const captureRoot = join(turnRoot(root, open.generation), 'captures')
  return Promise.all(plans.map((plan) => finishNewWorktreeBaseline(plan, {
    captureRoot,
    excludedPaths: [enablement.dataRoot],
    events,
    patchExcludeBasenames: enablement.config.capture.patchExcludeBasenames
  })))
}
