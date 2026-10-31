import { type ToolContent, isToolContent } from './tool-content.js'


// P2 Files & Diff（RFC §8.4）：最终 git diff 的每文件增删（绝对路径），与工具足迹对照。
export type DiffFileChange = 'added' | 'modified' | 'deleted'

export interface DiffFile {
  path: string
  added: number
  deleted: number
  change?: DiffFileChange
  binary?: boolean
  patch?: string
  /** Complete patch body plus a bounded inline preview. Absence is legacy or unavailable capture. */
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

// Diff 快照的四个 harness stage。`*_preview` 是运行中的临时快照（同一 Git capture 的非消费式重算），
// 终态 `turn_diff` / `session_diff` 一到达就在展示上取代它，且不写入会话 archive。
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

/**
 * 会话净 diff 的基线来源：`session_start` = 会话第一轮开始前捕获的原始基线；
 * `resumed` = 该基线在本进程内不存在（恢复/选择会话/重启后）而当场重锚，
 * 净 diff 只覆盖「自重锚以来」，UI 必须照实说明，不得冒充整段会话。
 */
export type TurnDiffBaselineOrigin = 'session_start' | 'resumed'
export type TurnDiffPatchStatus = 'captured' | 'truncated' | 'binary' | 'unavailable'
export type TurnDiffPatchReason = 'deadline' | 'git_error' | 'budget' | 'policy'
export type TurnDiffFallbackReason = 'forced' | 'discovery_failed' | 'candidate_limit' | 'git_semantics' | 'targeted_failed'

export interface TurnDiffCollection {
  strategy: 'targeted' | 'full_fallback'
  evidence: 'git_status' | 'git_status+structured' | 'fallback'
  candidatePathCount: number
  discoveryMs: number
  targetedMs?: number
  fallbackMs?: number
  fallbackReason?: TurnDiffFallbackReason
  /** The collection timings/path count belong to the turn's same-afterAt capture, not another scan. */
  sharedAfter?: 'turn'
}

/**
 * 同一 canonical cwd 上的并行运行观测。一次 before/after 采集只能证明「工作区变了」，
 * 不能证明是哪个 run 写的：共享工作区里另一个 run 的改动会同时进入本次采集。
 * 缺失该字段表示旧记录或没有被观测（不推出「独占」），`runIds` 为空且 coverage=observed
 * 只表示「在这次观测窗口里没有看到其他 Scry run」，不代表用户或外部编辑器的写入不存在。
 */
export interface WorkspaceOverlapEvidence {
  /** observed = 整个窗口都在本进程观测内；partial = 有观测记录被上限淘汰或窗口未覆盖。 */
  coverage: 'observed' | 'partial'
  /** 同 cwd、观测窗口与本次采集相交的其他 run ID（不含自己），按开始时间排序。 */
  runIds: string[]
  /** 本次采集的观测窗口：diff 基线建立 → 证据采集结束。 */
  observedFrom: string
  observedTo: string
  /** 达到 run ID 上报上限：可能还有更多重叠运行。 */
  truncated?: true
}

/** 上报的 run ID 上限；超过这个数必须带 truncated，不能静默少报。 */
export const MAX_WORKSPACE_OVERLAP_RUN_IDS = 64

/**
 * 归档/记录里的重叠证据归一化。
 *
 * 硬规则：能证明的才保留。时间必须可解析且构成有序窗口；run ID 超过上报上限时
 * 保留 truncated，而不是把「还有更多」悄悄抹成「就这些」。
 */
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
  version: 1
  status: TurnDiffStatus
  reason?: TurnDiffReason
  files: DiffFile[]
  repoRoot?: string
  /** Observed capture request directory, not proof of a resolved Git root. */
  requestedRoot?: string
  scope?: string
  beforeAt: string
  afterAt: string
  captureMs: number
  /** Releases this capture's ownership; a referenced shared store lives until its last peer releases it. */
  cleanup: 'ok' | 'failed'
  collection?: TurnDiffCollection
  /** 仅 session_diff / session_diff_preview 携带：净 diff 的基线是会话首轮前还是恢复后重锚。 */
  baseline?: TurnDiffBaselineOrigin
  /** 并行工作区重叠证据；缺失 = 旧记录或未观测，不能读成「独占归因」。 */
  workspaceOverlap?: WorkspaceOverlapEvidence
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
  const workspaceOverlap = normalizeWorkspaceOverlap(raw.workspaceOverlap)
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
    ...(workspaceOverlap ? { workspaceOverlap } : {})
  }
}
