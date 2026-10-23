import { mkdir, open, opendir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { workflowControlCopy, workflowFrameCopy, workflowRecoveryCopy } from '../shared/constants/copy'
import { withDirectoryLock } from '../core/turn-recorder/io'
import { nextWorkflowFrame, validateWorkflowFrame, validateWorkflowValueReference } from './workflow-frames'
import { assertWorkflowValue } from './workflow-expressions'
import { validateWorkflowOwnership, validateWorkflowClaim, workflowEpochMatches, workflowRecordFingerprint } from './workflow-recovery'
import { collectionDescriptor, collectionEntries, validateCollectionReference } from './workflow-collections'
import type { WorkflowAttemptOutcome, WorkflowCollectionEntry, WorkflowCollectionReference, WorkflowControlFrame, WorkflowEvaluation, WorkflowPlanPreview, WorkflowProgress, WorkflowValueReference } from '../shared/workflow'
import { WORKFLOW_MAX_STOP_REQUESTS, workflowProgressSnapshot } from '../shared/workflow'

export interface WorkflowIntent {
  workflowId: string
  programRevision: string
  taskId: string
  attemptId: string
  role: string
  providerId: string
  requestedModel?: string
  createdAt: number
}
export type WorkflowExecutionOwnership = {
  version: 2
  epoch: string
  owner: { pid: number; instanceId: string; state: 'active' | 'closed' }
  segments: Array<{ id: string; generationId?: string; commandId?: string; createdAt: number; mode: 'start' | 'continue' }>
}

export interface WorkflowStoreRecord {
  preview: WorkflowPlanPreview
  executionStarted?: number
  execution?: WorkflowExecutionOwnership
  /** Durable user intents only. Presence never proves a native signal or settlement. */
  stopRequests?: Array<{ commandId: string; requestedAt: number }>
  receipt?: { commandId: string; fingerprint: string; status: 'accepted' | 'completed' | 'failed' | 'unknown' }
  progress: WorkflowProgress
  intents: WorkflowIntent[]
  outcomes: WorkflowAttemptOutcome[]
}
export interface WorkflowPlanningIntent {
  workflowId: string
  commandId?: string
  command?: string
  fingerprint?: string
  role: string
  providerId: string
  agentProfileId?: string
  requestedModel?: string
  workspace: string
  goal: string
  createdAt: number
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'unknown' | 'stopped'
  scopeSettled?: boolean
  providerDispatch?: 'not_attempted'
  /** Durable shutdown/cancel intent. It does not prove planner settlement. */
  stopCommandId?: string
  stopRequestedAt?: number
  result?: { output?: string; outputRef?: string; actualModel?: string; archiveRef?: string }
  error?: string
}
export interface WorkflowStorePage { records: WorkflowStoreRecord[]; nextCursor?: string }
export interface WorkflowStore {
  create(record: WorkflowStoreRecord): Promise<boolean>
  save(record: WorkflowStoreRecord): Promise<void>
  claim(record: WorkflowStoreRecord, expectedFingerprint: string | undefined): Promise<void>
  loadOutput(workflowId: string, outcome: WorkflowAttemptOutcome): Promise<string | undefined>
  saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number): Promise<WorkflowControlFrame>
  loadFrame(workflowId: string, frameId: string): Promise<WorkflowControlFrame | undefined>
  saveValue(workflowId: string, key: string, evaluation: WorkflowEvaluation): Promise<WorkflowValueReference>
  loadValue(workflowId: string, reference: WorkflowValueReference): Promise<WorkflowEvaluation>
  saveCollection(workflowId: string, key: string, entries: WorkflowCollectionEntry[], sealed: boolean): Promise<WorkflowCollectionReference>
  loadCollection(workflowId: string, reference: WorkflowCollectionReference): Promise<WorkflowCollectionEntry[]>
  savePlanningIntent(intent: WorkflowPlanningIntent): Promise<void>
  loadPlanningIntent(workflowId: string): Promise<WorkflowPlanningIntent | undefined>
  planningIntents(): AsyncIterable<WorkflowPlanningIntent>
  /** Output bodies are immutable artifacts, not part of a history page. */
  load(workflowId: string): Promise<WorkflowStoreRecord | undefined>
  listPage(cursor?: string, limit?: number): Promise<WorkflowStorePage>
}
const fileSafe = (id: string): string => {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error('工作流记录身份无效')
  return id
}
const absent = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
const MAX_RECORD_BYTES = 8 * 1024 * 1024
const frameName = (id: string, frameId: string): string => `${fileSafe(id)}.${fileSafe(frameId)}.frame.json`
const valueName = (reference: WorkflowValueReference): string => `${fileSafe(reference.workflowId)}.${createHash('sha256').update(fileSafe(reference.key)).digest('hex')}.${reference.hash}.value.json`
const collectionName = (reference: WorkflowValueReference): string => valueName(reference).replace(/\.value\.json$/, '.collection.json')
function validateEvaluation(value: unknown, workflowId: string): asserts value is WorkflowEvaluation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(workflowFrameCopy.invalid)
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.derivedFrom) || !input.derivedFrom.every(item => typeof item === 'string' && item.length <= 512)) throw new Error(workflowFrameCopy.invalid)
  const allowed = input.state === 'known' ? ['state', 'value', 'derivedFrom', 'collection'] : ['state', 'reason', 'derivedFrom']
  if (Object.keys(input).some(key => !allowed.includes(key)) || (input.state === 'known' ? !Object.hasOwn(input, 'value') : input.state !== 'unknown' || typeof input.reason !== 'string' || !input.reason || input.reason.length > 4096)) throw new Error(workflowFrameCopy.invalid)
  if (input.state === 'known') {
    assertWorkflowValue(input.value)
    if (input.collection !== undefined) {
      validateCollectionReference(input.collection, workflowId)
      if (JSON.stringify(input.value) !== JSON.stringify(collectionDescriptor(input.collection))) throw new Error(workflowFrameCopy.invalid)
    }
  }
}

