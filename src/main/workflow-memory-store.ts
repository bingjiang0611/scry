
import { createHash } from 'node:crypto'

import { workflowFrameCopy, workflowRecoveryCopy } from '../shared/constants/copy'

import { nextWorkflowFrame, validateWorkflowValueReference } from './workflow-frames'

import { validateWorkflowOwnership, validateWorkflowClaim, validateWorkflowClassifierLedgerCanonical, workflowEpochMatches, workflowRecordFingerprint } from './workflow-recovery'
import { collectionEntries, validateCollectionReference } from './workflow-collections'
import type { WorkflowAttemptOutcome, WorkflowCollectionEntry, WorkflowCollectionReference, WorkflowControlFrame, WorkflowEvaluation, WorkflowValueReference } from '../shared/workflow'

import type { WorkflowFrameValueCheckpoint, WorkflowStore, WorkflowStoreRecord, WorkflowStorePage, WorkflowPlanningIntent } from './workflow-store-contracts'
import { fileSafe, MAX_RECORD_BYTES, frameName, valueName, collectionName, validateEvaluation, validateCollectionArtifacts } from './workflow-store-artifacts'
import { workflowSizeCopy } from '../shared/constants/copy'
import { isWorkflowSizeGuideline, type WorkflowSizeGuideline, type WorkflowSizeSnapshot } from '../shared/workflow-size'
import { resolveWorkflowSize, validatePlanningSize } from './workflow-size-guideline'
import { validateWorkflowStopRequests } from './workflow-stop'

