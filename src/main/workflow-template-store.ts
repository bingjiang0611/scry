import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, opendir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { syncDirectory, withDirectoryLock, writeFileAtomicExclusive, writeJsonAtomic } from '../core/turn-recorder/io'
import { workflowTemplateCopy as copy } from '../shared/constants/copy'
import { WORKFLOW_TEMPLATE_MAX_BYTES, type WorkflowTemplateApi, type WorkflowTemplateDraft, type WorkflowTemplateDeletion, type WorkflowTemplatePublication, type WorkflowTemplateRef, type WorkflowTemplateScope, type WorkflowTemplateSnapshot } from '../shared/workflow-template'
import { assertTemplateSource, validateWorkflowTemplate } from './workflow-template-definition'
import { templateHashPattern, templateIdPattern, templateObject, templateReference, templateScope, templateSource } from './workflow-template-identity'
import type { WorkflowTemplateDefinition, WorkflowTemplateSource } from '../shared/workflow-template'
import { PerformanceTrace } from './performance-timing'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !templateIdPattern.test(value)) throw new Error(copy.invalid)
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !templateHashPattern.test(value)) throw new Error(copy.ledger)
}
function command(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) throw new Error(copy.invalid)
}

/** Bounded reads also cover external editors growing a file after stat. */
async function readText(path: string): Promise<string | undefined> {
  let info
  try { info = await lstat(path) } catch (error) { if (absent(error)) return undefined; throw error }
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error(copy.path)
  if (info.size > WORKFLOW_TEMPLATE_MAX_BYTES) throw new Error(copy.limit)
  const file = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    let length = 0
    while (length <= WORKFLOW_TEMPLATE_MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, WORKFLOW_TEMPLATE_MAX_BYTES + 1 - length))
      const result = await file.read(chunk, 0, chunk.length, length)
      if (!result.bytesRead) break
      chunks.push(chunk.subarray(0, result.bytesRead))
      length += result.bytesRead
    }
    if (length > WORKFLOW_TEMPLATE_MAX_BYTES) throw new Error(copy.limit)
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length))
  } finally { await file.close() }
}
async function directory(base: string, parts: string[], create: boolean): Promise<string | undefined> {
  let current = base
  for (const part of parts) {
    current = join(current, part)
    let info
    try { info = await lstat(current) } catch (error) {
      if (!absent(error)) throw error
      if (!create) return undefined
      try { await mkdir(current, { mode: 0o700 }) } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure
      }
      info = await lstat(current)
    }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw new Error(copy.path)
    // A cooperating creator may not have synced this entry yet. Commit every
    // ancestor before publishing a receipt or intent that depends on the tree.
    if (create) await syncDirectory(dirname(current))
  }
  return current
}

async function namesPage(path: string | undefined, pattern: RegExp, cursor?: string): Promise<{ names: string[]; nextCursor?: string }> {
  const names: string[] = []
  if (path) for await (const entry of await opendir(path)) {
    const name = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : ''
    if (!entry.isFile() || !pattern.test(name) || (cursor && name <= cursor)) continue
    names.push(name)
    if (names.length > 101) { names.sort(); names.pop() }
  }
  names.sort()
  return { names: names.slice(0, 100), ...(names.length > 100 ? { nextCursor: names[99] } : {}) }
}
function snapshot(ref: WorkflowTemplateRef, source: string): WorkflowTemplateSnapshot {
  try { return { ref, source, state: 'valid', definition: validateWorkflowTemplate(source, ref.templateId) } }
  catch (error) { return { ref, source, state: 'invalid', error: message(error) } }
}

export type WorkflowTemplateDeletionRecord = {
  version: 1
  commandId: string
  fingerprint: string
  ref: WorkflowTemplateRef
  phase: 'intent' | 'complete'
  result?: WorkflowTemplateDeletion
}

type DraftRecord = Omit<WorkflowTemplateDraft, 'source' | 'validation' | 'candidateHash'> & { sourceHash: string }
export type WorkflowTemplatePublicationRecord = {
  version: 1
  fingerprint: string
  draftId: string
  draftRevision: number
  candidateHash: string
  baseRevisionHash: string | null
  scope: WorkflowTemplateScope
  domainId: string
  templateId: string
  desiredHash: string
  phase: 'intent' | 'complete'
  result?: WorkflowTemplatePublication
}
const candidateHash = (record: DraftRecord) => hash(JSON.stringify(record))

