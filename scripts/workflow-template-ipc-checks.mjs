import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ledger = async path => {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

/** Current production main/preload and canonical Interpreter/Runner, fresh
 * fixture directories. These data-only templates never call a Provider. */
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
  const workflow = (method, ...args) => evaluate(`window.scry.workflow.${method}(...${JSON.stringify(args)})`)
  const instanceRequest = { source: { kind: 'saved', ref: snapshot.ref }, commandId: 'template-instance-production', cwd: fixture.templateWorkspace,
    userGoal: 'Frozen instance IPC fixture', parameters: { message: 'frozen input' }, orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [] }
  const instance = await workflow('instantiateTemplate', instanceRequest)
  assert.equal(instance.state, 'ready', JSON.stringify(instance.unavailableReasons))
  assert.equal(instance.program.template.origin.kind, 'saved')
  assert.equal(instance.program.roles[0].runtimeIdentity, instance.roles[0].runtimeIdentity)
  assert.ok(instance.program.roles[0].runtimeIdentity)
  const initial = JSON.parse(await readFile(join(fixture.userData, 'workflows', instance.workflowId + '.json'), 'utf8'))
  assert.equal(initial.progress.state, 'awaiting_approval')
  assert.equal(initial.progress.dispatchAttempts, 0)
  assert.equal(initial.execution, undefined)
  const edited = await invoke('saveDraft', { scope: personal, base: snapshot.ref, source: JSON.stringify({ ...JSON.parse(snapshot.source), name: 'reviewed candidate' }) })
  const external = JSON.stringify({ ...JSON.parse(snapshot.source), name: 'external editor' })
  await writeFile(join(fixture.userData, 'workflows', 'templates', personalDraft.templateId + '.json'), external)
  assert.equal((await invoke('publish', request(edited))).state, 'conflict')
  assert.equal((await invoke('read', personal, personalDraft.templateId)).source, external)
  assert.equal((await invoke('draft', edited.draftId)).source, edited.source)
  const current = await invoke('read', personal, personalDraft.templateId)
  const history = await invoke('history', personal, personalDraft.templateId)
  assert.ok(history.revisions.some(ref => ref.revisionHash === snapshot.ref.revisionHash))
  assert.equal((await invoke('revision', snapshot.ref)).source, snapshot.source)
  const restoration = await invoke('restoreDraft', { ref: snapshot.ref, base: current.ref })
  assert.equal(restoration.source, snapshot.source)
  assert.equal(restoration.templateId, personalDraft.templateId)
  assert.equal((await invoke('read', personal, personalDraft.templateId)).source, external)
  assert.equal((await invoke('delete', { ref: snapshot.ref, commandId: 'stale-template-delete' })).state, 'conflict')
  const deletionRequest = { ref: current.ref, commandId: 'confirmed-template-delete' }
  const deletion = await invoke('delete', deletionRequest)
  assert.equal(deletion.state, 'deleted')
  assert.equal(await invoke('read', personal, personalDraft.templateId), null)
  assert.equal((await invoke('revision', snapshot.ref)).source, snapshot.source)
  assert.equal((await invoke('publish', request(restoration))).state, 'conflict')
  assert.deepEqual(await workflow('preview', instance.workflowId), instance)
  const approval = { workflowId: instance.workflowId, programRevision: instance.programRevision, approvedAt: 1 }
  assert.equal(await workflow('approve', approval), true)
  const completed = await workflow('start', instance.workflowId, approval, 'template-instance-start')
  assert.equal(completed.state, 'completed')
  assert.equal(completed.finalReport, 'frozen input')
  assert.equal(completed.dispatchAttempts, 0)
  assert.deepEqual(await workflow('instantiateTemplate', instanceRequest), instance)
  const onlyRun = await workflow('instantiateTemplate', { ...instanceRequest, commandId: 'template-only-run-production',
    source: { kind: 'draft', draftId: edited.draftId, draftRevision: edited.draftRevision, candidateHash: edited.candidateHash }, parameters: { message: 'only this run' } })
  assert.equal(onlyRun.program.template.origin.kind, 'draft')
  const onlyApproval = { workflowId: onlyRun.workflowId, programRevision: onlyRun.programRevision, approvedAt: 1 }
  await workflow('approve', onlyApproval)
  assert.equal((await workflow('start', onlyRun.workflowId, onlyApproval, 'template-only-run-start')).finalReport, 'only this run')
  assert.equal(await invoke('read', personal, personalDraft.templateId), null)
  const restoredAfterDelete = await invoke('restoreDraft', { ref: snapshot.ref, base: null })
  assert.equal(restoredAfterDelete.templateId, personalDraft.templateId)
  assert.equal((await invoke('publish', request(restoredAfterDelete))).state, 'published')
  assert.deepEqual(await invoke('delete', deletionRequest), deletion)
  assert.equal(await readFile(join(fixture.userData, 'workflows', 'templates', personalDraft.templateId + '.json'), 'utf8'), snapshot.source)
  const nestedDefinition = { ...definition, name: 'Nested collection authority IPC', parameters: {}, body: { kind: 'sequence', blockId: 'nested_root', blocks: [
    { kind: 'bind', blockId: 'input', value: { kind: 'literal', value: [{ id: 'group-a', rows: [{ id: 'a', flag: 0 }, { id: 'b', flag: false }] }] } },
    { kind: 'map', blockId: 'groups', items: { kind: 'ref', name: 'input' }, item: 'group', key: ['id'], maxItems: 1, body:
      { kind: 'map', blockId: 'rows', items: { kind: 'field', source: { kind: 'ref', name: 'group' }, path: ['rows'] }, item: 'row', key: ['id'], maxItems: 2,
        body: { kind: 'bind', blockId: 'copy', value: { kind: 'ref', name: 'row' } } } },
    { kind: 'collect', blockId: 'group_outcomes', items: { kind: 'ref', name: 'groups' } },
    { kind: 'bind', blockId: 'selected', value: { kind: 'field', source: { kind: 'ref', name: 'group_outcomes' }, path: ['0', 'value'] } },
    { kind: 'map', blockId: 'consume', items: { kind: 'ref', name: 'selected' }, item: 'member', key: ['key'], maxItems: 2,
      body: { kind: 'bind', blockId: 'flag', value: { kind: 'field', source: { kind: 'ref', name: 'member' }, path: ['value', 'flag'] } } },
    { kind: 'collect', blockId: 'flags', items: { kind: 'ref', name: 'consume' } },
    { kind: 'return', blockId: 'nested_report', ref: { nodeId: 'flags' } }
  ] } }
  const nestedDraft = await invoke('saveDraft', { scope: personal, source: JSON.stringify(nestedDefinition) })
  assert.equal(nestedDraft.validation.state, 'valid')
  const nested = await workflow('instantiateTemplate', { ...instanceRequest, commandId: 'nested-collection-instance', parameters: {},
    source: { kind: 'draft', draftId: nestedDraft.draftId, draftRevision: nestedDraft.draftRevision, candidateHash: nestedDraft.candidateHash } })
  assert.equal(nested.state, 'ready')
  const nestedApproval = { workflowId: nested.workflowId, programRevision: nested.programRevision, approvedAt: 1 }
  await workflow('approve', nestedApproval)
  const nestedResult = await workflow('start', nested.workflowId, nestedApproval, 'nested-collection-start')
  assert.equal(nestedResult.state, 'completed')
  assert.deepEqual(JSON.parse(nestedResult.finalReport).map(row => row.value), [0, false])
  assert.equal(nestedResult.dispatchAttempts, 0)
  assert.deepEqual(await Promise.all(ledgers.map(ledger)), before, 'template publication must not invoke any Provider')
  return { test: 'template publication production preload/main IPC', personalAndProject: true, saveAsNewIdentity: true, exactSource: true, duplicateReceipt: true, externalConflict: true, frozenInstantiation: true, onlyThisRun: true, canonicalRunner: true, nestedCollectionProjection: true, retainedHistory: true, restorationDraft: true, deleteCAS: true, duplicateDeleteSafe: true, providerInvocations: 0 }
}
