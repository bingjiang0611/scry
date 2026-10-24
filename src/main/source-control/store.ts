import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { writeJsonAtomic } from '../../core/turn-recorder/io'
import type { ScCommitDraft, ScOperation, ScPrRef, ScReviewDraft } from '../../shared/source-control'
import { workspaceOperationIdPattern } from '../../shared/workspace-selection-input'
import { assertWorkspaceJournal, type WorkspaceJournal } from './workspace-journal'

export interface ScIntent {
  workspace?: WorkspaceJournal
  head?: string
  parent?: string | null
  tree?: string
  branch?: string
  target?: string
  repository?: string
  number?: number
  account?: string
}
export interface StoredOperation {
  version: 1
  commonDir: string
  operation: ScOperation
  requestHash: string
  intent: ScIntent
  acknowledged: boolean
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const operationIdPattern = workspaceOperationIdPattern
const actions = new Set(['stage', 'unstage', 'commit', 'fetch', 'push', 'createPr', 'review', 'merge', 'prepareWorkspace'])

function decodeRecord(value: unknown): StoredOperation {
  if (typeof value !== 'object' || value === null) throw new Error('源代码管理操作日志格式错误')
  const record = value as Partial<StoredOperation>
  const op = record.operation
  if (
    record.version !== 1 ||
    typeof record.commonDir !== 'string' ||
    !isAbsolute(record.commonDir) ||
    !op ||
    typeof op !== 'object' ||
    !operationIdPattern.test(op.id) ||
    !/^[a-f0-9]{64}$/.test(op.repositoryId) ||
    !actions.has(op.action) ||
    !['running', 'succeeded', 'failed', 'unknown'].includes(op.status) ||
    !Number.isFinite(op.startedAt) ||
    typeof op.message !== 'string' ||
    typeof record.requestHash !== 'string' ||
    !record.intent ||
    typeof record.intent !== 'object' ||
    typeof record.acknowledged !== 'boolean'
  )
    throw new Error('源代码管理操作日志损坏；停止新写入，不能当作没有恢复记录')
  if (op.action === 'prepareWorkspace') {
    assertWorkspaceJournal(record.intent.workspace)
    if (record.intent.workspace.prepared && record.intent.workspace.prepared.operationId !== op.id)
      throw new Error('工作区准备日志身份不一致')
  }
  return record as StoredOperation
}

export class ScStore {
  readonly ready: Promise<void>
  private readonly records = new Map<string, StoredOperation>()
  private readonly draftWrites = new Map<string, Promise<void>>()
  private readonly directory: string

  constructor(userData: string) {
    this.directory = join(userData, 'source-control')
    this.ready = this.initialize()
    // Consumers await ready; attach a handler immediately to avoid an unhandled startup rejection.
    void this.ready.catch(() => {})
  }

  private async initialize(): Promise<void> {
    await mkdir(join(this.directory, 'operations'), { recursive: true, mode: 0o700 })
    const names = await readdir(join(this.directory, 'operations'))
    if (names.length > 10_000) throw new Error('源代码管理日志超过上限，请先归档已完成操作')
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      if (!operationIdPattern.test(id)) throw new Error('操作日志包含无效文件名')
      const file = join(this.directory, 'operations', name)
      const record = decodeRecord(JSON.parse(await readFile(file, 'utf8')))
      if (record.operation.id !== id) throw new Error('操作日志身份不一致')
      if (
        record.operation.action !== 'prepareWorkspace' &&
        ['succeeded', 'failed'].includes(record.operation.status) &&
        Date.now() - record.operation.startedAt > 30 * 86_400_000
      ) {
        await rm(file)
        continue
      }
      if (record.operation.status === 'running') {
        record.operation.status = 'unknown'
        record.operation.message = '应用在确认结果前退出；请只读核查，不自动重试'
        await writeJsonAtomic(file, record)
      }
      this.records.set(id, structuredClone(record))
    }
  }

  async save(record: StoredOperation): Promise<void> {
    await this.ready
    decodeRecord(record)
    if (!this.records.has(record.operation.id) && this.records.size >= 10_000)
      throw new Error('源代码管理日志已达上限，请先归档已完成操作')
    await writeJsonAtomic(join(this.directory, 'operations', `${record.operation.id}.json`), record)
    this.records.set(record.operation.id, structuredClone(record))
  }

  async get(id: string): Promise<StoredOperation | undefined> {
    await this.ready
    const record = this.records.get(id)
    return record ? structuredClone(record) : undefined
  }

  async list(repositoryId: string): Promise<StoredOperation[]> {
    await this.ready
    return [...this.records.values()]
      .filter((record) => record.operation.repositoryId === repositoryId)
      .sort((a, b) => b.operation.startedAt - a.operation.startedAt)
      .map((record) => structuredClone(record))
  }

  async recentWorktrees(commonDir: string): Promise<string[]> {
    await this.ready
    return [...new Set([...this.records.values()]
      .filter(record => record.commonDir === commonDir && record.intent.workspace?.phase === 'registered')
      .sort((a, b) => b.operation.startedAt - a.operation.startedAt)
      .flatMap(record => record.intent.workspace?.prepared ? [record.intent.workspace.prepared.worktreeId] : []))]
  }

  async unresolved(commonDir: string, exceptOperationId?: string): Promise<boolean> {
    await this.ready
    return [...this.records.values()].some(
      (record) =>
        record.commonDir === commonDir &&
        record.operation.id !== exceptOperationId &&
        !record.acknowledged &&
        ['running', 'unknown'].includes(record.operation.status)
    )
  }

  private draftPath(ref: ScPrRef): string {
    return join(
      this.directory,
      'drafts',
      `${digest(`${ref.repositoryId}\0${ref.repository}\0${ref.number}`)}.json`
    )
  }

  saveDraft(draft: ScReviewDraft): Promise<void> {
    return this.saveDraftFile(this.draftPath(draft), draft)
  }

  saveCommitDraft(draft: ScCommitDraft): Promise<void> {
    return this.saveDraftFile(join(this.directory, 'drafts', `commit-${draft.repositoryId}.json`), draft)
  }

  loadCommitDraft(repositoryId: string): Promise<unknown | null> {
    return this.loadDraftFile(join(this.directory, 'drafts', `commit-${repositoryId}.json`))
  }

  private async saveDraftFile(path: string, draft: ScReviewDraft | ScCommitDraft): Promise<void> {
    await this.ready
    const previous = this.draftWrites.get(path) ?? Promise.resolve()
    const write = previous.then(() => writeJsonAtomic(path, draft))
    const settled = write.then(
      () => {},
      () => {}
    )
    this.draftWrites.set(path, settled)
    void settled.then(() => {
      if (this.draftWrites.get(path) === settled) this.draftWrites.delete(path)
    })
    await write
  }

  async flushDrafts(): Promise<void> {
    await Promise.all([...this.draftWrites.values()])
  }

  loadDraft(ref: ScPrRef): Promise<unknown | null> {
    return this.loadDraftFile(this.draftPath(ref))
  }

  private async loadDraftFile(path: string): Promise<unknown | null> {
    await this.ready
    await this.draftWrites.get(path)
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw new Error('审查草稿无法读取；不会显示为不存在或覆盖它')
    }
  }
}
