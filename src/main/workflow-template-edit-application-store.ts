import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkflowTaskReference } from '../shared/workflow-api'
import { templateIdPattern, type WorkflowTemplateEditApplicationSummary } from '../shared/workflow-template'

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/
const hashPattern = /^[a-f0-9]{64}$/

export type TemplateEditApplicationRecord = Readonly<{
  version: 1
  commandId: string
  task: WorkflowTaskReference & { revision: number }
  attemptId: string
  requestHash: string
  destination: 'personal' | 'project'
  createdAt: number
  state:
    | { kind: 'intent' }
    | { kind: 'applied'; draftId: string; draftRevision: number; candidateHash: string }
    | { kind: 'unknown'; reason: string }
}>

function text(value: unknown, name: string, max = 16_000): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`${name} 无效`)
  return value
}
function id(value: unknown, name: string): string {
  const result = text(value, name, 128)
  if (!idPattern.test(result)) throw new Error(`${name} 无效`)
  return result
}
function hash(value: unknown, name: string): string {
  const result = text(value, name, 64)
  if (!hashPattern.test(result)) throw new Error(`${name} 无效`)
  return result
}
function parse(value: unknown): TemplateEditApplicationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模板编辑候选草稿收据无效')
  const input = value as Record<string, unknown>, taskValue = input.task, stateValue = input.state
  if (input.version !== 1 || !taskValue || typeof taskValue !== 'object' || Array.isArray(taskValue) ||
    !stateValue || typeof stateValue !== 'object' || Array.isArray(stateValue)) throw new Error('模板编辑候选草稿收据无效')
  const task = taskValue as Record<string, unknown>, state = stateValue as Record<string, unknown>
  let parsedState: TemplateEditApplicationRecord['state']
  if (state.kind === 'intent') parsedState = { kind: 'intent' }
  else if (state.kind === 'unknown') parsedState = { kind: 'unknown', reason: text(state.reason, '模板编辑候选草稿未知原因') }
  else if (state.kind === 'applied') parsedState = { kind: 'applied', draftId: (() => { const value = id(state.draftId, '模板编辑候选草稿标识'); if (!templateIdPattern.test(value)) throw new Error('模板编辑候选草稿标识必须是 UUID'); return value })(),
    draftRevision: Number.isSafeInteger(state.draftRevision) && Number(state.draftRevision) >= 1 ? Number(state.draftRevision) : (() => { throw new Error('模板编辑候选草稿修订无效') })(),
    candidateHash: hash(state.candidateHash, '模板编辑候选草稿哈希') }
  else throw new Error('模板编辑候选草稿状态无效')
  const commandId = id(input.commandId, '模板编辑候选草稿命令')
  if (!templateIdPattern.test(commandId)) throw new Error('模板编辑候选草稿命令必须是 UUID')
  return { version: 1, commandId,
    task: { conversationId: id(task.conversationId, '会话标识'), commandId: id(task.commandId, '任务命令标识'),
      revision: Number.isSafeInteger(task.revision) && Number(task.revision) >= 0 ? Number(task.revision) : (() => { throw new Error('模板编辑任务修订无效') })() },
    attemptId: id(input.attemptId, '模板编辑候选尝试'), requestHash: hash(input.requestHash, '模板编辑候选草稿请求'),
    destination: input.destination === 'personal' || input.destination === 'project' ? input.destination : (() => { throw new Error('模板编辑候选草稿目标无效') })(),
    createdAt: Number.isFinite(input.createdAt) && Number(input.createdAt) > 0 ? Number(input.createdAt) : (() => { throw new Error('模板编辑候选草稿时间无效') })(),
    state: parsedState }
}

export class WorkflowTemplateEditApplicationStore {
  private readonly root: string
  private readonly queues = new Map<string, Promise<void>>()

  constructor(userData: string) { this.root = join(userData, 'workflow-template-edit-applications-v1') }

  private directory(reference: WorkflowTaskReference): string {
    return join(this.root, id(reference.conversationId, '会话标识'), id(reference.commandId, '任务命令标识'))
  }

  private path(reference: WorkflowTaskReference, commandId: string): string {
    return join(this.directory(reference), `${id(commandId, '模板编辑候选草稿命令')}.json`)
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve }), tail = prior.then(() => next)
    this.queues.set(key, tail); await prior
    try { return await operation() } finally { release(); if (this.queues.get(key) === tail) this.queues.delete(key) }
  }

  async read(reference: WorkflowTaskReference, commandId: string): Promise<TemplateEditApplicationRecord | null> {
    try { return parse(JSON.parse(await readFile(this.path(reference, commandId), 'utf8')) as unknown) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  async history(reference: WorkflowTaskReference, attemptId: string): Promise<WorkflowTemplateEditApplicationSummary[]> {
    let names: string[]
    try { names = (await readdir(this.directory(reference))).filter(name => name.endsWith('.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const records = (await Promise.all(names.map(name => this.read(reference, name.slice(0, -5))))).filter((record): record is TemplateEditApplicationRecord => Boolean(record))
    return records.filter(record => record.attemptId === attemptId).sort((left, right) => right.createdAt - left.createdAt || right.commandId.localeCompare(left.commandId))
      .map(record => ({ commandId: record.commandId, attemptId: record.attemptId, destination: record.destination, requestedAt: record.createdAt, state: record.state }))
  }

  private async write(reference: WorkflowTaskReference, record: TemplateEditApplicationRecord): Promise<void> {
    const path = this.path(reference, record.commandId), temporary = `${path}.${randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    try { await rename(temporary, path) } catch (error) { await rm(temporary, { force: true }); throw error }
  }

  async createIntent(record: TemplateEditApplicationRecord): Promise<{ created: true; record: TemplateEditApplicationRecord } | { created: false; record: TemplateEditApplicationRecord }> {
    const key = `${record.task.conversationId}:${record.task.commandId}:${record.commandId}`
    return this.exclusive(key, async () => {
      const existing = await this.read(record.task, record.commandId)
      if (existing) {
        if (existing.requestHash !== record.requestHash) throw new Error('模板编辑候选草稿命令已用于其他请求')
        return { created: false, record: existing }
      }
      const parsed = parse(record), path = this.path(record.task, record.commandId)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      try { await writeFile(path, `${JSON.stringify(parsed)}\n`, { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const observed = await this.read(record.task, record.commandId)
        if (!observed || observed.requestHash !== record.requestHash) throw new Error('模板编辑候选草稿登记结果未知')
        return { created: false, record: observed }
      }
      return { created: true, record: parsed }
    })
  }

  async applied(reference: WorkflowTaskReference, commandId: string, draftId: string, draftRevision: number, candidateHash: string): Promise<TemplateEditApplicationRecord> {
    return this.finish(reference, commandId, { kind: 'applied', draftId, draftRevision, candidateHash })
  }

  async unknown(reference: WorkflowTaskReference, commandId: string, reason: string): Promise<TemplateEditApplicationRecord> {
    return this.finish(reference, commandId, { kind: 'unknown', reason })
  }

  private async finish(reference: WorkflowTaskReference, commandId: string, state: TemplateEditApplicationRecord['state']): Promise<TemplateEditApplicationRecord> {
    const key = `${reference.conversationId}:${reference.commandId}:${commandId}`
    return this.exclusive(key, async () => {
      const current = await this.read(reference, commandId)
      if (!current) throw new Error('模板编辑候选草稿命令不存在')
      if (current.state.kind !== 'intent') return current
      const next = parse({ ...current, state })
      await this.write(reference, next)
      return next
    })
  }
}
