import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ledger = async path => {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

/** Current production main/preload, fresh fixture directories, no model requests. */
export async function exerciseWorkflowTemplatePublication(evaluate, fixture) {
  const invoke = (method, ...args) => evaluate(`window.scry.workflow.templates.${method}(...${JSON.stringify(args)})`)
  const ledgers = [fixture.inputsFile, fixture.callsFile]
  const before = await Promise.all(ledgers.map(ledger))
  const definition = { schemaVersion: 1, name: 'Template IPC fixture', description: '', parameters: { message: { schema: { type: 'string' }, default: 'seed' } }, roles: [],
    body: { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'bind', blockId: 'answer', value: { kind: 'ref', name: 'message' } }, { kind: 'return', blockId: 'finish', ref: { nodeId: 'answer' } }] } }
  const personal = { kind: 'personal' }, project = { kind: 'project', workspace: fixture.templateWorkspace }
  const personalDraft = await invoke('saveDraft', { scope: personal, source: JSON.stringify(definition) })
  assert.equal(personalDraft.validation.state, 'valid')
  assert.equal(JSON.parse(personalDraft.source).templateId, personalDraft.templateId)
  const request = draft => ({ draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId: `template-publish-${draft.draftId}` })
  const publication = await invoke('publish', request(personalDraft))
  assert.equal(publication.state, 'published')
  const snapshot = await invoke('read', personal, personalDraft.templateId)
  assert.equal(snapshot.state, 'valid')
  assert.equal(snapshot.source, personalDraft.source)
  assert.equal(await readFile(join(fixture.userData, 'workflows', 'templates', personalDraft.templateId + '.json'), 'utf8'), snapshot.source)
  assert.deepEqual(await invoke('publish', request(personalDraft)), publication)
  const sharedDraft = await invoke('saveDraft', { scope: project, source: personalDraft.source })
  assert.notEqual(sharedDraft.templateId, personalDraft.templateId)
  assert.equal((await invoke('publish', request(sharedDraft))).state, 'published')
  assert.equal((await invoke('read', project, sharedDraft.templateId)).source, sharedDraft.source)
  assert.ok((await invoke('list', project)).templateIds.includes(sharedDraft.templateId))
  const edited = await invoke('saveDraft', { scope: personal, base: snapshot.ref, source: JSON.stringify({ ...JSON.parse(snapshot.source), name: 'reviewed candidate' }) })
  const external = JSON.stringify({ ...JSON.parse(snapshot.source), name: 'external editor' })
  await writeFile(join(fixture.userData, 'workflows', 'templates', personalDraft.templateId + '.json'), external)
  assert.equal((await invoke('publish', request(edited))).state, 'conflict')
  assert.equal((await invoke('read', personal, personalDraft.templateId)).source, external)
  assert.equal((await invoke('draft', edited.draftId)).source, edited.source)
  assert.deepEqual(await Promise.all(ledgers.map(ledger)), before, 'template publication must not invoke any Provider')
  return { test: 'template publication production preload/main IPC', personalAndProject: true, saveAsNewIdentity: true, exactSource: true, duplicateReceipt: true, externalConflict: true, providerInvocations: 0 }
}
