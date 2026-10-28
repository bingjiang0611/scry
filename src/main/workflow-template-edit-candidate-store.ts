import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowTaskReference } from '../shared/workflow-api'
import type { WorkflowTemplateEditCandidateAttemptSummary, WorkflowTemplateEditCandidateInspection, WorkflowTemplateEditAuthor, WorkflowTemplateRef } from '../shared/workflow-template'
import { WORKFLOW_TEMPLATE_MAX_BYTES } from '../shared/workflow-template'
import { validateWorkflowRoleBinding } from './workflow-program'
import { templateReference } from './workflow-template-identity'

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/
const hashPattern = /^[a-f0-9]{64}$/
const MAX_ATTEMPTS_PER_TASK = 100

export type TemplateEditCandidateIntent = Readonly<{
  version: 1
  attemptId: string
  task: WorkflowTaskReference & { revision: number; submissionId: string; inputSha256: string }
  sourceRef: WorkflowTemplateRef
  sourceHash: string
  author: WorkflowTemplateEditAuthor & { runtimeIdentity: string }
  continuationKeyHash: string
  requestHash: string
  requestedAt: number
  disclosure: WorkflowTemplateEditCandidateInspection['disclosure']
  state: { kind: 'dispatch_intent'; runId: string }
}>

type TemplateEditCandidateRecord = Omit<TemplateEditCandidateIntent, 'state'> & Readonly<{
  state:
    | TemplateEditCandidateIntent['state']
    | { kind: 'unknown'; runId: string; reason: string; archiveRef?: string }
    | { kind: 'candidate'; runId: string; archiveRef: string; outputSource: string; actualModel?: string; candidateHash: string; summary: string; contentHash: string; validation: { state: 'valid' } | { state: 'invalid'; error: string } }
}>

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requiredString(value: unknown, name: string, max = 16_000): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`${name} 无效`)
  return value
}

function requiredHash(value: unknown, name: string): string {
  const hash = requiredString(value, name, 64)
  if (!hashPattern.test(hash)) throw new Error(`${name} 无效`)
  return hash
}

function requiredId(value: unknown, name: string): string {
  const id = requiredString(value, name, 128)
  if (!idPattern.test(id)) throw new Error(`${name} 无效`)
  return id
}

