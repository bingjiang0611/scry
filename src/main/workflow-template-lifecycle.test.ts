import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowTemplateDraft, WorkflowTemplateRef, WorkflowTemplateScope } from '../shared/workflow-template'
import { WorkflowTemplateStore, type WorkflowTemplateDeletionRecord } from './workflow-template-store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const source = (name = 'History fixture') => JSON.stringify({ schemaVersion: 1, name, description: '', parameters: {}, roles: [],
  body: { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'bind', blockId: 'value', value: { kind: 'literal', value: 'retained' } }, { kind: 'return', blockId: 'finish', ref: { nodeId: 'value' } }] } })
const publication = (draft: WorkflowTemplateDraft) => ({ draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId: randomUUID() })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-template-lifecycle-'))); roots.push(root)
  const user = join(root, 'user'), project = join(root, 'project'), other = join(root, 'other'), locks = join(root, 'locks')
  await Promise.all([user, project, other].map(path => mkdir(path)))
  let authorized = true
  const authorize = (cwd: string) => { if (!authorized || cwd !== project) throw new Error('unauthorized project'); return cwd }
  const scope: WorkflowTemplateScope = { kind: 'project', workspace: project }
  const store = new WorkflowTemplateStore(user, authorize, locks)
  const initial = async (scope: WorkflowTemplateScope = { kind: 'project', workspace: project }) => {
    const draft = await store.saveDraft({ scope, source: source() }), result = await store.publish(publication(draft))
    if (result.state !== 'published') throw new Error('fixture publication failed')
    return { draft, ref: result.ref, path: scope.kind === 'project' ? join(project, '.scry-workflows', draft.templateId + '.json') : join(user, 'workflows', 'templates', draft.templateId + '.json') }
  }
  return { root, user, project, other, locks, scope, store, initial, authorize, revoke: () => { authorized = false } }
}

