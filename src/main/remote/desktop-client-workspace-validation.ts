import type { ScRead } from '../../shared/source-control'
import type {
  WorkspaceBranchChoice,
  WorkspaceBranchRef,
  WorkspaceChoices,
  WorkspaceChoicesRequest,
  WorkspaceWorktreeChoice
} from '../../shared/workspace-selection'
import { fail, HASH, MAX_ITEMS, record, text } from './desktop-client-validation'

function scReason(value: unknown): string {
  if (!record(value) || !text(value.reason, 16_384)) fail('invalid_workspace_response')
  return value.reason
}

function gitHash(value: unknown): string {
  if (!text(value, 64) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail('invalid_workspace_response')
  return value
}

function branchRef(value: unknown): WorkspaceBranchRef {
  if (!record(value) || (value.kind !== 'local' && value.kind !== 'remote') || !text(value.name, 1024)) fail('invalid_workspace_response')
  if (!value.name.startsWith(value.kind === 'local' ? 'refs/heads/' : 'refs/remotes/')) fail('invalid_workspace_response')
  return { kind: value.kind, name: value.name, head: gitHash(value.head) }
}

function branchChoice(value: unknown): WorkspaceBranchChoice {
  const ref = branchRef(value)
  if (!record(value) || !Array.isArray(value.worktreeIds) || value.worktreeIds.length > MAX_ITEMS ||
      value.worktreeIds.some((id) => !text(id, 24) || !/^[a-f0-9]{24}$/.test(id))) fail('invalid_workspace_response')
  return { ...ref, worktreeIds: [...value.worktreeIds] as string[] }
}

function nullableString(value: unknown, max: number): string | null {
  if (value === null) return null
  if (!text(value, max)) fail('invalid_workspace_response')
  return value
}

function worktreeChoice(value: unknown): WorkspaceWorktreeChoice {
  if (!record(value) || !text(value.id, 24) || !/^[a-f0-9]{24}$/.test(value.id) || !text(value.path, 16_384) ||
      typeof value.current !== 'boolean' || typeof value.busy !== 'boolean' || typeof value.bare !== 'boolean') fail('invalid_workspace_response')
  return {
    id: value.id, path: value.path,
    branchRef: nullableString(value.branchRef, 1024),
    head: value.head === null ? null : gitHash(value.head),
    current: value.current, busy: value.busy, bare: value.bare,
    locked: nullableString(value.locked, 4096), prunable: nullableString(value.prunable, 4096)
  }
}

export function workspaceChoicesRead(value: unknown): ScRead<WorkspaceChoices> {
  if (!record(value) || !['available', 'unavailable', 'failed'].includes(String(value.status))) fail('invalid_workspace_choices_response')
  if (value.status !== 'available') return { status: value.status, reason: scReason(value) } as ScRead<WorkspaceChoices>
  const data = value.data
  if (!record(data) || !HASH.test(String(data.repositoryId)) || !text(data.root, 16_384) || !HASH.test(String(data.revision)) ||
      (data.branch !== null && !text(data.branch, 1024)) || (data.head !== null && data.head !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(data.head))) ||
      typeof data.dirty !== 'boolean' || (data.writeBlocker !== null && !text(data.writeBlocker, 16_384)) ||
      typeof data.commonDirBusy !== 'boolean' || typeof data.observedAt !== 'number' || !Number.isFinite(data.observedAt) || data.observedAt < 0 ||
      !record(data.page) || (data.page.kind !== 'branches' && data.page.kind !== 'worktrees') || !Array.isArray(data.page.items) ||
      data.page.items.length > MAX_ITEMS || typeof data.limited !== 'boolean') fail('invalid_workspace_choices_response')
  let nextCursor: WorkspaceChoicesRequest['cursor'] | null = null
  if (data.nextCursor !== null) {
    if (!record(data.nextCursor) || !text(data.nextCursor.revision, 24) || !/^[a-f0-9]{24}$/.test(data.nextCursor.revision) ||
        !Number.isSafeInteger(data.nextCursor.offset) || (data.nextCursor.offset as number) < 0 || (data.nextCursor.offset as number) > 1_000) fail('invalid_workspace_choices_response')
    nextCursor = { revision: data.nextCursor.revision, offset: data.nextCursor.offset as number }
  }
  return { status: 'available', data: {
    repositoryId: data.repositoryId as string, root: data.root as string, revision: data.revision as string,
    branch: data.branch as string | null, head: data.head == null ? null : String(data.head), dirty: data.dirty,
    writeBlocker: data.writeBlocker as string | null, commonDirBusy: data.commonDirBusy, observedAt: data.observedAt,
    ...(data.defaultBase === undefined ? {} : { defaultBase: branchRef(data.defaultBase) }),
    ...(data.selectedWorktree === undefined ? {} : { selectedWorktree: worktreeChoice(data.selectedWorktree) }),
    page: data.page.kind === 'branches'
      ? { kind: 'branches', items: data.page.items.map(branchChoice) }
      : { kind: 'worktrees', items: data.page.items.map(worktreeChoice) },
    nextCursor, limited: data.limited
  } }
}

export function workspaceBranchRead(value: unknown): ScRead<{ name: string }> {
  if (!record(value) || !['available', 'unavailable', 'failed'].includes(String(value.status))) fail('invalid_workspace_branch_response')
  if (value.status !== 'available') return { status: value.status, reason: scReason(value) } as ScRead<{ name: string }>
  if (!record(value.data) || !text(value.data.name, 240)) fail('invalid_workspace_branch_response')
  return { status: 'available', data: { name: value.data.name } }
}
