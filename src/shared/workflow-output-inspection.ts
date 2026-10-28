export const WORKFLOW_OUTPUT_INSPECTION_PAGE_SIZE = 8192
export type WorkflowOutputSelection =
  | Readonly<{ kind: 'attempt'; attemptId: string }>
  | Readonly<{ kind: 'system'; stepId: string; field: 'result' | 'stdout' | 'stderr' }>
  | Readonly<{ kind: 'frame'; frameId: string }>
export type WorkflowOutputInspectionRequest = Readonly<{
  workflowId: string
  programRevision: string
  selection: WorkflowOutputSelection
  offset?: number
  expectedContentHash?: string
}>
export type WorkflowOutputUnavailableReason =
  | 'root_missing' | 'source_changed' | 'selection_missing' | 'output_missing' | 'frame_missing'
  | 'value_unknown' | 'content_changed'
export type WorkflowOutputSourceRevision =
  | Readonly<{ state: 'available'; programRevision: string }>
  | Readonly<{ state: 'unavailable'; reason: 'missing_intent' }>
export type WorkflowOutputInspection =
  | Readonly<{
    state: 'unavailable'
    source: 'canonical_output'
    observedAt: number
    reason: WorkflowOutputUnavailableReason
    sourceRevision?: WorkflowOutputSourceRevision
    detail?: string
  }>
  | Readonly<{
    state: 'available'
    source: 'canonical_output'
    observedAt: number
    workflowId: string
    programRevision: string
    selection: WorkflowOutputSelection
    sourceRevision: WorkflowOutputSourceRevision
    contentKind: 'text' | 'json'
    /** SHA-256 of exact display UTF-16LE code units, not a file digest or authority. */
    contentHashEncoding: 'utf16le'
    contentHash: string
    offset: number
    total: number
    nextOffset?: number
    captureTruncated?: boolean
    content: string
  }>
