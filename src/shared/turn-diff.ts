import { type ToolContent, isToolContent } from './tool-content.js'
import { normalizeTurnRepositoryLocation, type TurnRepositoryLocation } from './turn-repository-location.js'


export type DiffFileChange = 'added' | 'modified' | 'deleted'

export interface DiffFile {
  path: string
  added: number
  deleted: number
  change?: DiffFileChange
  binary?: boolean
  patch?: string
  patchContent?: ToolContent
  patchStatus?: TurnDiffPatchStatus
  patchReason?: TurnDiffPatchReason
}

export type TurnDiffStatus = 'captured' | 'unavailable' | 'timeout' | 'failed'
export type TurnDiffReason = 'not_git' | 'no_head' | 'deadline' | 'git_error' | 'no_baseline'

export type WorkspaceDiffResult = (
  | { status: 'captured'; files: DiffFile[] }
  | { status: Exclude<TurnDiffStatus, 'captured'>; reason: TurnDiffReason | 'request_failed' | 'workspace_limit' | 'workspace_attributes' | 'workspace_file_type' | 'workspace_index' | 'workspace_submodule'; files: [] }
) & { collectedAt?: string }

export const TURN_DIFF_STAGE = 'turn_diff'
export const SESSION_DIFF_STAGE = 'session_diff'
export const TURN_DIFF_PREVIEW_STAGE = 'turn_diff_preview'
export const SESSION_DIFF_PREVIEW_STAGE = 'session_diff_preview'

export function isDiffSnapshotStage(stage: string): boolean {
  return (
    stage === TURN_DIFF_STAGE ||
    stage === SESSION_DIFF_STAGE ||
    stage === TURN_DIFF_PREVIEW_STAGE ||
    stage === SESSION_DIFF_PREVIEW_STAGE
  )
}

export function isDiffPreviewStage(stage: string): boolean {
  return stage === TURN_DIFF_PREVIEW_STAGE || stage === SESSION_DIFF_PREVIEW_STAGE
}

export type TurnDiffBaselineOrigin = 'session_start' | 'resumed'
export type WorktreeBaselineReason =
  | 'reflog_missing'
  | 'reflog_creation_not_first'
  | 'reflog_outside_turn'
  | 'worktree_deleted'
  | 'no_checkout'
  | 'capture_failed'
  | 'per_turn_limit'
export const WORKTREE_BASELINE_REASONS: readonly WorktreeBaselineReason[] = [
  'reflog_missing',
  'reflog_creation_not_first',
  'reflog_outside_turn',
  'worktree_deleted',
  'no_checkout',
  'capture_failed',
  'per_turn_limit'
]
export type TurnDiffPatchStatus = 'captured' | 'truncated' | 'binary' | 'unavailable'
export type TurnDiffPatchReason = 'deadline' | 'git_error' | 'budget' | 'policy'
export type TurnDiffFallbackReason = 'forced' | 'discovery_failed' | 'candidate_limit' | 'git_semantics' | 'targeted_failed'

export interface TurnDiffCollection {
  strategy: 'targeted' | 'full_fallback' | 'unchanged'
  evidence: 'git_status' | 'git_status+structured' | 'fallback'
  candidatePathCount: number
  discoveryMs: number
  targetedMs?: number
  fallbackMs?: number
  fallbackReason?: TurnDiffFallbackReason
  sharedAfter?: 'turn'
}

export interface WorkspaceOverlapEvidence {
  coverage: 'observed' | 'partial'
  runIds: string[]
  observedFrom: string
  observedTo: string
  truncated?: true
}

export const MAX_WORKSPACE_OVERLAP_RUN_IDS = 64

export function normalizeWorkspaceOverlap(value: unknown): WorkspaceOverlapEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (raw.coverage !== 'observed' && raw.coverage !== 'partial') return undefined
  if (typeof raw.observedFrom !== 'string' || !raw.observedFrom) return undefined
  if (typeof raw.observedTo !== 'string' || !raw.observedTo) return undefined
  const observedFrom = Date.parse(raw.observedFrom)
  const observedTo = Date.parse(raw.observedTo)
  if (!Number.isFinite(observedFrom) || !Number.isFinite(observedTo) || observedFrom > observedTo) return undefined
  if (!Array.isArray(raw.runIds)) return undefined
  const runIds = raw.runIds.flatMap((entry): string[] =>
    typeof entry === 'string' && entry.length > 0 && entry.length <= 128 ? [entry] : [])
  if (runIds.length !== raw.runIds.length) return undefined
  const unique = [...new Set(runIds)]
  return {
    coverage: raw.coverage,
    runIds: unique.slice(0, MAX_WORKSPACE_OVERLAP_RUN_IDS),
    observedFrom: raw.observedFrom,
    observedTo: raw.observedTo,
    ...(raw.truncated === true || unique.length > MAX_WORKSPACE_OVERLAP_RUN_IDS ? { truncated: true as const } : {})
  }
}

