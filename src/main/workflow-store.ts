import { mkdir, open, opendir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { workflowControlCopy, workflowFrameCopy, workflowRecoveryCopy } from '../shared/constants/copy'
import { withDirectoryLock } from '../core/turn-recorder/io'
import { nextWorkflowFrame, validateWorkflowFrame, validateWorkflowValueReference } from './workflow-frames'

import { validateWorkflowOwnership, validateWorkflowClaim, validateWorkflowClassifierLedgerCanonical, workflowEpochMatches, workflowRecordFingerprint } from './workflow-recovery'
import { collectionEntries, validateCollectionReference } from './workflow-collections'
import type { WorkflowAttemptOutcome, WorkflowCollectionEntry, WorkflowCollectionReference, WorkflowControlFrame, WorkflowEvaluation, WorkflowValueReference } from '../shared/workflow'
import { workflowProgressSnapshot } from '../shared/workflow'

import type { WorkflowFrameValueCheckpoint, WorkflowStore, WorkflowStoreRecord, WorkflowStorePage, WorkflowPlanningIntent } from './workflow-store-contracts'
import type { WorkflowSizeGuideline, WorkflowSizeSnapshot } from '../shared/workflow-size'
import { readWorkflowSize, updateWorkflowSize, validatePlanningSize } from './workflow-size-guideline'
import { validateWorkflowStopRequests } from './workflow-stop'
import { fileSafe, absent, MAX_RECORD_BYTES, frameName, valueName, collectionName, validateEvaluation, validateCollectionArtifacts, validatePlanningRoute } from './workflow-store-artifacts'
export * from './workflow-store-contracts'
export { MemoryWorkflowStore } from './workflow-memory-store'

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

  private async atomicText(name: string, text: string, options?: { deferDirectorySync?: boolean }): Promise<void> {
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
        if (!options?.deferDirectorySync) {
          const directory = await open(this.directory, 'r')
          try { await directory.sync() } finally { await directory.close() }
        }
      } finally { await rm(temporary, { force: true }) }
    })
    this.writes.set(name, write)
    try { await write } finally { if (this.writes.get(name) === write) this.writes.delete(name) }
  }

  private valueCheckpoint(workflowId: string, key: string, evaluation: WorkflowEvaluation): { text: string; reference: WorkflowValueReference; name: string } {
    validateEvaluation(evaluation, workflowId)
    const text = JSON.stringify(evaluation)
    const reference = { workflowId: fileSafe(workflowId), key: fileSafe(key), hash: createHash('sha256').update(text).digest('hex') }
    return { text, reference, name: valueName(reference) }
  }

  private rememberOutput(name: string): void {
    this.outputs.set(name, true)
    if (this.outputs.size > 1024) this.outputs.delete(this.outputs.keys().next().value!)
  }

  async saveValue(workflowId: string, key: string, evaluation: WorkflowEvaluation): Promise<WorkflowValueReference> {
    const checkpoint = this.valueCheckpoint(workflowId, key, evaluation)
    const { text, reference, name } = checkpoint
    if (!this.outputs.has(name)) {
      await this.atomicText(name, text)
      this.rememberOutput(name)
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
    await validateCollectionArtifacts(this, workflowId, value)
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
  private async withFrameLock(input: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number, publish: (name: string, next: WorkflowControlFrame) => Promise<void>): Promise<WorkflowControlFrame> {
    const name = frameName(input.workflowId, input.frameId)
    return withDirectoryLock(join(this.directory, 'locks', name + '.lock'), async () => {
      const next = nextWorkflowFrame(await this.loadFrame(input.workflowId, input.frameId), input, expectedRevision)
      await publish(name, next)
      return next
    }, { requireDeadOwner: true })
  }

  async saveFrame(input: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number): Promise<WorkflowControlFrame> {
    return this.withFrameLock(input, expectedRevision, (name, next) => this.atomic(name, next))
  }
  async saveFrameWithValue(input: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number, checkpoint: WorkflowFrameValueCheckpoint): Promise<WorkflowControlFrame> {
    const value = this.valueCheckpoint(input.workflowId, checkpoint.key, checkpoint.evaluation)
    const frame = { ...input, [checkpoint.field]: value.reference } as Omit<WorkflowControlFrame, 'revision'>
    return this.withFrameLock(frame, expectedRevision, async (name, next) => {
      if (!this.outputs.has(value.name)) await this.atomicText(value.name, value.text, { deferDirectorySync: true })
      await this.atomic(name, next)
      this.rememberOutput(value.name)
    })
  }

  async sizeGuideline(): Promise<WorkflowSizeSnapshot> { return (await readWorkflowSize(this.directory)).snapshot }
  async setSizeGuideline(value: WorkflowSizeGuideline | null): Promise<WorkflowSizeSnapshot> {
    return updateWorkflowSize(this.directory, value, text => this.atomicText('preferences.json', text))
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
    // Live committed outcomes still carry their body; disk snapshots carry only
    // its content address. Both must read the same durable, hash-checked artifact.
    const reference = outcome.outputRef ?? (outcome.output === undefined ? undefined
      : `${fileSafe(workflowId)}.${fileSafe(outcome.attemptId)}.${createHash('sha256').update(outcome.output).digest('hex')}.output.json`)
    if (reference === undefined) return undefined
    const match = new RegExp(`^${fileSafe(workflowId)}\\.${fileSafe(outcome.attemptId)}\\.([a-f0-9]{64})\\.output\\.json$`).exec(reference)
    if (!match) throw new Error(workflowRecoveryCopy.output)
    const data = await this.readJson(reference)
    if (!data || typeof data !== 'object' || !('output' in data) || typeof data.output !== 'string' || createHash('sha256').update(data.output).digest('hex') !== match[1]) throw new Error(workflowRecoveryCopy.output)
    return data.output
  }
  private async writeRecord(record: WorkflowStoreRecord): Promise<void> {
    validateWorkflowStopRequests(record)
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
    const revisions = [] as Array<{ reference: string }>
    for (const revision of snapshot.revisions ?? []) {
      const text = JSON.stringify(revision)
      const name = `${id}.${createHash('sha256').update(text).digest('hex')}.governing.json`
      if (!this.outputs.has(name)) {
        await this.atomicText(name, text)
        this.outputs.set(name, true)
        if (this.outputs.size > 1024) this.outputs.delete(this.outputs.keys().next().value!)
      }
      revisions.push({ reference: name })
    }
    // The root manifest retains only immutable revision references. Artifacts
    // precede the single atomic claim; orphan artifacts never authorize work.
    await this.atomic(`${id}.json`, { ...snapshot, ...(snapshot.revisions ? { revisions } : {}) })
  }

  async savePlanningIntent(intent: WorkflowPlanningIntent): Promise<void> {
    const snapshot = structuredClone(intent)
    const id = fileSafe(intent.workflowId)
    await withDirectoryLock(join(this.directory, 'locks', id + '.planning.json.lock'), async () => {
      validatePlanningSize(snapshot, await this.loadPlanningIntent(id))
      if (snapshot.result?.output !== undefined) {
        const text = snapshot.result.output
        const name = `${id}.${createHash('sha256').update(text).digest('hex')}.plan.txt`
        await this.atomicText(name, text)
        delete snapshot.result.output
        snapshot.result.outputRef = name
      }
      // The artifact precedes metadata; a failure receipt retains its reference.
      if (snapshot.result) intent.result = snapshot.result
      await this.atomic(`${id}.planning.json`, snapshot)
    }, { requireDeadOwner: true })
  }
  async loadPlanningIntent(id: string): Promise<WorkflowPlanningIntent | undefined> {
    const value = await this.readJson(`${fileSafe(id)}.planning.json`)
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || (value as WorkflowPlanningIntent).workflowId !== id) throw new Error('工作流规划记录已损坏')
    const intent = value as WorkflowPlanningIntent
    validatePlanningSize(intent)
    if ((intent.stopCommandId !== undefined && (typeof intent.stopCommandId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(intent.stopCommandId))) ||
      (intent.stopRequestedAt !== undefined && (typeof intent.stopRequestedAt !== 'number' || !Number.isFinite(intent.stopRequestedAt) || intent.stopRequestedAt < 0))) throw new Error(workflowControlCopy.invalidPlanningStopReceipt)
    validatePlanningRoute(intent)
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
    const governingArtifacts: string[] = []
    if (record.revisions !== undefined) {
      const references = (value as { revisions: unknown }).revisions
      if (!Array.isArray(references) || !references.length || references.length > 256) throw new Error(workflowRecoveryCopy.fingerprint)
      record.revisions = []
      for (const entry of references) {
        if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== 1 || typeof entry.reference !== 'string') throw new Error(workflowRecoveryCopy.fingerprint)
        const match = new RegExp(`^${fileSafe(id)}\\.([a-f0-9]{64})\\.governing\\.json$`).exec(entry.reference)
        if (!match) throw new Error(workflowRecoveryCopy.fingerprint)
        const text = await this.readText(entry.reference)
        if (text === undefined || createHash('sha256').update(text).digest('hex') !== match[1]) throw new Error(workflowRecoveryCopy.fingerprint)
        record.revisions.push(JSON.parse(text))
        governingArtifacts.push(entry.reference)
      }
    }
    validateWorkflowOwnership(record)
    if (record.preview?.workflowId !== id || record.progress?.workflowId !== id || !Array.isArray(record.intents) || !Array.isArray(record.outcomes)) throw new Error('工作流记录合同无效')
    validateWorkflowStopRequests(record)
    // Only a fully validated root can establish these existing content addresses.
    // Every load still reads and hashes them. A subsequent root publication retains
    // its own file flush, atomic rename and directory sync before acknowledgement.
    for (const name of governingArtifacts) this.rememberOutput(name)
    // Historical observations are not live authority, including files written
    // by an older or interrupted producer that accidentally persisted the field.
    delete record.progress.live
    await validateWorkflowClassifierLedgerCanonical(record, this, false)
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
