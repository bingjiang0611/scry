import type { WorkspaceCheckoutProgress, WorkspacePrepareProgress, WorkspacePrepareStage } from './workspace-selection.js'
import type { WorkspaceBranchRef, WorkspaceIntent, WorkspaceStartSelection } from './workspace-selection.js'

export const workspaceOperationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效工作区选择')
  return value as Record<string, unknown>
}
function text(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0'))
    throw new Error('无效工作区选择字段')
  return value
}
function hash(value: unknown, size: number): string {
  const result = text(value, size)
  if (result.length !== size || !/^[a-f0-9]+$/.test(result)) throw new Error('工作区引用已损坏，请重新选择')
  return result
}
function branch(value: unknown): WorkspaceBranchRef {
  const input = object(value)
  if (input.kind !== 'local' && input.kind !== 'remote') throw new Error('无效分支类型')
  const name = text(input.name)
  const head = text(input.head, 64)
  if (!name.startsWith(input.kind === 'local' ? 'refs/heads/' : 'refs/remotes/') ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error('无效分支引用')
  return { kind: input.kind, name, head }
}

export function parseWorkspaceStartSelection(value: unknown): WorkspaceStartSelection {
  const input = object(value)
  const operationId = text(input.operationId, 36).toLowerCase()
  if (!workspaceOperationIdPattern.test(operationId)) throw new Error('无效工作区准备操作标识')
  const selected = object(input.intent)
  const expected = {
    repositoryId: hash(selected.repositoryId, 64),
    expectedRevision: hash(selected.expectedRevision, 64)
  }
  let intent: WorkspaceIntent
  switch (selected.kind) {
    case 'current':
      intent = { ...expected, kind: 'current', ...(selected.branch === undefined ? {} : { branch: branch(selected.branch) }) }
      break
    case 'newWorktree':
      intent = { ...expected, kind: 'newWorktree', base: branch(selected.base), newBranch: text(selected.newBranch, 240) }
      break
    case 'existingWorktree':
      intent = { ...expected, kind: 'existingWorktree', worktreeId: hash(selected.worktreeId, 24) }
      break
    default:
      throw new Error('不支持的工作区选择')
  }
  return { operationId, intent }
}


const STAGES: ReadonlySet<string> = new Set([
  'preparing', 'checking_out', 'verifying', 'cancelling', 'cancelled', 'completed', 'failed'
])
const HASH = /^[a-f0-9]{64}$/

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isProgressText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}

export function parseWorkspacePrepareProgress(value: unknown): WorkspacePrepareProgress | undefined {
  if (!record(value)) return undefined
  if (!isProgressText(value.operationId, 64) || typeof value.repositoryId !== 'string' || !HASH.test(value.repositoryId)) return undefined
  if (typeof value.stage !== 'string' || !STAGES.has(value.stage)) return undefined
  if (typeof value.workspacePrepared !== 'boolean' || typeof value.cancellable !== 'boolean') return undefined
  if (!Number.isFinite(value.updatedAt)) return undefined
  let checkout: WorkspaceCheckoutProgress | undefined
  if (value.checkout !== undefined) {
    if (!record(value.checkout)) return undefined
    const { completed, total, percent } = value.checkout
    if (
      typeof completed !== 'number' || !Number.isSafeInteger(completed) || completed < 0 ||
      typeof total !== 'number' || !Number.isSafeInteger(total) || total <= 0 || completed > total ||
      typeof percent !== 'number' || !Number.isSafeInteger(percent) || percent < 0 || percent > 100
    ) return undefined
    checkout = { completed, total, percent }
  }
  const details: string[] = []
  if (Array.isArray(value.details)) {
    for (const entry of value.details.slice(-40)) {
      if (typeof entry === 'string' && !entry.includes('\0')) details.push(entry.slice(0, 300))
    }
  }
  return {
    operationId: value.operationId,
    repositoryId: value.repositoryId,
    stage: value.stage as WorkspacePrepareStage,
    workspacePrepared: value.workspacePrepared,
    ...(checkout ? { checkout } : {}),
    cancellable: value.cancellable,
    details,
    ...(isProgressText(value.branch, 256) ? { branch: value.branch } : {}),
    ...(isProgressText(value.baseRef, 256) ? { baseRef: value.baseRef } : {}),
    ...(isProgressText(value.message, 512) ? { message: value.message } : {}),
    updatedAt: Number(value.updatedAt)
  }
}

export function completedWorkspaceProgress(progress: WorkspacePrepareProgress): WorkspacePrepareProgress {
  return { ...progress, stage: 'completed', cancellable: false }
}
