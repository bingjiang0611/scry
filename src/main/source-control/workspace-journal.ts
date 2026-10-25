import { isAbsolute } from 'node:path'
import type { PreparedWorkspace, WorkspaceStartStatus } from '../../shared/workspace-selection'

export interface WorkspacePlan {
  cwd: string
  head: string | null
  branchRef: string | null
  worktreeId: string
  write: 'none' | 'switch' | 'create'
}

export interface WorkspaceJournal {
  phase: WorkspaceStartStatus['phase']
  plan: WorkspacePlan
  prepared?: PreparedWorkspace
  launch?: { commandId: string; requestHash: string; runId: string }
}

/** Corrupt recovery state must block writes, not fall through to another creation. */
export function assertWorkspaceJournal(value: unknown): asserts value is WorkspaceJournal {
  if (!value || typeof value !== 'object') throw new Error('缺少工作区准备日志')
  const journal = value as Partial<WorkspaceJournal>
  const plan = journal.plan
  if (!['planned', 'git_requested', 'prepared', 'start_requested', 'registered'].includes(journal.phase ?? '') ||
    !plan || typeof plan.cwd !== 'string' || !isAbsolute(plan.cwd) || plan.cwd.includes('\0') ||
    !['none', 'switch', 'create'].includes(plan.write) ||
    (plan.write !== 'none' && (!plan.head || !plan.branchRef)) ||
    !/^[a-f0-9]{24}$/.test(plan.worktreeId) ||
    !(plan.head === null || typeof plan.head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(plan.head)) ||
    !(plan.branchRef === null || typeof plan.branchRef === 'string' && plan.branchRef.startsWith('refs/heads/')))
    throw new Error('工作区准备日志损坏；不能重复执行')
  if (['prepared', 'start_requested', 'registered'].includes(journal.phase!)) {
    const target = journal.prepared
    if (!target || target.cwd !== plan.cwd || target.head !== plan.head ||
      target.branchRef !== plan.branchRef || target.worktreeId !== plan.worktreeId ||
      !/^[a-f0-9]{64}$/.test(target.repositoryId) || typeof target.operationId !== 'string')
      throw new Error('工作区目标日志不完整')
  }
  if (journal.phase === 'start_requested' || journal.phase === 'registered') {
    if (!journal.launch || !/^[a-f0-9]{64}$/.test(journal.launch.requestHash) ||
      !/^[A-Za-z0-9_:-]{8,128}$/.test(journal.launch.commandId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(journal.launch.runId))
      throw new Error('工作区启动日志不完整')
  }
}