export class FileWorkflowStore implements WorkflowStore {
  private readonly directory: string
  private readonly outputs = new Map<string, true>()
  private readonly writes = new Map<string, Promise<void>>()
  constructor(userData: string) { this.directory = join(userData, 'workflows') }

  private async readText(name: string): Promise<string | undefined> {
    let handle
    try { handle = await open(join(this.directory, name), 'r') } catch (error) { if (absent(error)) return undefined; throw error }
    try {
      if ((await handle.stat()).size > MAX_RECORD_BYTES) throw new Error('工作流记录超过 8 MiB 读取上限')
      return await handle.readFile('utf8')
    } finally { await handle.close() }
  }

  private async readJson(name: string): Promise<unknown | undefined> {
    const text = await this.readText(name)
    return text === undefined ? undefined : JSON.parse(text) as unknown
  }

  private atomic(name: string, value: unknown): Promise<void> { return this.atomicText(name, JSON.stringify(value)) }

  private async atomicText(name: string, text: string): Promise<void> {
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error('工作流记录超过 8 MiB 写入上限')
    // Serialize per canonical target, and capture bytes before yielding. Later
    // snapshots cannot be overwritten by an earlier, slower rename.
    const prior = this.writes.get(name) ?? Promise.resolve()
    const write = prior.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true })
      const target = join(this.directory, name)
      const temporary = join(this.directory, `.workflow-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flush: true })
        await rename(temporary, target)
        const directory = await open(this.directory, 'r')
        try { await directory.sync() } finally { await directory.close() }
      } finally { await rm(temporary, { force: true }) }
    })
    this.writes.set(name, write)
    try { await write } finally { if (this.writes.get(name) === write) this.writes.delete(name) }
  }

  async saveValue(workflowId: string, key: string, evaluation: WorkflowEvaluation): Promise<WorkflowValueReference> {
    validateEvaluation(evaluation, workflowId)
    const text = JSON.stringify(evaluation)
    const reference = { workflowId: fileSafe(workflowId), key: fileSafe(key), hash: createHash('sha256').update(text).digest('hex') }
    const name = valueName(reference)
    if (!this.outputs.has(name)) {
      await this.atomicText(name, text)
      this.outputs.set(name, true)
      if (this.outputs.size > 1024) this.outputs.delete(this.outputs.keys().next().value!)
    }
    return reference
  }
  private async readEvaluation(workflowId: string, reference: WorkflowValueReference): Promise<WorkflowEvaluation> {
    validateWorkflowValueReference(reference, workflowId)
    const text = await this.readText(valueName(reference))
    if (text === undefined) throw new Error(workflowFrameCopy.missing)
    if (createHash('sha256').update(text).digest('hex') !== reference.hash) throw new Error(workflowFrameCopy.digest)
    const value: unknown = JSON.parse(text)
    validateEvaluation(value, workflowId)
    return value
  }
  async loadValue(workflowId: string, reference: WorkflowValueReference): Promise<WorkflowEvaluation> {
    const value = await this.readEvaluation(workflowId, reference)
    if (value.state === 'known' && value.collection) await this.loadCollection(workflowId, value.collection)
    return value
  }
  async saveCollection(workflowId: string, key: string, entries: WorkflowCollectionEntry[], sealed: boolean): Promise<WorkflowCollectionReference> {
    const data = { schemaVersion: 1, sealed, entries }
    collectionEntries(data, workflowId, entries.length, sealed)
    const text = JSON.stringify(data)
    const reference = { workflowId: fileSafe(workflowId), key: fileSafe(key), hash: createHash('sha256').update(text).digest('hex') }
    await this.atomicText(collectionName(reference), text)
    return { reference, count: entries.length, sealed }
  }
  async loadCollection(workflowId: string, reference: WorkflowCollectionReference): Promise<WorkflowCollectionEntry[]> {
    validateCollectionReference(reference, workflowId)
    const text = await this.readText(collectionName(reference.reference))
    if (text === undefined) throw new Error(workflowFrameCopy.missing)
    if (createHash('sha256').update(text).digest('hex') !== reference.reference.hash) throw new Error(workflowFrameCopy.digest)
    return collectionEntries(JSON.parse(text) as unknown, workflowId, reference.count, reference.sealed)
  }

  async loadFrame(workflowId: string, frameId: string): Promise<WorkflowControlFrame | undefined> {
    const frame = await this.readJson(frameName(workflowId, frameId))
    if (frame === undefined) return undefined
    validateWorkflowFrame(frame, workflowId, frameId)
    return frame
  }
  async saveFrame(input: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number): Promise<WorkflowControlFrame> {
    const name = frameName(input.workflowId, input.frameId)
    return withDirectoryLock(join(this.directory, 'locks', name + '.lock'), async () => {
      const next = nextWorkflowFrame(await this.loadFrame(input.workflowId, input.frameId), input, expectedRevision)
      await this.atomic(name, next)
      return next
    }, { requireDeadOwner: true })
  }

  async readConcurrency(): Promise<number | undefined> {
    const value = await this.readJson('settings.json')
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作流设置无效')
    const concurrency = (value as Record<string, unknown>).workflowConcurrency
    if (concurrency !== undefined && typeof concurrency !== 'number') throw new Error('工作流并发设置无效')
    return concurrency
  }

  async create(record: WorkflowStoreRecord): Promise<boolean> {
    const id = fileSafe(record.preview.workflowId)
    return withDirectoryLock(join(this.directory, 'roots', id + '.lock'), async () => {
      if (await this.load(id)) return false
      validateWorkflowOwnership(record)
      await this.writeRecord(record)
      return true
    }, { requireDeadOwner: true })
  }
  async claim(record: WorkflowStoreRecord, expectedFingerprint: string | undefined): Promise<void> {
    const id = fileSafe(record.preview.workflowId)
    await withDirectoryLock(join(this.directory, 'roots', id + '.lock'), async () => {
      const current = await this.load(id)
      if (workflowRecordFingerprint(current) !== expectedFingerprint) throw new Error(workflowRecoveryCopy.stale)
      validateWorkflowClaim(current, record)
      await this.writeRecord(record)
    }, { requireDeadOwner: true })
  }
  async save(record: WorkflowStoreRecord): Promise<void> {
    const id = fileSafe(record.preview.workflowId)
    await withDirectoryLock(join(this.directory, 'roots', id + '.lock'), async () => {
      workflowEpochMatches(await this.load(id), record)
      validateWorkflowOwnership(record)
      await this.writeRecord(record)
    }, { requireDeadOwner: true })
  }
  async loadOutput(workflowId: string, outcome: WorkflowAttemptOutcome): Promise<string | undefined> {
    if (outcome.outputRef === undefined) return undefined
    const match = new RegExp(`^${fileSafe(workflowId)}\\.${fileSafe(outcome.attemptId)}\\.([a-f0-9]{64})\\.output\\.json$`).exec(outcome.outputRef)
    if (!match) throw new Error(workflowRecoveryCopy.output)
    const data = await this.readJson(outcome.outputRef)
    if (!data || typeof data !== 'object' || !('output' in data) || typeof data.output !== 'string' || createHash('sha256').update(data.output).digest('hex') !== match[1]) throw new Error(workflowRecoveryCopy.output)
    return data.output
  }
  private async writeRecord(record: WorkflowStoreRecord): Promise<void> {
    const id = fileSafe(record.preview.workflowId)
    const snapshot = structuredClone(record)
    for (const outcome of snapshot.outcomes) {
      if (outcome.output === undefined) continue
      const digest = createHash('sha256').update(outcome.output).digest('hex')
      const name = `${id}.${fileSafe(outcome.attemptId)}.${digest}.output.json`
      if (!this.outputs.has(name)) {
        // Content addressing makes this artifact immutable. It is committed
        // before the root can reference it; an unreferenced file is not success.
        await this.atomic(name, { output: outcome.output })
        this.outputs.set(name, true)
        if (this.outputs.size > 1024) this.outputs.delete(this.outputs.keys().next().value!)
      }
      outcome.outputRef = name
      delete outcome.output
    }
    snapshot.progress = workflowProgressSnapshot(snapshot.progress)
    delete snapshot.progress.live
    await this.atomic(`${id}.json`, snapshot)
  }

  async savePlanningIntent(intent: WorkflowPlanningIntent): Promise<void> {
    const snapshot = structuredClone(intent)
    if (snapshot.result?.output !== undefined) {
      const text = snapshot.result.output
      const name = `${fileSafe(intent.workflowId)}.${createHash('sha256').update(text).digest('hex')}.plan.txt`
      await this.atomicText(name, text)
      delete snapshot.result.output
      snapshot.result.outputRef = name
    }
    // The artifact is already durable even if the following metadata write fails.
    // A failure receipt can preserve its reference without rewriting its body.
    if (snapshot.result) intent.result = snapshot.result
    await this.atomic(`${fileSafe(intent.workflowId)}.planning.json`, snapshot)
  }
  async loadPlanningIntent(id: string): Promise<WorkflowPlanningIntent | undefined> {
    const value = await this.readJson(`${fileSafe(id)}.planning.json`)
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || (value as WorkflowPlanningIntent).workflowId !== id) throw new Error('工作流规划记录已损坏')
    const intent = value as WorkflowPlanningIntent
    if ((intent.stopCommandId !== undefined && (typeof intent.stopCommandId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(intent.stopCommandId))) ||
      (intent.stopRequestedAt !== undefined && (typeof intent.stopRequestedAt !== 'number' || !Number.isFinite(intent.stopRequestedAt) || intent.stopRequestedAt < 0))) throw new Error(workflowControlCopy.invalidPlanningStopReceipt)
    return intent
  }
  async *planningIntents(): AsyncIterable<WorkflowPlanningIntent> {
    let directory
    try { directory = await opendir(this.directory) } catch (error) { if (absent(error)) return; throw error }
    // for-await closes its own directory, including on errors and early return.
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.planning.json')) continue
      const id = entry.name.slice(0, -14)
      const intent = await this.loadPlanningIntent(id)
      if (!intent) throw new Error('工作流规划记录在读取时消失')
      yield intent
    }
  }
  async load(id: string): Promise<WorkflowStoreRecord | undefined> {
    const value = await this.readJson(`${fileSafe(id)}.json`)
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object') throw new Error('工作流记录已损坏')
    const record = value as WorkflowStoreRecord
    validateWorkflowOwnership(record)
    if (record.preview?.workflowId !== id || record.progress?.workflowId !== id || !Array.isArray(record.intents) || !Array.isArray(record.outcomes)) throw new Error('工作流记录合同无效')
    if (record.stopRequests !== undefined && (!Array.isArray(record.stopRequests) || record.stopRequests.length > WORKFLOW_MAX_STOP_REQUESTS || record.stopRequests.some(request =>
      !request || typeof request.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(request.commandId) || !Number.isFinite(request.requestedAt) || request.requestedAt < 0) ||
      new Set(record.stopRequests.map(request => request.commandId)).size !== record.stopRequests.length)) throw new Error(workflowControlCopy.invalidStopReceipt)
    // Historical observations are not live authority, including files written
    // by an older or interrupted producer that accidentally persisted the field.
    delete record.progress.live
    return record
  }
  async listPage(cursor?: string, limit = 64): Promise<WorkflowStorePage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('工作流历史页大小无效')
    if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,96}\.json$/.test(cursor)) throw new Error('工作流历史游标无效')
    let directory
    try { directory = await opendir(this.directory) } catch (error) { if (absent(error)) return { records: [] }; throw error }
    const names: string[] = []
    for await (const entry of directory) {
      if (!entry.isFile() || !/^[A-Za-z0-9_-]{1,96}\.json$/.test(entry.name) || ['settings.json', 'preferences.json'].includes(entry.name)) continue
      if (cursor && entry.name <= cursor) continue
      names.push(entry.name)
      if (names.length > limit + 1) { names.sort(); names.splice(limit + 1) }
    }
    names.sort()
    const records: WorkflowStoreRecord[] = []
    for (const name of names.slice(0, limit)) {
      const record = await this.load(name.slice(0, -5))
      if (!record) throw new Error('工作流记录在读取时消失')
      records.push(record)
    }
    return { records, ...(names.length > limit ? { nextCursor: names[limit - 1] } : {}) }
  }
}

export class MemoryWorkflowStore implements WorkflowStore {
  private readonly records = new Map<string, WorkflowStoreRecord>()
  private readonly planning = new Map<string, WorkflowPlanningIntent>()
  private readonly frames = new Map<string, WorkflowControlFrame>()
  private readonly values = new Map<string, WorkflowEvaluation>()
  private readonly collections = new Map<string, string>()
  async saveValue(workflowId: string, key: string, evaluation: WorkflowEvaluation): Promise<WorkflowValueReference> {
    validateEvaluation(evaluation, workflowId)
    const text = JSON.stringify(evaluation)
    const reference = { workflowId: fileSafe(workflowId), key: fileSafe(key), hash: createHash('sha256').update(text).digest('hex') }
    this.values.set(valueName(reference), JSON.parse(text) as WorkflowEvaluation)
    return reference
  }
  async loadValue(workflowId: string, reference: WorkflowValueReference): Promise<WorkflowEvaluation> {
    validateWorkflowValueReference(reference, workflowId)
    const value = this.values.get(valueName(reference))
    if (!value) throw new Error(workflowFrameCopy.missing)
    if (value.state === 'known' && value.collection) await this.loadCollection(workflowId, value.collection)
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
  async claim(record: WorkflowStoreRecord, expectedFingerprint: string | undefined): Promise<void> {
    const id = record.preview.workflowId
    const current = this.records.get(id)
    if (workflowRecordFingerprint(current) !== expectedFingerprint) throw new Error(workflowRecoveryCopy.stale)
    validateWorkflowClaim(current, record)
    const snapshot = structuredClone(record)
    delete snapshot.progress.live
    this.records.set(id, snapshot)
  }
  async loadOutput(workflowId: string, outcome: WorkflowAttemptOutcome): Promise<string | undefined> {
    const stored = this.records.get(workflowId)?.outcomes.find(value => value.attemptId === outcome.attemptId && value.taskId === outcome.taskId)
    return stored?.output
  }
  async create(record: WorkflowStoreRecord): Promise<boolean> {
    if (this.records.has(record.preview.workflowId)) return false
    validateWorkflowOwnership(record)
    const snapshot = structuredClone(record)
    delete snapshot.progress.live
    this.records.set(record.preview.workflowId, snapshot)
    return true
  }
  async save(record: WorkflowStoreRecord): Promise<void> {
    workflowEpochMatches(this.records.get(record.preview.workflowId), record)
    validateWorkflowOwnership(record)
    const snapshot = structuredClone(record)
    delete snapshot.progress.live
    this.records.set(record.preview.workflowId, snapshot)
  }
  async savePlanningIntent(intent: WorkflowPlanningIntent): Promise<void> { this.planning.set(intent.workflowId, structuredClone(intent)) }
  async loadPlanningIntent(id: string): Promise<WorkflowPlanningIntent | undefined> { const value = this.planning.get(id); return value && structuredClone(value) }
  async *planningIntents(): AsyncIterable<WorkflowPlanningIntent> { for (const intent of this.planning.values()) yield structuredClone(intent) }
  async load(id: string): Promise<WorkflowStoreRecord | undefined> { const value = this.records.get(id); return value && structuredClone(value) }
  async listPage(cursor?: string, limit = 64): Promise<WorkflowStorePage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('工作流历史页大小无效')
    const ids = [...this.records.keys()].sort().filter(id => !cursor || id > cursor)
    const page = ids.slice(0, limit)
    return { records: page.map(id => structuredClone(this.records.get(id)!)), ...(ids.length > limit ? { nextCursor: page.at(-1) } : {}) }
  }
}
