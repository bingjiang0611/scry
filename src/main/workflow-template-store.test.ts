import { randomUUID, createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowTemplateDraft, WorkflowTemplateScope } from '../shared/workflow-template'
import { WORKFLOW_TEMPLATE_MAX_BYTES } from '../shared/workflow-template'
import { WorkflowTemplateStore, type WorkflowTemplatePublicationRecord } from './workflow-template-store'
import { validateWorkflowTemplate } from './workflow-template-definition'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const source = (name = 'Portable template') => JSON.stringify({ schemaVersion: 1, name, description: '', parameters: { message: { schema: { type: 'string' }, default: 'seed' } }, roles: [],
  body: { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'bind', blockId: 'answer', value: { kind: 'ref', name: 'message' } }, { kind: 'return', blockId: 'finish', ref: { nodeId: 'answer' } }] } })
const publishRequest = (draft: WorkflowTemplateDraft, commandId = randomUUID()) => ({ draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId })
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-template-store-'))); roots.push(root)
  const userData = join(root, 'user'), project = join(root, 'project'), other = join(root, 'other')
  await Promise.all([userData, project, other].map(path => mkdir(path)))
  const authorize = (path: string) => { if (![project, other].includes(path)) throw new Error('unauthorized project'); return path }
  const store = new WorkflowTemplateStore(userData, authorize)
  const scope: WorkflowTemplateScope = { kind: 'project', workspace: project }
  return { root, userData, project, other, scope, authorize, store }
}
async function initial(f: Awaited<ReturnType<typeof setup>>, scope: WorkflowTemplateScope = f.scope) {
  const draft = await f.store.saveDraft({ scope, source: source() })
  const publication = await f.store.publish(publishRequest(draft))
  expect(publication.state).toBe('published')
  if (publication.state !== 'published') throw new Error('fixture publication failed')
  return { draft, ref: publication.ref, path: scope.kind === 'project' ? join(scope.workspace, '.scry-workflows', draft.templateId + '.json') : join(f.userData, 'workflows', 'templates', draft.templateId + '.json') }
}
const renameSource = (draft: WorkflowTemplateDraft, name: string) => JSON.stringify({ ...JSON.parse(draft.source), name })

