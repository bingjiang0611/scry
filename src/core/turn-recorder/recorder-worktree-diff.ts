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
    patchExcludeBasenames: enablement.config.capture.patchExcludeBasenames,
    diffExclude: [...(enablement.config.capture.diffExclude ?? []), ...(open.capture?.diffExclude ?? [])]
  })))
}