export class MemoryWorkflowStore implements WorkflowStore {
  private preferences?: Record<string, unknown>
  async sizeGuideline(): Promise<WorkflowSizeSnapshot> {
    return resolveWorkflowSize(undefined, this.preferences && JSON.stringify(this.preferences)).snapshot
  }
  async setSizeGuideline(value: WorkflowSizeGuideline | null): Promise<WorkflowSizeSnapshot> {
    if (value !== null && !isWorkflowSizeGuideline(value)) throw new Error(workflowSizeCopy.invalidValue)
    this.preferences = value === null ? {} : { workflowSizeGuideline: value }
    return this.sizeGuideline()
  }
  private readonly records = new Map<string, WorkflowStoreRecord>()
  private readonly planning = new Map<string, WorkflowPlanningIntent>()
  private readonly frames = new Map<string, WorkflowControlFrame>()
  private readonly values = new Map<string, WorkflowEvaluation>()
  private readonly collections = new Map<string, string>()
  async saveValue(workflowId: string, key: string, evaluation: WorkflowEvaluation): Promise<WorkflowValueReference> {
    validateEvaluation(evaluation, workflowId)
    const text = JSON.stringify(evaluation)
    const reference = { workflowId: fileSafe(workflowId), key: fileSafe(key), hash: createHash('sha256').update(text).digest('hex') }
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error(workflowFrameCopy.invalid)
    this.values.set(valueName(reference), JSON.parse(text) as WorkflowEvaluation)
    return reference
  }
  async loadValue(workflowId: string, reference: WorkflowValueReference): Promise<WorkflowEvaluation> {
    validateWorkflowValueReference(reference, workflowId)
    const value = this.values.get(valueName(reference))
    if (!value) throw new Error(workflowFrameCopy.missing)
    await validateCollectionArtifacts(this, workflowId, value)
    return structuredClone(value)
  }
  async saveCollection(workflowId: string, key: string, entries: WorkflowCollectionEntry[], sealed: boolean): Promise<WorkflowCollectionReference> {
    const data = { schemaVersion: 1, sealed, entries }
    collectionEntries(data, workflowId, entries.length, sealed)
    const text = JSON.stringify(data)
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error(workflowFrameCopy.invalid)
    const reference = { workflowId: fileSafe(workflowId), key: fileSafe(key), hash: createHash('sha256').update(text).digest('hex') }
    this.collections.set(collectionName(reference), text)
    return { reference, count: entries.length, sealed }
  }
  async loadCollection(workflowId: string, reference: WorkflowCollectionReference): Promise<WorkflowCollectionEntry[]> {
    validateCollectionReference(reference, workflowId)
    const text = this.collections.get(collectionName(reference.reference))
    if (text === undefined) throw new Error(workflowFrameCopy.missing)
    return collectionEntries(JSON.parse(text) as unknown, workflowId, reference.count, reference.sealed)
  }
  async loadFrame(workflowId: string, frameId: string): Promise<WorkflowControlFrame | undefined> {
    const value = this.frames.get(frameName(workflowId, frameId))
    return value && structuredClone(value)
  }
  async saveFrame(input: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number): Promise<WorkflowControlFrame> {
    const key = frameName(input.workflowId, input.frameId)
    const next = nextWorkflowFrame(this.frames.get(key), input, expectedRevision)
    this.frames.set(key, next)
    return structuredClone(next)
  }
  async saveFrameWithValue(input: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number, checkpoint: WorkflowFrameValueCheckpoint): Promise<WorkflowControlFrame> {
    validateEvaluation(checkpoint.evaluation, input.workflowId)
    const text = JSON.stringify(checkpoint.evaluation)
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error(workflowFrameCopy.invalid)
    const reference = { workflowId: fileSafe(input.workflowId), key: fileSafe(checkpoint.key), hash: createHash('sha256').update(text).digest('hex') }
    const key = frameName(input.workflowId, input.frameId)
    const frame = { ...input, [checkpoint.field]: reference } as Omit<WorkflowControlFrame, 'revision'>
    const next = nextWorkflowFrame(this.frames.get(key), frame, expectedRevision)
    this.values.set(valueName(reference), JSON.parse(text) as WorkflowEvaluation)
    this.frames.set(key, next)
    return structuredClone(next)
  }
  async claim(record: WorkflowStoreRecord, expectedFingerprint: string | undefined): Promise<void> {
    const id = record.preview.workflowId
    const current = this.records.get(id)
    if (workflowRecordFingerprint(current) !== expectedFingerprint) throw new Error(workflowRecoveryCopy.stale)
    validateWorkflowClaim(current, record)
    const snapshot = this.snapshot(record)
    this.records.set(id, snapshot)
  }
  async loadOutput(workflowId: string, outcome: WorkflowAttemptOutcome): Promise<string | undefined> {
    const stored = this.records.get(workflowId)?.outcomes.find(value => value.attemptId === outcome.attemptId && value.taskId === outcome.taskId)
    return stored?.output
  }
  async create(record: WorkflowStoreRecord): Promise<boolean> {
    validateWorkflowStopRequests(record)
    if (this.records.has(record.preview.workflowId)) return false
    validateWorkflowOwnership(record)
    const snapshot = this.snapshot(record)
    this.records.set(record.preview.workflowId, snapshot)
    return true
  }
  async save(record: WorkflowStoreRecord): Promise<void> {
    validateWorkflowStopRequests(record)
    workflowEpochMatches(this.records.get(record.preview.workflowId), record)
    validateWorkflowOwnership(record)
    const snapshot = this.snapshot(record)
    this.records.set(record.preview.workflowId, snapshot)
  }
  private snapshot(record: WorkflowStoreRecord): WorkflowStoreRecord {
    // validateWorkflowOwnership freezes these governing parts before every
    // caller gets here. Keep private immutable references, not another full AST
    // copy per intent/frame write. Public loads still return independent clones.
    const { preview, revisions, ...journal } = record
    const { program, ...presentation } = preview
    const snapshot = revisions
      ? { ...structuredClone(journal), preview: { ...structuredClone(presentation), program }, revisions }
      : structuredClone(record)
    delete snapshot.progress.live
    return snapshot
  }
  async savePlanningIntent(intent: WorkflowPlanningIntent): Promise<void> {
    validatePlanningSize(intent, this.planning.get(intent.workflowId))
    this.planning.set(intent.workflowId, structuredClone(intent))
  }
  async loadPlanningIntent(id: string): Promise<WorkflowPlanningIntent | undefined> { const value = this.planning.get(id); return value && structuredClone(value) }
  async *planningIntents(): AsyncIterable<WorkflowPlanningIntent> { for (const intent of this.planning.values()) yield structuredClone(intent) }
  async load(id: string): Promise<WorkflowStoreRecord | undefined> {
    const value = this.records.get(id)
    if (!value) return undefined
    const record = structuredClone(value)
    await validateWorkflowClassifierLedgerCanonical(record, this, false)
    return record
  }
  async listPage(cursor?: string, limit = 64): Promise<WorkflowStorePage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('工作流历史页大小无效')
    const ids = [...this.records.keys()].sort().filter(id => !cursor || id > cursor)
    const page = ids.slice(0, limit)
    return { records: page.map(id => structuredClone(this.records.get(id)!)), ...(ids.length > limit ? { nextCursor: page.at(-1) } : {}) }
  }
}
