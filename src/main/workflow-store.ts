import { mkdir, open, opendir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WorkflowAttemptOutcome, WorkflowPlanPreview, WorkflowProgress } from '../shared/workflow'
import { workflowProgressSnapshot } from '../shared/workflow'

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
export interface WorkflowStoreRecord {
  preview: WorkflowPlanPreview
  executionStarted?: number
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
  result?: { output?: string; outputRef?: string; actualModel?: string; archiveRef?: string }
  error?: string
}
export interface WorkflowStorePage { records: WorkflowStoreRecord[]; nextCursor?: string }
export interface WorkflowStore {
  save(record: WorkflowStoreRecord): Promise<void>
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

export class FileWorkflowStore implements WorkflowStore {
  private readonly directory: string
  private readonly outputs = new Map<string, true>()
  private readonly writes = new Map<string, Promise<void>>()
  constructor(userData: string) { this.directory = join(userData, 'workflows') }

  private async readJson(name: string): Promise<unknown | undefined> {
    let handle
    try { handle = await open(join(this.directory, name), 'r') } catch (error) { if (absent(error)) return undefined; throw error }
    try {
      if ((await handle.stat()).size > MAX_RECORD_BYTES) throw new Error('工作流记录超过 8 MiB 读取上限')
      return JSON.parse(await handle.readFile('utf8')) as unknown
    } finally { await handle.close() }
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
      const temporary = `${target}.${randomUUID()}.tmp`
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

  async readConcurrency(): Promise<number | undefined> {
    const value = await this.readJson('settings.json')
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作流设置无效')
    const concurrency = (value as Record<string, unknown>).workflowConcurrency
    if (concurrency !== undefined && typeof concurrency !== 'number') throw new Error('工作流并发设置无效')
    return concurrency
  }

  async save(record: WorkflowStoreRecord): Promise<void> {
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
    return value as WorkflowPlanningIntent
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
    if (record.preview?.workflowId !== id || record.progress?.workflowId !== id || !Array.isArray(record.intents) || !Array.isArray(record.outcomes)) throw new Error('工作流记录合同无效')
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
  async save(record: WorkflowStoreRecord): Promise<void> { this.records.set(record.preview.workflowId, structuredClone(record)) }
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