function parseRecord(value: unknown): TemplateEditCandidateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模板编辑候选记录无效')
  const input = value as Record<string, unknown>
  if (input.version !== 1) throw new Error('模板编辑候选记录版本无效')
  const taskValue = input.task
  if (!taskValue || typeof taskValue !== 'object' || Array.isArray(taskValue)) throw new Error('模板编辑候选任务无效')
  const task = taskValue as Record<string, unknown>
  const authorValue = input.author
  if (!authorValue || typeof authorValue !== 'object' || Array.isArray(authorValue)) throw new Error('模板编辑候选作者无效')
  const author = validateWorkflowRoleBinding({ ...(authorValue as object), role: 'orchestrator' }, 0, true)
  const disclosureValue = input.disclosure
  if (!disclosureValue || typeof disclosureValue !== 'object' || Array.isArray(disclosureValue)) throw new Error('模板编辑候选披露无效')
  const disclosure = disclosureValue as Record<string, unknown>
  const stateValue = input.state
  if (!stateValue || typeof stateValue !== 'object' || Array.isArray(stateValue)) throw new Error('模板编辑候选状态无效')
  const state = stateValue as Record<string, unknown>
  const runId = requiredString(state.runId, '模板编辑候选运行标识', 200)
  let parsedState: TemplateEditCandidateRecord['state']
  if (state.kind === 'dispatch_intent') parsedState = { kind: 'dispatch_intent', runId }
  else if (state.kind === 'unknown') parsedState = { kind: 'unknown', runId, reason: requiredString(state.reason, '模板编辑候选未知原因'), ...(state.archiveRef === undefined ? {} : { archiveRef: requiredString(state.archiveRef, '模板编辑候选归档', 4096) }) }
  else if (state.kind === 'candidate') {
    const validationValue = state.validation
    if (!validationValue || typeof validationValue !== 'object' || Array.isArray(validationValue)) throw new Error('模板编辑候选校验无效')
    const validation = validationValue as Record<string, unknown>
    parsedState = {
      kind: 'candidate', runId, archiveRef: requiredString(state.archiveRef, '模板编辑候选归档', 4096),
      outputSource: requiredString(state.outputSource, '模板编辑候选来源', 200),
      ...(state.actualModel === undefined ? {} : { actualModel: requiredString(state.actualModel, '模板编辑候选实际模型', 500) }),
      candidateHash: requiredHash(state.candidateHash, '模板编辑候选哈希'), summary: requiredString(state.summary, '模板编辑候选摘要'),
      contentHash: requiredHash(state.contentHash, '模板编辑候选内容哈希'),
      validation: validation.state === 'valid' ? { state: 'valid' } : validation.state === 'invalid'
        ? { state: 'invalid', error: requiredString(validation.error, '模板编辑候选校验错误') }
        : (() => { throw new Error('模板编辑候选校验状态无效') })()
    }
  } else throw new Error('模板编辑候选状态无效')
  const sends = disclosure.sends, excludes = disclosure.excludes, estimatedCost = disclosure.estimatedCost
  if (JSON.stringify(sends) !== JSON.stringify(['instruction', 'template_source', 'authoring_contract']) ||
    JSON.stringify(excludes) !== JSON.stringify(['conversation_history', 'attachments', 'workspace_files', 'credentials']) ||
    !estimatedCost || typeof estimatedCost !== 'object' || Array.isArray(estimatedCost) || (estimatedCost as Record<string, unknown>).state !== 'unavailable') {
    throw new Error('模板编辑候选披露内容无效')
  }
  return {
    version: 1, attemptId: requiredId(input.attemptId, '模板编辑候选尝试标识'),
    task: { conversationId: requiredId(task.conversationId, '会话标识'), commandId: requiredId(task.commandId, '任务命令标识'),
      revision: Number.isSafeInteger(task.revision) && Number(task.revision) >= 0 ? Number(task.revision) : (() => { throw new Error('任务修订无效') })(),
      submissionId: requiredId(task.submissionId, '任务提交标识'), inputSha256: requiredHash(task.inputSha256, '任务输入哈希') },
    sourceRef: templateReference(input.sourceRef), sourceHash: requiredHash(input.sourceHash, '模板编辑来源哈希'),
    author: { providerId: author.providerId, ...(author.agentProfileId ? { agentProfileId: author.agentProfileId } : {}),
      ...(author.requestedModel ? { requestedModel: author.requestedModel } : {}), runtimeIdentity: requiredHash(author.runtimeIdentity, '模板编辑能力身份') },
    continuationKeyHash: requiredHash(input.continuationKeyHash, '模板编辑延续身份'), requestHash: requiredHash(input.requestHash, '模板编辑请求哈希'),
    requestedAt: Number.isFinite(input.requestedAt) && Number(input.requestedAt) > 0 ? Number(input.requestedAt) : (() => { throw new Error('模板编辑请求时间无效') })(),
    disclosure: { sourceBytes: Number.isSafeInteger(disclosure.sourceBytes) && Number(disclosure.sourceBytes) >= 0 && Number(disclosure.sourceBytes) <= WORKFLOW_TEMPLATE_MAX_BYTES ? Number(disclosure.sourceBytes) : (() => { throw new Error('模板编辑来源大小无效') })(),
      sends: ['instruction', 'template_source', 'authoring_contract'], excludes: ['conversation_history', 'attachments', 'workspace_files', 'credentials'],
      estimatedCost: { state: 'unavailable', reason: requiredString((estimatedCost as Record<string, unknown>).reason, '模板编辑费用说明', 1000) } },
    state: parsedState
  }
}

