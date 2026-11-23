import type { WorkspaceCheckoutProgress, WorkspacePrepareProgress, WorkspacePrepareStage } from './workspace-selection'

// One parser for managed-worktree preparation progress, used where it crosses a trust
// boundary: the host reading its own run_progress marker before projecting it, and a
// paired desktop reading the projected row or hint. Anything malformed is dropped.

const STAGES: ReadonlySet<string> = new Set([
  'preparing', 'checking_out', 'verifying', 'cancelling', 'cancelled', 'completed', 'failed'
])
const HASH = /^[a-f0-9]{64}$/

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}

export function parseWorkspacePrepareProgress(value: unknown): WorkspacePrepareProgress | undefined {
  if (!record(value)) return undefined
  if (!text(value.operationId, 64) || typeof value.repositoryId !== 'string' || !HASH.test(value.repositoryId)) return undefined
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
    ...(text(value.branch, 256) ? { branch: value.branch } : {}),
    ...(text(value.baseRef, 256) ? { baseRef: value.baseRef } : {}),
    ...(text(value.message, 512) ? { message: value.message } : {}),
    updatedAt: Number(value.updatedAt)
  }
}

/** Admission ends preparation: the Provider has launched and nothing is left to cancel. */
export function completedWorkspaceProgress(progress: WorkspacePrepareProgress): WorkspacePrepareProgress {
  return { ...progress, stage: 'completed', cancellable: false }
}