export interface TurnDiffSnapshot {
  repositoryLocation?: TurnRepositoryLocation
  version: 1
  status: TurnDiffStatus
  reason?: TurnDiffReason
  files: DiffFile[]
  repoRoot?: string
  requestedRoot?: string
  scope?: string
  beforeAt: string
  afterAt: string
  captureMs: number
  cleanup: 'ok' | 'failed'
  collection?: TurnDiffCollection
  baseline?: TurnDiffBaselineOrigin
  baselineSource?: 'worktree-creation-reflog'
  baselineStatus?: 'available' | 'partial'
  baselineCommit?: string
  baselineCreatedAt?: string
  baselineReason?: WorktreeBaselineReason
  workspaceOverlap?: WorkspaceOverlapEvidence
  diffExclude?: TurnDiffExcludeEvidence
}

export interface TurnDiffExcludeEvidence {
  paths: string[]
  files: number
}



export function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

export function normalizeTurnDiffSnapshot(value: unknown): TurnDiffSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) return undefined
  if (raw.requestedRoot !== undefined && (typeof raw.requestedRoot !== 'string' || raw.requestedRoot.length === 0)) return undefined
  if (!['captured', 'unavailable', 'timeout', 'failed'].includes(String(raw.status))) return undefined
  if (!Array.isArray(raw.files) || typeof raw.beforeAt !== 'string' || typeof raw.afterAt !== 'string') return undefined
  const captureMs = nonNegativeInteger(raw.captureMs)
  if (captureMs == null || (raw.cleanup !== 'ok' && raw.cleanup !== 'failed')) return undefined
  const files = raw.files.flatMap((entry): DiffFile[] => {
    if (!entry || typeof entry !== 'object') return []
    const file = entry as Record<string, unknown>
    const added = nonNegativeInteger(file.added)
    const deleted = nonNegativeInteger(file.deleted)
    if (typeof file.path !== 'string' || !file.path || added == null || deleted == null) return []
    const binary = file.binary === true
    const change = ['added', 'modified', 'deleted'].includes(String(file.change))
      ? (file.change as DiffFileChange)
      : undefined
    const patch = typeof file.patch === 'string' && file.patch.length > 0 && file.patch.length <= 1_100_000 ? file.patch : undefined
    const patchContent = isToolContent(file.patchContent) ? file.patchContent : undefined
    const patchStatus = ['captured', 'truncated', 'binary', 'unavailable'].includes(String(file.patchStatus))
      ? (file.patchStatus as TurnDiffPatchStatus)
      : undefined
    const patchReason = ['deadline', 'git_error', 'budget', 'policy'].includes(String(file.patchReason))
      ? (file.patchReason as TurnDiffPatchReason)
      : undefined
    const patchFields =
      (patchStatus === 'captured' || patchStatus === 'truncated') && (patch || patchContent?.contentRef)
        ? { ...(patch ? { patch } : {}), ...(patchContent ? { patchContent } : {}), patchStatus }
        : patchStatus === 'binary' && binary
          ? { patchStatus }
          : patchStatus === 'unavailable' && patchReason
            ? { patchStatus, patchReason }
            : {}
    return [{ path: file.path, added, deleted, ...(change ? { change } : {}), ...(binary ? { binary: true } : {}), ...patchFields }]
  })
  const reason = ['not_git', 'no_head', 'deadline', 'git_error', 'no_baseline'].includes(String(raw.reason))
    ? (raw.reason as TurnDiffReason)
    : undefined
  const collectionRaw = raw.collection && typeof raw.collection === 'object'
    ? raw.collection as Record<string, unknown>
    : undefined
  const candidatePathCount = nonNegativeInteger(collectionRaw?.candidatePathCount)
  const discoveryMs = nonNegativeInteger(collectionRaw?.discoveryMs)
  const targetedMs = nonNegativeInteger(collectionRaw?.targetedMs)
  const fallbackMs = nonNegativeInteger(collectionRaw?.fallbackMs)
  const fallbackReason = ['forced', 'discovery_failed', 'candidate_limit', 'git_semantics', 'targeted_failed']
    .includes(String(collectionRaw?.fallbackReason))
    ? collectionRaw?.fallbackReason as TurnDiffFallbackReason
    : undefined
  const collectionShapeValid =
    (collectionRaw?.strategy === 'targeted' &&
      (collectionRaw.evidence === 'git_status' || collectionRaw.evidence === 'git_status+structured') &&
      fallbackReason == null) ||
    (collectionRaw?.strategy === 'unchanged' &&
      collectionRaw.evidence === 'git_status' &&
      fallbackReason == null) ||
    (collectionRaw?.strategy === 'full_fallback' &&
      collectionRaw.evidence === 'fallback' &&
      fallbackReason != null)
  const collection =
    collectionRaw &&
    collectionShapeValid &&
    candidatePathCount != null &&
    discoveryMs != null
      ? {
          strategy: collectionRaw.strategy as TurnDiffCollection['strategy'],
          evidence: collectionRaw.evidence as TurnDiffCollection['evidence'],
          candidatePathCount,
          discoveryMs,
          ...(targetedMs != null ? { targetedMs } : {}),
          ...(fallbackMs != null ? { fallbackMs } : {}),
          ...(fallbackReason ? { fallbackReason } : {}),
          ...(collectionRaw.sharedAfter === 'turn' ? { sharedAfter: 'turn' as const } : {})
        }
      : undefined
  const baseline = raw.baseline === 'session_start' || raw.baseline === 'resumed'
    ? (raw.baseline as TurnDiffBaselineOrigin)
    : undefined
  const baselineCommit = typeof raw.baselineCommit === 'string' && /^[0-9a-f]{40}$/.test(raw.baselineCommit)
    ? raw.baselineCommit
    : undefined
  const baselineCreatedMs = typeof raw.baselineCreatedAt === 'string' ? Date.parse(raw.baselineCreatedAt) : NaN
  const baselineCreatedAt = Number.isFinite(baselineCreatedMs) ? new Date(baselineCreatedMs).toISOString() : undefined
  const baselineReason = WORKTREE_BASELINE_REASONS.find((reason) => reason === raw.baselineReason)
  const worktreeBaseline = raw.baselineSource !== 'worktree-creation-reflog'
    ? undefined
    : raw.baselineStatus === 'available' && baselineCommit && baselineCreatedAt
      ? { baselineStatus: 'available' as const, baselineCommit, baselineCreatedAt }
      : raw.baselineStatus === 'partial' && baselineReason
        ? { baselineStatus: 'partial' as const, baselineReason }
        : undefined
  const workspaceOverlap = normalizeWorkspaceOverlap(raw.workspaceOverlap)
  const diffExclude = normalizeDiffExcludeEvidence(raw.diffExclude)
  const repositoryLocation = normalizeTurnRepositoryLocation(raw.repositoryLocation)
  return {
    version: 1,
    status: raw.status as TurnDiffStatus,
    ...(reason ? { reason } : {}),
    files,
    ...(typeof raw.repoRoot === 'string' ? { repoRoot: raw.repoRoot } : {}),
    ...(typeof raw.requestedRoot === 'string' ? { requestedRoot: raw.requestedRoot } : {}),
    ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
    beforeAt: raw.beforeAt,
    afterAt: raw.afterAt,
    captureMs,
    cleanup: raw.cleanup,
    ...(collection ? { collection } : {}),
    ...(baseline ? { baseline } : {}),
    ...(worktreeBaseline ? { baselineSource: 'worktree-creation-reflog' as const, ...worktreeBaseline } : {}),
    ...(workspaceOverlap ? { workspaceOverlap } : {}),
    ...(diffExclude ? { diffExclude } : {}),
    ...(repositoryLocation ? { repositoryLocation } : {})
  }
}

function normalizeDiffExcludeEvidence(value: unknown): TurnDiffExcludeEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const files = nonNegativeInteger(raw.files)
  if (!Array.isArray(raw.paths) || files == null || files === 0) return undefined
  const paths = raw.paths.flatMap((item): string[] =>
    typeof item === 'string' && item.length > 0 && item.length <= 1024 ? [item] : [])
  return paths.length ? { paths, files } : undefined
}