/** A data publisher, not an executor. Project JSON never grants runtime authority. */
export class WorkflowTemplateStore implements WorkflowTemplateApi {
  constructor(
    private readonly userData: string,
    private readonly authorizeProject: (workspace: string) => string | Promise<string>,
    private readonly projectLockRoot = join(tmpdir(), `scry-workflow-template-locks-${process.getuid?.() ?? 'user'}`)
  ) {}

  private async normalize(scope: WorkflowTemplateScope): Promise<{ scope: WorkflowTemplateScope; base: string; domainId: string }> {
    const accepted = templateScope(scope)
    const base = accepted.kind === 'personal' ? await realpath(this.userData) : await this.authorizeProject(accepted.workspace)
    const normalized: WorkflowTemplateScope = accepted.kind === 'personal' ? accepted : { kind: 'project', workspace: base }
    return { scope: normalized, base, domainId: hash(JSON.stringify(normalized.kind === 'personal' ? ['personal', base] : ['project', base])) }
  }
  private async authorizeRef(input: WorkflowTemplateRef): Promise<WorkflowTemplateRef> {
    const ref = templateReference(input), location = await this.normalize(ref.scope)
    if (ref.domainId !== location.domainId || JSON.stringify(ref.scope) !== JSON.stringify(location.scope)) throw new Error(copy.ledger)
    return ref
  }
  private async own(parts: string[]): Promise<string> {
    return (await directory(await realpath(this.userData), ['workflows', 'template-data', ...parts], true))!
  }
  private async target(scope: WorkflowTemplateScope, templateId: string, create: boolean): Promise<{ path?: string; ref: Omit<WorkflowTemplateRef, 'revisionHash'> }> {
    id(templateId)
    const location = await this.normalize(scope)
    const dir = await directory(location.base, location.scope.kind === 'personal' ? ['workflows', 'templates'] : ['.scry-workflows'], create)
    return { ...(dir ? { path: join(dir, `${templateId}.json`) } : {}), ref: { scope: location.scope, domainId: location.domainId, templateId } }
  }
  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return withDirectoryLock(join(await this.own(['locks']), hash(key) + '.lock'), operation, { requireDeadOwner: true })
  }
  private async lockTarget<T>(scope: WorkflowTemplateScope, domainId: string, templateId: string, operation: () => Promise<T>): Promise<T> {
    const key = 'target:' + JSON.stringify([domainId, templateId])
    if (scope.kind === 'personal') return this.lock(key, operation)
    // Project writers in different userData domains still share one authority.
    // Locks are host-local private state, never files in the project definition directory.
    const root = (await directory(await realpath(dirname(this.projectLockRoot)), [basename(this.projectLockRoot)], true))!
    const info = await lstat(root)
    if (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error(copy.path)
    return withDirectoryLock(join(root, hash(key) + '.lock'), operation, { requireDeadOwner: true })
  }
  private async content(source: string): Promise<string> {
    assertTemplateSource(source)
    const key = hash(source), path = join(await this.own(['content']), `${key}.txt`)
    const existing = await readText(path)
    if (existing !== undefined) {
      if (existing !== source) throw new Error(copy.ledger)
      return key
    }
    try { await writeFileAtomicExclusive(path, Buffer.from(source)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await readText(path) !== source) throw new Error(copy.ledger)
    }
    return key
  }
  private async source(key: string): Promise<string> {
    digest(key)
    const source = await readText(join(await this.own(['content']), `${key}.txt`))
    if (source === undefined || hash(source) !== key) throw new Error(copy.ledger)
    return source
  }
  private async observe(ref: WorkflowTemplateRef, source: string): Promise<void> {
    const sourceHash = await this.content(source)
    if (sourceHash !== ref.revisionHash) throw new Error(copy.ledger)
    const path = join(await this.own(['history', ref.domainId, ref.templateId]), `${sourceHash}.json`)
    const prior = await readText(path)
    if (prior === undefined) await writeJsonAtomic(path, { ref, sourceHash })
    else {
      const observed = templateObject(JSON.parse(prior), ['ref', 'sourceHash'])
      if (observed.sourceHash !== sourceHash || JSON.stringify(templateReference(observed.ref)) !== JSON.stringify(ref)) throw new Error(copy.ledger)
    }
  }
  async read(scope: WorkflowTemplateScope, templateId: string): Promise<WorkflowTemplateSnapshot | null> {
    const target = await this.target(scope, templateId, false)
    const source = target.path ? await readText(target.path) : undefined
    if (source === undefined) return null
    const ref = { ...target.ref, revisionHash: hash(source) }
    await this.observe(ref, source)
    return snapshot(ref, source)
  }
  async list(scope: WorkflowTemplateScope, cursor?: string): Promise<{ templateIds: string[]; nextCursor?: string }> {
    if (cursor !== undefined) id(cursor)
    const location = await this.normalize(scope)
    const path = await directory(location.base, location.scope.kind === 'personal' ? ['workflows', 'templates'] : ['.scry-workflows'], false)
    const page = await namesPage(path, templateIdPattern, cursor)
    return { templateIds: page.names, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }
  async history(scope: WorkflowTemplateScope, templateId: string, cursor?: string): ReturnType<WorkflowTemplateApi['history']> {
    id(templateId)
    if (cursor !== undefined) digest(cursor)
    const location = await this.normalize(scope)
    const path = await directory(await realpath(this.userData), ['workflows', 'template-data', 'history', location.domainId, templateId], false)
    const page = await namesPage(path, templateHashPattern, cursor)
    return { revisions: page.names.map(revisionHash => ({ scope: location.scope, domainId: location.domainId, templateId, revisionHash })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }
  private async historySource(ref: WorkflowTemplateRef): Promise<string | undefined> {
    const dir = await directory(await realpath(this.userData), ['workflows', 'template-data', 'history', ref.domainId, ref.templateId], false)
    const text = dir ? await readText(join(dir, `${ref.revisionHash}.json`)) : undefined
    if (text === undefined) return undefined
    const record = templateObject(JSON.parse(text), ['ref', 'sourceHash'])
    if (record.sourceHash !== ref.revisionHash || JSON.stringify(templateReference(record.ref)) !== JSON.stringify(ref)) throw new Error(copy.ledger)
    return this.source(ref.revisionHash)
  }
  async revision(input: WorkflowTemplateRef): Promise<WorkflowTemplateSnapshot | null> {
    const ref = await this.authorizeRef(input), source = await this.historySource(ref)
    return source === undefined ? null : snapshot(ref, source)
  }
  async restoreDraft(request: Parameters<WorkflowTemplateApi['restoreDraft']>[0]): Promise<WorkflowTemplateDraft> {
    templateObject(request, ['ref', 'base'])
    const trace = new PerformanceTrace('workflow.template.restoreDraft')
    try {
      const ref = await this.authorizeRef(request.ref)
      const base = request.base === null ? null : templateReference(request.base)
      if (base && (base.domainId !== ref.domainId || base.templateId !== ref.templateId || JSON.stringify(base.scope) !== JSON.stringify(ref.scope))) throw new Error(copy.invalid)
      const source = await this.historySource(ref)
      if (source === undefined) throw new Error(copy.historyMissing)
      const current = await this.read(ref.scope, ref.templateId)
      if ((current?.ref.revisionHash ?? null) !== (base?.revisionHash ?? null)) throw new Error(copy.sourceChanged)
      trace.mark('history_loaded')
      const record: DraftRecord = { draftId: randomUUID(), draftRevision: 1, domainId: ref.domainId, templateId: ref.templateId, scope: ref.scope, base, sourceHash: ref.revisionHash }
      await writeJsonAtomic(join(await this.own(['drafts']), `${record.draftId}.json`), record)
      const draft = await this.expand(record)
      trace.mark('draft_persisted'); trace.finish()
      return draft
    } catch (error) { trace.finish(undefined, 'error'); throw error }
  }
  private async record(draftId: string): Promise<DraftRecord> {
    id(draftId)
    const text = await readText(join(await this.own(['drafts']), `${draftId}.json`))
    if (text === undefined) throw new Error(copy.missing)
    const value = templateObject(JSON.parse(text), ['draftId', 'draftRevision', 'domainId', 'templateId', 'scope', 'base', 'sourceHash'])
    if (value.draftId !== draftId || !Number.isSafeInteger(value.draftRevision) || Number(value.draftRevision) < 1) throw new Error(copy.ledger)
    id(value.templateId); digest(value.sourceHash); digest(value.domainId)
    const location = await this.normalize(templateScope(value.scope))
    if (location.domainId !== value.domainId) throw new Error(copy.ledger)
    if (value.base !== null) {
      const base = templateReference(value.base)
      if (base.domainId !== value.domainId || base.templateId !== value.templateId || JSON.stringify(base.scope) !== JSON.stringify(location.scope)) throw new Error(copy.ledger)
    }
    return value as DraftRecord
  }
  /** Capture only the reviewed revision. No publication or Provider execution. */
  async freeze(input: WorkflowTemplateSource): Promise<{ ref: WorkflowTemplateRef; origin: WorkflowTemplateSource; definition: WorkflowTemplateDefinition }> {
    const origin = templateSource(input)
    if (origin.kind === 'saved') {
      const snapshot = await this.read(origin.ref.scope, origin.ref.templateId)
      if (!snapshot || JSON.stringify(snapshot.ref) !== JSON.stringify(origin.ref)) throw new Error(copy.sourceChanged)
      if (snapshot.state !== 'valid') throw new Error(snapshot.error)
      return { ref: snapshot.ref, origin, definition: snapshot.definition }
    }
    const draft = await this.draft(origin.draftId)
    if (draft.draftRevision !== origin.draftRevision || draft.candidateHash !== origin.candidateHash) throw new Error(copy.staleDraft)
    const definition = validateWorkflowTemplate(draft.source, draft.templateId)
    const ref = { scope: draft.scope, domainId: draft.domainId, templateId: draft.templateId, revisionHash: hash(draft.source) }
    await this.observe(ref, draft.source)
    return { ref, origin, definition }
  }
  /** App-owned frozen history, not the mutable source or the current draft.
   * The run's workspace and Provider authority are checked independently. */
  async frozen(input: WorkflowTemplateRef): Promise<WorkflowTemplateDefinition> {
    const ref = templateReference(input)
    const source = await this.historySource(ref)
    if (source === undefined) throw new Error(copy.frozen)
    return validateWorkflowTemplate(source, ref.templateId)
  }
  private async expand(record: DraftRecord): Promise<WorkflowTemplateDraft> {
    const source = await this.source(record.sourceHash)
    let validation: WorkflowTemplateDraft['validation']
    try { validateWorkflowTemplate(source, record.templateId); validation = { state: 'valid' } }
    catch (error) { validation = { state: 'invalid', error: message(error) } }
    const { sourceHash: _sourceHash, ...metadata } = record
    return { ...metadata, source, candidateHash: candidateHash(record), validation }
  }
  async draft(draftId: string): Promise<WorkflowTemplateDraft> { return this.expand(await this.record(draftId)) }

  async saveDraft(request: Parameters<WorkflowTemplateApi['saveDraft']>[0]): Promise<WorkflowTemplateDraft> {
    templateObject(request, ['source', 'scope', 'base', 'draftId', 'expectedDraftRevision'])
    assertTemplateSource(request.source)
    const location = await this.normalize(request.scope)
    const draftId = request.draftId ?? randomUUID()
    id(draftId)
    return this.lock('draft:' + draftId, async () => {
      const prior = request.draftId ? await this.record(draftId) : undefined
      if (prior && request.expectedDraftRevision !== prior.draftRevision) throw new Error(copy.staleDraft)
      if (!prior && request.expectedDraftRevision !== undefined) throw new Error(copy.staleDraft)
      const base = request.base === undefined ? null : templateReference(request.base)
      if (base && (base.domainId !== location.domainId || JSON.stringify(base.scope) !== JSON.stringify(location.scope))) throw new Error(copy.invalid)
      if (prior && (JSON.stringify(prior.scope) !== JSON.stringify(location.scope) || JSON.stringify(prior.base) !== JSON.stringify(base))) throw new Error(copy.staleDraft)
      const templateId = prior?.templateId ?? base?.templateId ?? randomUUID()
      let source = request.source
      // New/Save-as identity is assigned before returning the actual source for review.
      let parsed: unknown
      try { parsed = JSON.parse(source) } catch { /* Incomplete text remains an editable draft. */ }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ((!prior && !base) || !Object.hasOwn(parsed, 'templateId'))) {
        source = JSON.stringify({ ...parsed, templateId }, null, 2) + '\n'
      }
      const sourceHash = await this.content(source)
      if (prior?.sourceHash === sourceHash) return this.expand(prior)
      const draftRevision = (prior?.draftRevision ?? 0) + 1
      if (!Number.isSafeInteger(draftRevision)) throw new Error(copy.staleDraft)
      const record: DraftRecord = { draftId, draftRevision, domainId: location.domainId, templateId, scope: location.scope, base, sourceHash }
      await writeJsonAtomic(join(await this.own(['drafts']), `${draftId}.json`), record)
      return this.expand(record)
    })
  }

  protected async savePublication(commandId: string, record: WorkflowTemplatePublicationRecord): Promise<void> {
    await writeJsonAtomic(join(await this.own(['publications']), `${commandId}.json`), record)
  }
  protected async replace(path: string, source: string): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temp, 'wx', 0o600)
      try { await file.writeFile(source); await file.sync() } finally { await file.close() }
      await rename(temp, path)
      await syncDirectory(dirname(path))
    } finally { await rm(temp, { force: true }) }
  }
  protected async saveDeletion(commandId: string, record: WorkflowTemplateDeletionRecord): Promise<void> {
    await writeJsonAtomic(join(await this.own(['deletions']), `${commandId}.json`), record)
  }
  protected async removeDefinition(path: string): Promise<void> {
    await unlink(path)
    await syncDirectory(dirname(path))
  }
  private deletionRecord(request: Parameters<WorkflowTemplateApi['delete']>[0], fingerprint: string, text: string): WorkflowTemplateDeletionRecord {
    const record = templateObject(JSON.parse(text), ['version', 'commandId', 'fingerprint', 'ref', 'phase', 'result']) as WorkflowTemplateDeletionRecord
    if (record.version !== 1) throw new Error(copy.ledger)
    if (record.commandId !== request.commandId || record.fingerprint !== fingerprint || JSON.stringify(templateReference(record.ref)) !== JSON.stringify(request.ref)) throw new Error(copy.deleteCommand)
    if (record.phase === 'intent') {
      if (Object.hasOwn(record, 'result')) throw new Error(copy.ledger)
      return record
    }
    if (record.phase !== 'complete' || !record.result) throw new Error(copy.ledger)
    const result = record.result
    if (result.state === 'deleted') {
      templateObject(result, ['state', 'ref', 'verification'])
      if (JSON.stringify(templateReference(result.ref)) !== JSON.stringify(record.ref) || !['unlink', 'reconciled_absence'].includes(result.verification)) throw new Error(copy.ledger)
    } else if (result.state === 'conflict') {
      templateObject(result, ['state', 'currentRevisionHash'])
      if (result.currentRevisionHash !== null) digest(result.currentRevisionHash)
    } else if (result.state === 'unknown') {
      templateObject(result, ['state', 'observedRevisionHash', 'reason'])
      if (result.observedRevisionHash !== null) digest(result.observedRevisionHash)
      if (typeof result.reason !== 'string' || !result.reason) throw new Error(copy.ledger)
    } else throw new Error(copy.ledger)
    return record
  }
  async delete(input: Parameters<WorkflowTemplateApi['delete']>[0]): Promise<WorkflowTemplateDeletion> {
    templateObject(input, ['ref', 'commandId']); command(input.commandId)
    const ref = await this.authorizeRef(input.ref)
    const request = { ref, commandId: input.commandId }, fingerprint = hash(JSON.stringify(ref))
    const trace = new PerformanceTrace('workflow.template.delete')
    return this.lock<WorkflowTemplateDeletion>('delete-command:' + request.commandId, () => this.lockTarget(ref.scope, ref.domainId, ref.templateId, async () => {
      const target = await this.target(ref.scope, ref.templateId, false)
      if (target.ref.domainId !== ref.domainId) throw new Error(copy.ledger)
      const priorText = await readText(join(await this.own(['deletions']), `${request.commandId}.json`))
      const prior = priorText === undefined ? undefined : this.deletionRecord(request, fingerprint, priorText)
      if (prior?.phase === 'complete') return prior.result!
      const current = target.path ? await readText(target.path) : undefined
      const currentHash = current === undefined ? null : hash(current)
      if (prior) {
        if (await this.historySource(ref) === undefined) throw new Error(copy.ledger)
        // An interrupted delete observes the postcondition and its durability
        // barrier, never another unlink. Absence does not attribute the actor.
        if (current === undefined) {
          const parent = target.path ? dirname(target.path)
            : ref.scope.kind === 'project' ? ref.scope.workspace : join(await realpath(this.userData), 'workflows')
          await syncDirectory(parent)
        }
        const result: WorkflowTemplateDeletion = current === undefined
          ? { state: 'deleted', ref, verification: 'reconciled_absence' }
          : { state: 'unknown', observedRevisionHash: currentHash, reason: copy.deletePending }
        await this.saveDeletion(request.commandId, { ...prior, phase: 'complete', result })
        return result
      }
      const intent: WorkflowTemplateDeletionRecord = { version: 1, commandId: request.commandId, fingerprint, ref, phase: 'intent' }
      if (currentHash !== ref.revisionHash) {
        const result: WorkflowTemplateDeletion = { state: 'conflict', currentRevisionHash: currentHash }
        await this.saveDeletion(request.commandId, { ...intent, phase: 'complete', result })
        return result
      }
      await this.observe(ref, current!)
      trace.mark('baseline_verified')
      await this.saveDeletion(request.commandId, intent)
      trace.mark('intent_persisted')
      try {
        const latest = await this.target(ref.scope, ref.templateId, false)
        if (latest.ref.domainId !== ref.domainId) throw new Error(copy.ledger)
        const source = latest.path ? await readText(latest.path) : undefined
        const sourceHash = source === undefined ? null : hash(source)
        if (sourceHash !== ref.revisionHash) {
          const result: WorkflowTemplateDeletion = { state: 'conflict', currentRevisionHash: sourceHash }
          await this.saveDeletion(request.commandId, { ...intent, phase: 'complete', result })
          return result
        }
        await this.removeDefinition(latest.path!)
        if (await readText(latest.path!) !== undefined) throw new Error(copy.ledger)
        trace.mark('target_absent')
        const result: WorkflowTemplateDeletion = { state: 'deleted', ref, verification: 'unlink' }
        await this.saveDeletion(request.commandId, { ...intent, phase: 'complete', result })
        return result
      } catch (error) {
        // Intent remains authoritative; an unknown acknowledgement cannot authorize a retry.
        return { state: 'unknown', observedRevisionHash: null, reason: message(error) }
      }
    })).then(result => {
      trace.finish(undefined, result.state === 'deleted' ? 'completed' : 'unavailable')
      return result
    }, error => { trace.finish(undefined, 'error'); throw error })
  }
  async publish(request: Parameters<WorkflowTemplateApi['publish']>[0]): Promise<WorkflowTemplatePublication> {
    templateObject(request, ['draftId', 'draftRevision', 'candidateHash', 'commandId'])
    id(request.draftId); digest(request.candidateHash); command(request.commandId)
    if (!Number.isSafeInteger(request.draftRevision) || request.draftRevision < 1) throw new Error(copy.invalid)
    const fingerprint = hash(JSON.stringify([request.draftId, request.draftRevision, request.candidateHash]))
    const trace = new PerformanceTrace('workflow.template.publish')
    return this.lock<WorkflowTemplatePublication>('command:' + request.commandId, () => this.lock('draft:' + request.draftId, async () => {
      const priorText = await readText(join(await this.own(['publications']), `${request.commandId}.json`))
      if (priorText !== undefined) return this.reconcile(request, fingerprint, priorText)
      const draft = await this.record(request.draftId)
      if (draft.draftRevision !== request.draftRevision || candidateHash(draft) !== request.candidateHash) throw new Error(copy.staleDraft)
      const source = await this.source(draft.sourceHash)
      validateWorkflowTemplate(source, draft.templateId)
      trace.mark('candidate_validated')
      return this.lockTarget(draft.scope, draft.domainId, draft.templateId, async () => {
        const target = await this.target(draft.scope, draft.templateId, false)
        if (target.ref.domainId !== draft.domainId) throw new Error(copy.ledger)
        const current = target.path ? await readText(target.path) : undefined
        const currentHash = current === undefined ? null : hash(current)
        const intent: WorkflowTemplatePublicationRecord = { version: 1, fingerprint, draftId: draft.draftId, draftRevision: draft.draftRevision,
          candidateHash: request.candidateHash, baseRevisionHash: draft.base?.revisionHash ?? null, scope: draft.scope, domainId: draft.domainId,
          templateId: draft.templateId, desiredHash: draft.sourceHash, phase: 'intent' }
        if (currentHash !== intent.baseRevisionHash) {
          const result: WorkflowTemplatePublication = { state: 'conflict', currentRevisionHash: currentHash }
          await this.savePublication(request.commandId, { ...intent, phase: 'complete', result })
          return result
        }
        if (currentHash === draft.sourceHash) {
          await this.observe({ ...target.ref, revisionHash: draft.sourceHash }, source)
          const result: WorkflowTemplatePublication = { state: 'published', ref: { ...target.ref, revisionHash: draft.sourceHash }, verification: 'reconciled_content' }
          await this.savePublication(request.commandId, { ...intent, phase: 'complete', result })
          return result
        }
        if (current !== undefined) await this.observe({ ...target.ref, revisionHash: currentHash! }, current)
        await this.observe({ ...target.ref, revisionHash: draft.sourceHash }, source)
        // This intent also precedes creating the project template directory.
        await this.savePublication(request.commandId, intent)
        trace.mark('intent_persisted')
        try {
          const writable = await this.target(draft.scope, draft.templateId, true)
          if (writable.ref.domainId !== draft.domainId) throw new Error(copy.ledger)
          const latest = await readText(writable.path!)
          if ((latest === undefined ? null : hash(latest)) !== currentHash) {
            const result: WorkflowTemplatePublication = { state: 'conflict', currentRevisionHash: latest === undefined ? null : hash(latest) }
            await this.savePublication(request.commandId, { ...intent, phase: 'complete', result })
            return result
          }
          if (currentHash === null) await writeFileAtomicExclusive(writable.path!, Buffer.from(source))
          else await this.replace(writable.path!, source)
          if (await readText(writable.path!) !== source) throw new Error(copy.ledger)
          trace.mark('target_verified')
          const result: WorkflowTemplatePublication = { state: 'published', ref: { ...target.ref, revisionHash: draft.sourceHash }, verification: 'write' }
          await this.savePublication(request.commandId, { ...intent, phase: 'complete', result })
          return result
        } catch (error) {
          // Keep the intent. Re-delivery may inspect content, never repeat the project write.
          return { state: 'unknown', observedRevisionHash: null, reason: message(error) }
        }
      })
    })).then(result => {
      trace.finish(undefined, result.state === 'published' ? 'completed' : 'unavailable')
      return result
    }, error => {
      trace.finish(undefined, 'error')
      throw error
    })
  }

  private async reconcile(request: Parameters<WorkflowTemplateApi['publish']>[0], fingerprint: string, text: string): Promise<WorkflowTemplatePublication> {
    const prior = templateObject(JSON.parse(text), ['version', 'fingerprint', 'draftId', 'draftRevision', 'candidateHash', 'baseRevisionHash', 'scope', 'domainId', 'templateId', 'desiredHash', 'phase', 'result']) as WorkflowTemplatePublicationRecord
    if (prior.version !== 1 || prior.fingerprint !== fingerprint || prior.draftId !== request.draftId || prior.draftRevision !== request.draftRevision || prior.candidateHash !== request.candidateHash) throw new Error(copy.command)
    digest(prior.desiredHash); digest(prior.domainId)
    if (prior.baseRevisionHash !== null) digest(prior.baseRevisionHash)
    return this.lockTarget(prior.scope, prior.domainId, prior.templateId, async () => {
      const target = await this.target(prior.scope, prior.templateId, false)
      if (prior.domainId !== target.ref.domainId) throw new Error(copy.ledger)
      if (prior.phase === 'complete') {
        const result = prior.result
        if (!result) throw new Error(copy.ledger)
        if (result.state === 'published') {
          const ref = templateReference(result.ref)
          if (JSON.stringify(ref) !== JSON.stringify({ ...target.ref, revisionHash: prior.desiredHash }) || !['write', 'reconciled_content'].includes(result.verification)) throw new Error(copy.ledger)
        } else if (result.state === 'conflict') {
          if (result.currentRevisionHash !== null) digest(result.currentRevisionHash)
        } else if (result.state === 'unknown') {
          if (result.observedRevisionHash !== null) digest(result.observedRevisionHash)
          if (typeof result.reason !== 'string' || !result.reason) throw new Error(copy.ledger)
        } else throw new Error(copy.ledger)
        return result
      }
      if (prior.phase !== 'intent') throw new Error(copy.ledger)
      const current = target.path ? await readText(target.path) : undefined
      const observedRevisionHash = current === undefined ? null : hash(current)
      const result: WorkflowTemplatePublication = observedRevisionHash === prior.desiredHash
        ? { state: 'published', ref: { ...target.ref, revisionHash: prior.desiredHash }, verification: 'reconciled_content' }
        : { state: 'unknown', observedRevisionHash, reason: copy.pending }
      await this.savePublication(request.commandId, { ...prior, phase: 'complete', result })
      return result
    })
  }
}
