export type WorkflowSourceApplicationState = 'applied' | 'rejected' | 'partial' | 'unknown'

export type WorkflowSourceApplicationTarget = Readonly<{
  workflowId: string
  programRevision: string
  workflowRevision: number
  stepId: string
  nodeId: string
}>

export type WorkflowSourceApplicationReview = WorkflowSourceApplicationTarget & Readonly<{
  baseHash: string
  candidateHash: string
  trustFingerprint: string
  changedPaths: readonly string[]
  check: 'recorded_passed'
}>

export type WorkflowSourceApplicationCatalog = Readonly<{
  workflowId: string
  programRevision: string
  workflowRevision: number
  reviewedAt: number
  items: readonly WorkflowSourceApplicationReview[]
  receipts: readonly WorkflowSourceApplicationReceipt[]
}>

export type WorkflowSourceApplicationCommand = Readonly<{
  operationId: string
  target: WorkflowSourceApplicationTarget
  expected: Pick<WorkflowSourceApplicationReview, 'baseHash' | 'candidateHash' | 'trustFingerprint'>
  confirmation: {
    acknowledgesSourceMutation: true
    acknowledgesNoAutomaticRollback: true
  }
}>

export type WorkflowSourceApplicationReceipt = Readonly<{
  operationId: string
  target: WorkflowSourceApplicationTarget
  requestFingerprint: string
  admissionFingerprint: string
  state: WorkflowSourceApplicationState
  requestedAt: number
  baseHash: string
  candidateHash: string
  trustFingerprint: string
  changedPaths?: readonly string[]
  reason?: string
}>