describe('portable template definitions and durable publication', () => {
  it('assigns identity before review and preserves exact bytes across cold reads in both domains', async () => {
    const f = await setup()
    for (const scope of [{ kind: 'personal' } as const, f.scope]) {
      const saved = await initial(f, scope)
      const cold = new WorkflowTemplateStore(f.userData, f.authorize)
      const loaded = await cold.read(scope, saved.draft.templateId)
      expect(loaded?.state).toBe('valid')
      expect(loaded?.source).toBe(saved.draft.source)
      expect(loaded?.ref.revisionHash).toBe(createHash('sha256').update(saved.draft.source).digest('hex'))
      expect(await readFile(saved.path, 'utf8')).toBe(saved.draft.source)
      expect((await cold.list(scope)).templateIds).toEqual([saved.draft.templateId])
    }
  })
  it('hashes actual UTF-8 bytes without silently removing an external editor BOM', async () => {
    const f = await setup(), saved = await initial(f), external = '\uFEFF' + saved.draft.source
    await writeFile(saved.path, external)
    const snapshot = await f.store.read(f.scope, saved.draft.templateId)
    expect(snapshot?.source).toBe(external)
    expect(snapshot?.ref.revisionHash).toBe(createHash('sha256').update(await readFile(saved.path)).digest('hex'))
    expect(snapshot?.state).toBe('invalid')
  })
  it('retains invalid drafts privately and repairs incomplete text without publishing or changing identity', async () => {
    const f = await setup()
    const invalid = await f.store.saveDraft({ scope: f.scope, source: '{' })
    expect(invalid.validation.state).toBe('invalid')
    await expect(f.store.publish(publishRequest(invalid))).rejects.toThrow()
    await expect(access(join(f.project, '.scry-workflows'))).rejects.toMatchObject({ code: 'ENOENT' })
    const valid = await f.store.saveDraft({ scope: f.scope, source: source(), draftId: invalid.draftId, expectedDraftRevision: invalid.draftRevision })
    expect(valid.templateId).toBe(invalid.templateId)
    expect(valid.validation.state).toBe('valid')
    expect(valid.draftRevision).toBe(2)
    expect((await f.store.publish(publishRequest(valid))).state).toBe('published')
  })
  it('rejects stale editor revisions and stale reviewed candidates rather than saving newer text implicitly', async () => {
    const f = await setup(), draft = await f.store.saveDraft({ scope: f.scope, source: source() })
    const next = await f.store.saveDraft({ scope: f.scope, draftId: draft.draftId, expectedDraftRevision: 1, source: renameSource(draft, 'new') })
    await expect(f.store.saveDraft({ scope: f.scope, draftId: draft.draftId, expectedDraftRevision: 1, source: draft.source })).rejects.toThrow('草稿已变化')
    await expect(f.store.publish(publishRequest(draft))).rejects.toThrow('草稿已变化')
    expect((await f.store.draft(draft.draftId)).source).toBe(next.source)
    await expect(access(join(f.project, '.scry-workflows'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('serializes competing publishers across store instances and preserves the losing candidate', async () => {
    const f = await setup(), saved = await initial(f), other = new WorkflowTemplateStore(f.userData, f.authorize)
    const a = await f.store.saveDraft({ scope: f.scope, base: saved.ref, source: renameSource(saved.draft, 'A') })
    const b = await other.saveDraft({ scope: f.scope, base: saved.ref, source: renameSource(saved.draft, 'B') })
    const results = await Promise.all([f.store.publish(publishRequest(a)), other.publish(publishRequest(b))])
    expect(results.map(value => value.state).sort()).toEqual(['conflict', 'published'])
    const winner = results.findIndex(value => value.state === 'published')
    expect(await readFile(saved.path, 'utf8')).toBe([a, b][winner].source)
    expect((await other.draft([a, b][1 - winner].draftId)).source).toBe([a, b][1 - winner].source)
  })
  it('keeps a paused project publisher exclusive across two userData domains', async () => {
    const f = await setup(), saved = await initial(f)
    const secondUser = join(f.root, 'second-publisher'); await mkdir(secondUser)
    let entered!: () => void, release!: () => void
    const paused = new Promise<void>(resolve => { entered = resolve }), continueWrite = new Promise<void>(resolve => { release = resolve })
    class PausedStore extends WorkflowTemplateStore {
      protected override async replace(path: string, source: string) {
        entered(); await continueWrite
        await super.replace(path, source)
      }
    }
    const first = new PausedStore(f.userData, f.authorize), second = new WorkflowTemplateStore(secondUser, f.authorize)
    const a = await first.saveDraft({ scope: f.scope, base: saved.ref, source: renameSource(saved.draft, 'first') })
    const b = await second.saveDraft({ scope: f.scope, base: saved.ref, source: renameSource(saved.draft, 'second') })
    const publication = first.publish(publishRequest(a))
    try {
      await Promise.race([paused, publication.then(() => { throw new Error('fixture publisher did not pause') })])
      await expect(second.publish(publishRequest(b))).rejects.toMatchObject({ code: 'ELOCKTIMEOUT' })
      expect(await readFile(saved.path, 'utf8')).toBe(saved.draft.source)
    } finally { release(); expect((await publication).state).toBe('published') }
    expect(await readFile(saved.path, 'utf8')).toBe(a.source)
  })
  it('re-reads external edits by content and refuses overwrites without trusting mtime or a cached definition', async () => {
    const f = await setup(), saved = await initial(f)
    const draft = await f.store.saveDraft({ scope: f.scope, base: saved.ref, source: renameSource(saved.draft, 'candidate') })
    const external = renameSource(saved.draft, 'external')
    await writeFile(saved.path, external)
    expect((await f.store.publish(publishRequest(draft))).state).toBe('conflict')
    expect((await f.store.read(f.scope, saved.draft.templateId))?.source).toBe(external)
    expect(await readFile(saved.path, 'utf8')).toBe(external)
  })
  it('deduplicates a durable command after restart and never reapplies it over later external changes', async () => {
    const f = await setup(), draft = await f.store.saveDraft({ scope: f.scope, source: source() }), request = publishRequest(draft)
    const first = await f.store.publish(request), path = join(f.project, '.scry-workflows', draft.templateId + '.json')
    const external = renameSource(draft, 'later external')
    await writeFile(path, external)
    const cold = new WorkflowTemplateStore(f.userData, f.authorize)
    expect(await cold.publish({ commandId: request.commandId, candidateHash: request.candidateHash, draftRevision: request.draftRevision, draftId: request.draftId })).toEqual(first)
    expect(await readFile(path, 'utf8')).toBe(external)
    await expect(cold.publish({ ...request, candidateHash: 'a'.repeat(64) })).rejects.toThrow('commandId')
  })
  it('reconciles an interrupted receipt only from exact current content, without repeating the file write', async () => {
    const f = await setup()
    class ReceiptFailure extends WorkflowTemplateStore {
      protected override async savePublication(commandId: string, record: WorkflowTemplatePublicationRecord) {
        if (record.phase === 'complete') throw new Error('fixture receipt failure')
        await super.savePublication(commandId, record)
      }
    }
    const failing = new ReceiptFailure(f.userData, f.authorize)
    const draft = await failing.saveDraft({ scope: f.scope, source: source() }), request = publishRequest(draft)
    expect((await failing.publish(request)).state).toBe('unknown')
    const path = join(f.project, '.scry-workflows', draft.templateId + '.json'), before = await stat(path)
    const result = await f.store.publish(request)
    expect(result).toMatchObject({ state: 'published', verification: 'reconciled_content' })
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(path, 'utf8')).toBe(draft.source)
  })
  it('does not retry an intent with no observable publication or create its project directory on reconciliation', async () => {
    const f = await setup()
    class AfterIntentFailure extends WorkflowTemplateStore {
      protected override async savePublication(commandId: string, record: WorkflowTemplatePublicationRecord) {
        await super.savePublication(commandId, record)
        if (record.phase === 'intent') throw new Error('fixture exit before project write')
      }
    }
    const failing = new AfterIntentFailure(f.userData, f.authorize)
    const draft = await failing.saveDraft({ scope: f.scope, source: source() }), request = publishRequest(draft)
    await expect(failing.publish(request)).rejects.toThrow('before project write')
    const result = await f.store.publish(request)
    expect(result.state).toBe('unknown')
    expect(await f.store.publish(request)).toEqual(result)
    await expect(access(join(f.project, '.scry-workflows'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps personal data out of a project copy and rebinds shared definitions to the new project domain', async () => {
    const f = await setup(), project = await initial(f), personal = await initial(f, { kind: 'personal' })
    const secondUser = join(f.root, 'second-user'); await mkdir(secondUser)
    await cp(join(f.project, '.scry-workflows'), join(f.other, '.scry-workflows'), { recursive: true })
    const second = new WorkflowTemplateStore(secondUser, f.authorize)
    const imported = await second.read({ kind: 'project', workspace: f.other }, project.draft.templateId)
    expect(imported?.source).toBe(project.draft.source)
    expect(imported?.ref.domainId).not.toBe(project.ref.domainId)
    expect(await second.read({ kind: 'personal' }, personal.draft.templateId)).toBeNull()
    await expect(second.saveDraft({ scope: { kind: 'personal' }, base: personal.ref, source: personal.draft.source })).rejects.toThrow()
  })
  it('rejects unauthorized scopes, path identities, directory links and file links without touching their targets', async () => {
    const f = await setup(), outside = join(f.root, 'outside'); await mkdir(outside)
    await expect(f.store.saveDraft({ scope: { kind: 'project', workspace: outside }, source: source() })).rejects.toThrow('unauthorized')
    await expect(f.store.read(f.scope, '../escape')).rejects.toThrow()
    await symlink(outside, join(f.project, '.scry-workflows'))
    const draft = await f.store.saveDraft({ scope: f.scope, source: source() })
    await expect(f.store.publish(publishRequest(draft))).rejects.toThrow('拒绝链接')
    await rm(join(f.project, '.scry-workflows')); await mkdir(join(f.project, '.scry-workflows'))
    const victim = join(outside, 'victim.json'); await writeFile(victim, 'do not change')
    await symlink(victim, join(f.project, '.scry-workflows', draft.templateId + '.json'))
    await expect(f.store.read(f.scope, draft.templateId)).rejects.toThrow('拒绝链接')
    await expect(f.store.publish(publishRequest(draft))).rejects.toThrow('拒绝链接')
    expect(await readFile(victim, 'utf8')).toBe('do not change')
  })
  it('rejects oversized sources and corrupted immutable draft content instead of falling back to empty data', async () => {
    const f = await setup()
    await expect(f.store.saveDraft({ scope: f.scope, source: 'x'.repeat(WORKFLOW_TEMPLATE_MAX_BYTES + 1) })).rejects.toThrow('4 MiB')
    const draft = await f.store.saveDraft({ scope: f.scope, source: source() })
    const sourceHash = createHash('sha256').update(draft.source).digest('hex')
    await writeFile(join(f.userData, 'workflows', 'template-data', 'content', sourceHash + '.txt'), '{}')
    await expect(f.store.draft(draft.draftId)).rejects.toThrow('校验失败')
    await expect(f.store.publish(publishRequest(draft))).rejects.toThrow('校验失败')
  })
  it('paginates identifiers without parsing entire definitions and rejects unsupported versions on open', async () => {
    const f = await setup(), path = join(f.project, '.scry-workflows'); await mkdir(path)
    const ids = Array.from({ length: 101 }, () => randomUUID()).sort()
    await Promise.all(ids.map(id => writeFile(join(path, id + '.json'), '{"schemaVersion":999}')))
    const page = await f.store.list(f.scope)
    expect(page.templateIds).toEqual(ids.slice(0, 100))
    expect((await f.store.list(f.scope, page.nextCursor)).templateIds).toEqual(ids.slice(100))
    expect(await f.store.read(f.scope, ids[0])).toMatchObject({ state: 'invalid' })
  })
  it('checks parameter scopes and rejects private runtime/profile/permission fields and executable instructions', async () => {
    const f = await setup(), draft = await f.store.saveDraft({ scope: f.scope, source: source() })
    const valid = JSON.parse(draft.source)
    expect(validateWorkflowTemplate(draft.source, draft.templateId).body.kind).toBe('sequence')
    for (const mutation of [
      { ...valid, sessionId: 'private' },
      { ...valid, roles: [{ role: 'worker', providerId: 'pi', agentProfileId: 'private', permissionMode: 'full_access' }] },
      { ...valid, parameters: {} },
      { ...valid, body: { kind: 'eval', blockId: 'script', code: 'process.exit()' } }
    ]) expect(() => validateWorkflowTemplate(JSON.stringify(mutation), draft.templateId)).toThrow()
  })
})
