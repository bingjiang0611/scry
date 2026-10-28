import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowTemplateStore } from './workflow-template-store'
import { builtinTemplateDomain, builtinTemplateIds, candidateReviewTemplateId } from './workflow-template-builtins'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const user = await realpath(await mkdtemp(join(tmpdir(), 'scry-builtin-template-'))); roots.push(user)
  const authorize = vi.fn(() => { throw new Error('must not authorize a filesystem project for builtin data') })
  return { user, authorize, store: new WorkflowTemplateStore(user, authorize) }
}
describe('distributed readonly data through the same template store', () => {
  it('uses fixed identities and exact source revisions independent of userData and exposes real validation', async () => {
    const a = await fixture(), b = await fixture(), scope = { kind: 'builtin' } as const
    expect((await a.store.list(scope)).templateIds).toEqual(builtinTemplateIds)
    const first = (await a.store.read(scope, candidateReviewTemplateId))!, second = (await b.store.read(scope, candidateReviewTemplateId))!
    expect(first).toEqual(second); expect(first.state).toBe('valid')
    expect(first.ref.domainId).toBe(builtinTemplateDomain)
    expect(first.ref.revisionHash).toBe(createHash('sha256').update(first.source).digest('hex'))
    expect((await a.store.history(scope, candidateReviewTemplateId)).revisions).toEqual([first.ref])
    expect(await b.store.revision(first.ref)).toEqual(first)
    // A cursor at the last id has nothing after it; earlier cursors still page.
    expect((await a.store.list(scope, builtinTemplateIds.at(-1)!)).templateIds).toEqual([])
    expect((await a.store.list(scope, builtinTemplateIds[0])).templateIds).toEqual(builtinTemplateIds.slice(1))
    expect(await a.store.read(scope, randomUUID())).toBeNull()
    expect(a.authorize).not.toHaveBeenCalled(); expect(b.authorize).not.toHaveBeenCalled()
  })
  it('returns bounded source-qualified metadata pages without sending complete source bodies', async () => {
    const { store, user } = await fixture(), base = (await store.read({ kind: 'builtin' }, candidateReviewTemplateId))!
    const dir = join(user, 'workflows', 'templates'); await mkdir(dir)
    const ids: string[] = []
    for (let index = 0; index < 19; index++) {
      const id = randomUUID(); ids.push(id)
      await writeFile(join(dir, id + '.json'), JSON.stringify({ ...JSON.parse(base.source), templateId: id, name: 'Same display name' }))
    }
    const first = await store.catalog({ kind: 'personal' }), second = await store.catalog({ kind: 'personal' }, first.nextCursor)
    expect(first.templates).toHaveLength(16); expect(second.templates).toHaveLength(3)
    expect([...first.templates, ...second.templates].map(item => item.ref.templateId)).toEqual(ids.sort())
    for (const item of first.templates) { expect(item).toMatchObject({ state: 'valid', name: 'Same display name', ref: { scope: { kind: 'personal' } } }); expect(item).not.toHaveProperty('source') }
    expect((await store.catalog({ kind: 'builtin' })).templates[0]).toMatchObject({ name: expect.any(String), ref: { scope: { kind: 'builtin' } } })
    expect(second.nextCursor).toBeUndefined()
  })
  it('lists retained invalid drafts without source bodies and reauthorizes their domain before opening', async () => {
    const { store, user } = await fixture()
    const draft = await store.saveDraft({ scope: { kind: 'personal' }, source: '{unfinished' })
    const cold = new WorkflowTemplateStore(user, () => { throw new Error('unauthorized') })
    const page = await cold.drafts({ kind: 'personal' })
    expect(page.drafts).toHaveLength(1)
    expect(page.drafts[0]).toMatchObject({ draftId: draft.draftId, draftRevision: 1, validation: { state: 'invalid' } })
    expect(page.drafts[0]).not.toHaveProperty('source')
    expect(await cold.draft(page.drafts[0].draftId)).toEqual(draft)
    expect(await cold.drafts({ kind: 'builtin' })).toEqual({ drafts: [] })
    await expect(cold.drafts({ kind: 'project', workspace: '/unregistered' })).rejects.toThrow('unauthorized')
  })
  it('keeps project draft names and source private to their authorized domain while consuming all cursors', async () => {
    const { user, store } = await fixture(), source = (await store.read({ kind: 'builtin' }, candidateReviewTemplateId))!.source
    const a = join(user, 'project-a'), b = join(user, 'project-b'); await mkdir(a); await mkdir(b)
    let allowed = true
    const authority = (cwd: string) => { if (!allowed || ![a, b].includes(cwd)) throw new Error('revoked'); return cwd }
    const projects = new WorkflowTemplateStore(user, authority)
    const first = await projects.saveDraft({ scope: { kind: 'project', workspace: a }, source })
    await projects.saveDraft({ scope: { kind: 'project', workspace: b }, source: JSON.stringify({ ...JSON.parse(source), name: 'private other project' }) })
    const metadataDir = join(user, 'workflows', 'template-data', 'drafts'), metadata = JSON.parse(await readFile(join(metadataDir, first.draftId + '.json'), 'utf8'))
    const expected = [first.draftId]
    for (let index = 0; index < 18; index++) { const id = randomUUID(); expected.push(id); await writeFile(join(metadataDir, id + '.json'), JSON.stringify({ ...metadata, draftId: id })) }
    const collected: string[] = []
    let cursor: string | undefined
    do {
      const page = await projects.drafts({ kind: 'project', workspace: a }, cursor)
      expect(page.drafts.length).toBeLessThanOrEqual(16)
      expect(JSON.stringify(page)).not.toContain('private other project')
      collected.push(...page.drafts.map(item => item.draftId)); cursor = page.nextCursor
    } while (cursor)
    expect(collected).toEqual(expected.sort())
    allowed = false
    await expect(projects.draft(first.draftId)).rejects.toThrow('revoked')
    await expect(projects.drafts({ kind: 'project', workspace: a })).rejects.toThrow('revoked')
  })
  it('never treats a builtin scope as a mutable filesystem target, including forged write payloads', async () => {
    const { store, user } = await fixture(), scope = { kind: 'builtin' } as const
    const ref = { scope, templateId: candidateReviewTemplateId, domainId: builtinTemplateDomain, revisionHash: 'a'.repeat(64) }
    await expect(store.delete({ ref, commandId: 'read-only-delete' })).rejects.toThrow('只读')
    await expect(store.restoreDraft({ ref, base: null })).rejects.toThrow('只读')
    await expect(store.saveDraft({ scope, source: '{}' })).rejects.toThrow('只读')
    expect(await readdir(user)).toEqual([])
    await expect(store.read({ kind: 'builtin', workspace: user } as never, candidateReviewTemplateId)).rejects.toThrow()
    await expect(store.revision({ ...ref, domainId: 'b'.repeat(64) })).rejects.toThrow()
  })
  it('saves a new editable identity only after explicit destination selection and preserves the builtin bytes', async () => {
    const { store, user } = await fixture(), original = (await store.read({ kind: 'builtin' }, candidateReviewTemplateId))!
    const draft = await store.saveDraft({ scope: { kind: 'personal' }, source: original.source })
    expect(draft.templateId).not.toBe(original.ref.templateId); expect(draft.validation.state).toBe('valid')
    const published = await store.publish({ draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId: randomUUID() })
    expect(published.state).toBe('published')
    expect(await readFile(join(user, 'workflows', 'templates', draft.templateId + '.json'), 'utf8')).toBe(draft.source)
    expect(await store.read({ kind: 'builtin' }, candidateReviewTemplateId)).toEqual(original)
    if (original.state !== 'valid') throw new Error('invalid fixture builtin')
    original.definition.body.blocks.splice(0)
    const frozen = await store.freeze({ kind: 'saved', ref: original.ref })
    expect(frozen.definition.body.blocks).toHaveLength(3)
    expect(await store.frozen(original.ref)).toEqual(frozen.definition)
  })
})