describe('retained template history, reviewed restoration and deletion receipts', () => {
  it('returns only locally retained exact revisions, including invalid observed bytes, in either domain', async () => {
    const f = await fixture()
    for (const scope of [{ kind: 'personal' } as const, f.scope]) {
      const saved = await f.initial(scope)
      const external = '\uFEFF' + saved.draft.source
      await writeFile(saved.path, external)
      const observed = (await f.store.read(scope, saved.ref.templateId))!
      expect(observed.state).toBe('invalid')
      const cold = new WorkflowTemplateStore(f.user, f.authorize, f.locks)
      const history = await cold.history(scope, saved.ref.templateId)
      expect(history.revisions.map(ref => ref.revisionHash).sort()).toEqual([saved.ref.revisionHash, hash(external)].sort())
      expect((await cold.revision(saved.ref))?.source).toBe(saved.draft.source)
      expect(await cold.revision(observed.ref)).toMatchObject({ state: 'invalid', source: external })
      expect(await cold.revision({ ...saved.ref, revisionHash: 'f'.repeat(64) })).toBeNull()
    }
  })
  it('does not turn an unpublished frozen candidate into a published-version claim', async () => {
    const f = await fixture(), draft = await f.store.saveDraft({ scope: f.scope, source: source('unpublished') })
    const frozen = await f.store.freeze({ kind: 'draft', draftId: draft.draftId, draftRevision: 1, candidateHash: draft.candidateHash })
    expect((await f.store.history(f.scope, draft.templateId)).revisions).toEqual([frozen.ref])
    expect((await f.store.revision(frozen.ref))?.source).toBe(draft.source)
    expect(await f.store.read(f.scope, draft.templateId)).toBeNull()
    await expect(stat(join(f.project, '.scry-workflows'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps invalid historical bytes as an editable draft, never silently repairing or publishing them', async () => {
    const f = await fixture(), saved = await f.initial(), invalid = '\uFEFF' + saved.draft.source
    await writeFile(saved.path, invalid)
    const observed = (await f.store.read(f.scope, saved.ref.templateId))!
    const draft = await f.store.restoreDraft({ ref: observed.ref, base: observed.ref })
    expect(draft.source).toBe(invalid); expect(draft.validation.state).toBe('invalid')
    await expect(f.store.publish(publication(draft))).rejects.toThrow()
    expect(await readFile(saved.path, 'utf8')).toBe(invalid)
  })
  it('restores to a separate reviewed draft and keeps current bytes/inode until explicit publication', async () => {
    const f = await fixture(), saved = await f.initial()
    const external = JSON.stringify({ ...JSON.parse(saved.draft.source), name: 'current external' })
    await writeFile(saved.path, external)
    const current = (await f.store.read(f.scope, saved.ref.templateId))!, before = await stat(saved.path)
    const restored = await f.store.restoreDraft({ ref: saved.ref, base: current.ref })
    expect(restored).toMatchObject({ templateId: saved.ref.templateId, base: current.ref, source: saved.draft.source, validation: { state: 'valid' } })
    expect(restored.draftId).not.toBe(saved.draft.draftId)
    expect(await readFile(saved.path, 'utf8')).toBe(external)
    expect((await stat(saved.path)).ino).toBe(before.ino)
    const later = JSON.stringify({ ...JSON.parse(external), name: 'changed after restoration review' })
    await writeFile(saved.path, later)
    expect((await f.store.publish(publication(restored))).state).toBe('conflict')
    expect(await readFile(saved.path, 'utf8')).toBe(later)
    expect((await f.store.draft(restored.draftId)).source).toBe(saved.draft.source)
    await expect(f.store.restoreDraft({ ref: saved.ref, base: current.ref })).rejects.toThrow('修订已变化')
  })
  it('deletes only the confirmed current definition and can restore the same identity after deletion', async () => {
    const f = await fixture()
    for (const scope of [{ kind: 'personal' } as const, f.scope]) {
      const saved = await f.initial(scope), sibling = await f.initial(scope)
      const marker = join(f.user, 'workflows', 'unrelated-run-sentinel.json'); await writeFile(marker, 'do not change')
      const request = { ref: saved.ref, commandId: randomUUID() }
      const result = await f.store.delete(request)
      expect(result).toEqual({ state: 'deleted', ref: saved.ref, verification: 'unlink' })
      expect(await f.store.read(scope, saved.ref.templateId)).toBeNull()
      expect((await f.store.revision(saved.ref))?.source).toBe(saved.draft.source)
      expect(await readFile(sibling.path, 'utf8')).toBe(sibling.draft.source)
      expect(await readFile(marker, 'utf8')).toBe('do not change')
      const restored = await f.store.restoreDraft({ ref: saved.ref, base: null })
      expect(restored.templateId).toBe(saved.ref.templateId)
      await expect(stat(saved.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await f.store.publish(publication(restored))).state).toBe('published')
      const before = await stat(saved.path)
      const cold = new WorkflowTemplateStore(f.user, f.authorize, f.locks)
      expect(await cold.delete(request)).toEqual(result)
      expect((await stat(saved.path)).ino).toBe(before.ino)
      expect(await readFile(saved.path, 'utf8')).toBe(saved.draft.source)
      await expect(cold.delete({ ...request, ref: { ...saved.ref, revisionHash: 'a'.repeat(64) } })).rejects.toThrow('commandId')
    }
  })
  it('refuses stale deletion and absent baselines, preserving external changes and exact hash evidence', async () => {
    const f = await fixture(), saved = await f.initial(), external = saved.draft.source + ' '
    await writeFile(saved.path, external)
    expect(await f.store.delete({ ref: saved.ref, commandId: randomUUID() })).toEqual({ state: 'conflict', currentRevisionHash: hash(external) })
    expect(await readFile(saved.path, 'utf8')).toBe(external)
    await rm(saved.path)
    expect(await f.store.delete({ ref: saved.ref, commandId: randomUUID() })).toEqual({ state: 'conflict', currentRevisionHash: null })
  })
  it('reconciles an intent before unlink as unknown without removing the still-present definition', async () => {
    const f = await fixture(), saved = await f.initial()
    class Interrupted extends WorkflowTemplateStore {
      protected override async saveDeletion(id: string, record: WorkflowTemplateDeletionRecord) {
        await super.saveDeletion(id, record)
        if (record.phase === 'intent') throw new Error('fixture interrupted after delete intent')
      }
    }
    const request = { ref: saved.ref, commandId: randomUUID() }, first = new Interrupted(f.user, f.authorize, f.locks)
    await expect(first.delete(request)).rejects.toThrow('after delete intent')
    const before = await stat(saved.path)
    class ReadOnlyRetry extends WorkflowTemplateStore {
      protected override async removeDefinition() { throw new Error('must never unlink on reconciliation') }
    }
    const cold = new ReadOnlyRetry(f.user, f.authorize, f.locks), result = await cold.delete(request)
    expect(result).toMatchObject({ state: 'unknown', observedRevisionHash: saved.ref.revisionHash })
    expect((await stat(saved.path)).ino).toBe(before.ino)
    expect((await stat(saved.path)).mtimeMs).toBe(before.mtimeMs)
    expect(await cold.delete(request)).toEqual(result)
    expect(await readFile(saved.path, 'utf8')).toBe(saved.draft.source)
  })
  it('reconciles a lost receipt by absence, but does not unlink a later replacement', async () => {
    const f = await fixture()
    class LostReceipt extends WorkflowTemplateStore {
      protected override async saveDeletion(id: string, record: WorkflowTemplateDeletionRecord) {
        if (record.phase === 'complete') throw new Error('fixture lost delete receipt')
        await super.saveDeletion(id, record)
      }
    }
    for (const replacement of [false, true]) {
      const saved = await f.initial(), request = { ref: saved.ref, commandId: randomUUID() }
      expect((await new LostReceipt(f.user, f.authorize, f.locks).delete(request)).state).toBe('unknown')
      const later = saved.draft.source + ' '
      if (replacement) await writeFile(saved.path, later)
      const cold = new WorkflowTemplateStore(f.user, f.authorize, f.locks), result = await cold.delete(request)
      if (replacement) {
        expect(result).toMatchObject({ state: 'unknown', observedRevisionHash: hash(later) })
        expect(await readFile(saved.path, 'utf8')).toBe(later)
      } else expect(result).toEqual({ state: 'deleted', ref: saved.ref, verification: 'reconciled_absence' })
    }
  })
  it('reconciles absence without recreating a removed definition directory in either domain', async () => {
    const f = await fixture()
    class LostReceipt extends WorkflowTemplateStore {
      protected override async saveDeletion(id: string, record: WorkflowTemplateDeletionRecord) {
        if (record.phase === 'complete') throw new Error('lost receipt')
        await super.saveDeletion(id, record)
      }
    }
    for (const scope of [{ kind: 'personal' } as const, f.scope]) {
      const saved = await f.initial(scope), request = { ref: saved.ref, commandId: randomUUID() }
      expect((await new LostReceipt(f.user, f.authorize, f.locks).delete(request)).state).toBe('unknown')
      await rm(dirname(saved.path), { recursive: true })
      expect(await new WorkflowTemplateStore(f.user, f.authorize, f.locks).delete(request)).toMatchObject({ state: 'deleted', verification: 'reconciled_absence' })
      await expect(stat(dirname(saved.path))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
  it('does not certify interrupted deletion without the retained baseline evidence', async () => {
    const f = await fixture(), saved = await f.initial(), request = { ref: saved.ref, commandId: randomUUID() }
    class LostReceipt extends WorkflowTemplateStore {
      protected override async saveDeletion(id: string, record: WorkflowTemplateDeletionRecord) {
        if (record.phase === 'complete') throw new Error('lost receipt')
        await super.saveDeletion(id, record)
      }
    }
    expect((await new LostReceipt(f.user, f.authorize, f.locks).delete(request)).state).toBe('unknown')
    await rm(join(f.user, 'workflows', 'template-data', 'history', saved.ref.domainId, saved.ref.templateId, saved.ref.revisionHash + '.json'))
    await expect(new WorkflowTemplateStore(f.user, f.authorize, f.locks).delete(request)).rejects.toThrow('收据校验失败')
  })
  it('serializes deletion against project publication across two userData domains', async () => {
    const f = await fixture(), saved = await f.initial()
    const secondUser = join(f.root, 'second-user'); await mkdir(secondUser)
    let entered!: () => void, release!: () => void
    const paused = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    class PausedDelete extends WorkflowTemplateStore {
      protected override async removeDefinition(path: string) { entered(); await gate; await super.removeDefinition(path) }
    }
    const first = new PausedDelete(f.user, f.authorize, f.locks), second = new WorkflowTemplateStore(secondUser, f.authorize, f.locks)
    const draft = await second.saveDraft({ scope: f.scope, base: saved.ref, source: JSON.stringify({ ...JSON.parse(saved.draft.source), name: 'competing publisher' }) })
    const deleting = first.delete({ ref: saved.ref, commandId: randomUUID() })
    try {
      await Promise.race([paused, deleting.then(() => { throw new Error('fixture did not pause') })])
      await expect(second.publish(publication(draft))).rejects.toMatchObject({ code: 'ELOCKTIMEOUT' })
      expect(await readFile(saved.path, 'utf8')).toBe(saved.draft.source)
    } finally { release(); expect((await deleting).state).toBe('deleted') }
    expect((await second.publish(publication(draft))).state).toBe('conflict')
  })
  it('reauthorizes cached receipts and history, rejecting foreign domains and missing local history', async () => {
    const f = await fixture(), saved = await f.initial(), request = { ref: saved.ref, commandId: randomUUID() }
    const anotherUser = join(f.root, 'fresh-user'); await mkdir(anotherUser)
    const empty = new WorkflowTemplateStore(anotherUser, f.authorize, f.locks)
    expect((await empty.history(f.scope, saved.ref.templateId)).revisions).toEqual([])
    expect(await empty.revision(saved.ref)).toBeNull()
    await expect(empty.restoreDraft({ ref: saved.ref, base: saved.ref })).rejects.toThrow('没有保留的源码')
    await expect(f.store.revision({ ...saved.ref, domainId: 'a'.repeat(64) })).rejects.toThrow()
    expect((await f.store.delete(request)).state).toBe('deleted')
    f.revoke()
    await expect(f.store.delete(request)).rejects.toThrow('unauthorized')
    await expect(f.store.history(f.scope, saved.ref.templateId)).rejects.toThrow('unauthorized')
    await expect(f.store.revision(saved.ref)).rejects.toThrow('unauthorized')
    await expect(f.store.restoreDraft({ ref: saved.ref, base: null })).rejects.toThrow('unauthorized')
  })
  it('fails closed on corrupted or symlinked history and on corrupted deletion receipts', async () => {
    const f = await fixture(), saved = await f.initial(), request = { ref: saved.ref, commandId: randomUUID() }
    const content = join(f.user, 'workflows', 'template-data', 'content', saved.ref.revisionHash + '.txt')
    await writeFile(content, 'corrupt')
    await expect(f.store.revision(saved.ref)).rejects.toThrow()
    await expect(f.store.restoreDraft({ ref: saved.ref, base: saved.ref })).rejects.toThrow()
    await writeFile(content, saved.draft.source)
    const index = join(f.user, 'workflows', 'template-data', 'history', saved.ref.domainId, saved.ref.templateId, saved.ref.revisionHash + '.json')
    const bytes = await readFile(index)
    await rm(index); const outside = join(f.other, 'index.json'); await writeFile(outside, bytes); await symlink(outside, index)
    await expect(f.store.revision(saved.ref)).rejects.toThrow()
    await rm(index); await writeFile(index, bytes)
    const receiptDir = join(f.user, 'workflows', 'template-data', 'deletions'); await mkdir(receiptDir)
    await writeFile(join(receiptDir, request.commandId + '.json'), JSON.stringify({ version: 1, commandId: request.commandId, fingerprint: hash(JSON.stringify(saved.ref)), ref: saved.ref, phase: 'complete', result: { state: 'deleted', ref: saved.ref, verification: 'invented' } }))
    await expect(f.store.delete(request)).rejects.toThrow()
    expect(await readFile(saved.path, 'utf8')).toBe(saved.draft.source)
  })
  it('paginates retained refs without parsing every source, rejecting a missing or unrelated restoration base', async () => {
    const f = await fixture(), saved = await f.initial()
    const dir = join(f.user, 'workflows', 'template-data', 'history', saved.ref.domainId, saved.ref.templateId)
    const refs: WorkflowTemplateRef[] = [saved.ref]
    for (let index = 0; index < 102; index++) {
      const text = JSON.stringify({ ...JSON.parse(saved.draft.source), name: 'page-' + index }), revisionHash = hash(text), ref = { ...saved.ref, revisionHash }
      refs.push(ref)
      await writeFile(join(f.user, 'workflows', 'template-data', 'content', revisionHash + '.txt'), text)
      await writeFile(join(dir, revisionHash + '.json'), JSON.stringify({ ref, sourceHash: revisionHash }))
    }
    const first = await f.store.history(f.scope, saved.ref.templateId), second = await f.store.history(f.scope, saved.ref.templateId, first.nextCursor)
    expect(first.revisions).toHaveLength(100); expect(second.revisions).toHaveLength(3)
    expect([...first.revisions, ...second.revisions].map(ref => ref.revisionHash)).toEqual(refs.map(ref => ref.revisionHash).sort())
    expect(second.nextCursor).toBeUndefined()
    await expect(f.store.history(f.scope, saved.ref.templateId, '../escape')).rejects.toThrow()
    await expect(f.store.restoreDraft({ ref: saved.ref, base: null })).rejects.toThrow('修订已变化')
    await expect(f.store.restoreDraft({ ref: saved.ref, base: { ...saved.ref, templateId: randomUUID() } })).rejects.toThrow()
    expect((await readdir(join(f.user, 'workflows', 'template-data', 'drafts')))).toHaveLength(1)
  })
})