export class WorkflowTemplateEditCandidateStore {
  private readonly root: string
  private readonly queues = new Map<string, Promise<void>>()

  constructor(userData: string) {
    this.root = join(userData, 'workflow-template-edit-candidates-v1')
  }

  private taskDirectory(reference: WorkflowTaskReference): string {
    return join(this.root, requiredId(reference.conversationId, '会话标识'), requiredId(reference.commandId, '任务命令标识'))
  }

  private recordPath(reference: WorkflowTaskReference, attemptId: string): string {
    return join(this.taskDirectory(reference), `${requiredId(attemptId, '模板编辑候选尝试标识')}.json`)
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const tail = prior.then(() => next)
    this.queues.set(key, tail)
    await prior
    try { return await operation() } finally { release(); if (this.queues.get(key) === tail) this.queues.delete(key) }
  }

  private async readRecord(reference: WorkflowTaskReference, attemptId: string): Promise<TemplateEditCandidateRecord | null> {
    try { return parseRecord(JSON.parse(await readFile(this.recordPath(reference, attemptId), 'utf8')) as unknown) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  private async writeRecord(reference: WorkflowTaskReference, record: TemplateEditCandidateRecord): Promise<void> {
    const path = this.recordPath(reference, record.attemptId), temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    try { await rename(temporary, path) } catch (error) { await rm(temporary, { force: true }); throw error }
  }

  async createIntent(intent: TemplateEditCandidateIntent): Promise<
    { created: true; intent: TemplateEditCandidateIntent } | { created: false; observed: WorkflowTemplateEditCandidateInspection }
  > {
    const reference = { conversationId: intent.task.conversationId, commandId: intent.task.commandId }
    return this.exclusive(`${reference.conversationId}:${reference.commandId}:${intent.attemptId}`, async () => {
      const existing = await this.readRecord(reference, intent.attemptId)
      if (existing) {
        if (existing.requestHash !== intent.requestHash) throw new Error('模板编辑候选尝试标识已用于其他请求')
        return { created: false, observed: await this.inspect(existing) }
      }
      const directory = this.taskDirectory(reference)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const attempts = (await readdir(directory)).filter(name => name.endsWith('.json'))
      if (attempts.length >= MAX_ATTEMPTS_PER_TASK) throw new Error('此模板编辑任务的候选尝试已达到上限')
      const path = this.recordPath(reference, intent.attemptId)
      try { await writeFile(path, `${JSON.stringify(intent)}\n`, { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const observed = await this.readRecord(reference, intent.attemptId)
        if (!observed || observed.requestHash !== intent.requestHash) throw new Error('模板编辑候选尝试写入结果未知')
        return { created: false, observed: await this.inspect(observed) }
      }
      return { intent: parseRecord(intent) as TemplateEditCandidateIntent, created: true }
    })
  }

  async recordUnknown(reference: WorkflowTaskReference, attemptId: string, reason: string, archiveRef?: string): Promise<WorkflowTemplateEditCandidateInspection> {
    return this.finish(reference, attemptId, current => ({ kind: 'unknown', runId: current.state.runId, reason, ...(archiveRef ? { archiveRef } : {}) }))
  }

  async recordCandidate(reference: WorkflowTaskReference, attemptId: string, candidate: {
    archiveRef: string; outputSource: string; actualModel?: string; source: string; summary: string
    validation: { state: 'valid' } | { state: 'invalid'; error: string }
  }): Promise<WorkflowTemplateEditCandidateInspection> {
    if (Buffer.byteLength(candidate.source) > WORKFLOW_TEMPLATE_MAX_BYTES) throw new Error('模板编辑候选超过大小上限')
    const contentHash = digest(candidate.source), candidateHash = digest(JSON.stringify({ source: candidate.source, summary: candidate.summary }))
    const contentDirectory = join(this.root, 'content'), contentPath = join(contentDirectory, `${contentHash}.txt`)
    await mkdir(contentDirectory, { recursive: true, mode: 0o700 })
    try { await writeFile(contentPath, candidate.source, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (digest(await readFile(contentPath, 'utf8')) !== contentHash) throw new Error('模板编辑候选内容损坏')
    return this.finish(reference, attemptId, current => ({ kind: 'candidate', runId: current.state.runId, archiveRef: candidate.archiveRef,
      outputSource: candidate.outputSource, ...(candidate.actualModel ? { actualModel: candidate.actualModel } : {}), candidateHash, summary: candidate.summary,
      contentHash, validation: candidate.validation }))
  }

  private async finish(reference: WorkflowTaskReference, attemptId: string, state: (current: TemplateEditCandidateIntent) => TemplateEditCandidateRecord['state']): Promise<WorkflowTemplateEditCandidateInspection> {
    return this.exclusive(`${reference.conversationId}:${reference.commandId}:${attemptId}`, async () => {
      const current = await this.readRecord(reference, attemptId)
      if (!current) throw new Error('模板编辑候选尝试不存在')
      if (current.state.kind !== 'dispatch_intent') return this.inspect(current)
      const next = { ...current, state: state(current as TemplateEditCandidateIntent) }
      await this.writeRecord(reference, next)
      return this.inspect(parseRecord(next))
    })
  }

  async attempt(reference: WorkflowTaskReference, attemptId: string): Promise<WorkflowTemplateEditCandidateInspection | null> {
    const record = await this.readRecord(reference, attemptId)
    return record ? this.inspect(record) : null
  }

  async history(reference: WorkflowTaskReference): Promise<WorkflowTemplateEditCandidateAttemptSummary[]> {
    let names: string[]
    try { names = (await readdir(this.taskDirectory(reference))).filter(name => name.endsWith('.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const records = (await Promise.all(names.map(name => this.readRecord(reference, name.slice(0, -5))))).filter((record): record is TemplateEditCandidateRecord => Boolean(record))
    return records.sort((left, right) => right.requestedAt - left.requestedAt || right.attemptId.localeCompare(left.attemptId)).map(record => {
      const common = { attemptId: record.attemptId, taskRevision: record.task.revision, sourceRef: record.sourceRef,
        author: record.author, requestedAt: record.requestedAt, disclosure: record.disclosure }
      if (record.state.kind !== 'candidate') return { ...common, state: record.state }
      const { contentHash: _contentHash, ...state } = record.state
      return { ...common, state }
    })
  }

  async latest(reference: WorkflowTaskReference): Promise<WorkflowTemplateEditCandidateInspection | null> {
    let names: string[]
    try { names = (await readdir(this.taskDirectory(reference))).filter(name => name.endsWith('.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const records = (await Promise.all(names.map(name => this.readRecord(reference, name.slice(0, -5))))).filter((record): record is TemplateEditCandidateRecord => Boolean(record))
    const latest = records.sort((left, right) => right.requestedAt - left.requestedAt || right.attemptId.localeCompare(left.attemptId))[0]
    return latest ? this.inspect(latest) : null
  }

  private async inspect(record: TemplateEditCandidateRecord): Promise<WorkflowTemplateEditCandidateInspection> {
    const common = { attemptId: record.attemptId, taskRevision: record.task.revision, sourceRef: record.sourceRef,
      author: { providerId: record.author.providerId, ...(record.author.agentProfileId ? { agentProfileId: record.author.agentProfileId } : {}), ...(record.author.requestedModel ? { requestedModel: record.author.requestedModel } : {}) },
      requestedAt: record.requestedAt, disclosure: record.disclosure }
    if (record.state.kind !== 'candidate') return { ...common, state: record.state }
    const source = await readFile(join(this.root, 'content', `${record.state.contentHash}.txt`), 'utf8')
    if (digest(source) !== record.state.contentHash) throw new Error('模板编辑候选内容损坏')
    const { contentHash: _contentHash, ...state } = record.state
    return { ...common, state: { ...state, source } }
  }
}
