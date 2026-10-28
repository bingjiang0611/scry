import assert from 'node:assert/strict'

/** Cold inspection observes exact retained edit and candidate evidence without dispatch. */
export async function checkColdWorkflowTemplateEditApp({ evaluate, readInputs, conversationId, templateEdit, expectedCalls }) {
  const tasks = await evaluate(`window.scry.workflow.capturedTasks(${JSON.stringify(conversationId)})`)
  const rows = tasks.items.filter(task => templateEdit.taskIds.includes(task.submissionId))
  assert.equal(rows.length, 2)
  assert.ok(rows.every(task => task.operation === 'template_edit' && task.phase === 'captured'))
  const inspection = await evaluate(`window.scry.workflow.inspectTask(${JSON.stringify(rows[0].reference)})`)
  assert.equal(inspection.outcome.kind, 'configure')
  const candidateReference = rows.find(task => task.submissionId === templateEdit.candidateTaskId)?.reference
  assert.ok(candidateReference)
  const candidate = await evaluate(`window.scry.workflow.inspectTask(${JSON.stringify(candidateReference)})`)
  assert.equal(candidate.authoring.state, 'available')
  assert.equal(candidate.authoring.attempt.state.kind, 'candidate')
  assert.equal(candidate.authoring.attempt.state.archiveRef, templateEdit.candidateArchive)
  assert.equal(candidate.authoring.applications[0].state.kind, 'applied')
  assert.equal(candidate.authoring.applications[0].state.draftId, templateEdit.appliedDraftId)
  const targetlessReference = tasks.items.find(task => task.submissionId === templateEdit.targetlessTaskId)?.reference
  assert.ok(targetlessReference)
  const targetless = await evaluate(`window.scry.workflow.inspectTask(${JSON.stringify(targetlessReference)})`)
  assert.deepEqual(targetless.submission.selection, { kind: 'unselected' })
  assert.equal(targetless.authoring.attempt.attemptId, 'offline-targetless-edit-candidate')
  assert.ok(targetless.edit.snapshot)
  const draft = await evaluate(`window.scry.workflow.templates.draft(${JSON.stringify(templateEdit.appliedDraftId)})`)
  assert.equal(draft.draftId, templateEdit.appliedDraftId)
  assert.equal(draft.validation.state, 'valid')
  assert.equal((await readInputs()).length, expectedCalls, 'cold edit Task, candidate and draft inspection cannot make a model call')
}

/** Production renderer → preload → Main edit entry; model replies remain explicitly offline. */
export async function checkWorkflowTemplateEditApp({ evaluate, click, wait, input, submit, conversationOf, readInputs, route, conversationId }) {
  const templateId = '341c060d-180c-40ab-945f-a093dca23271'
  const scope = { kind: 'builtin' }
  const before = await evaluate(`window.scry.workflow.templates.read(${JSON.stringify(scope)}, ${JSON.stringify(templateId)})`)
  const calls = (await readInputs()).length
  const tasks = await evaluate(`window.scry.workflow.capturedTasks(${JSON.stringify(conversationId)})`)
  const current = await conversationOf(conversationId)
  const command = await submit(conversationId, current.revision, `/scry-workflow edit builtin:${templateId} retain exact disagreement`)
  assert.equal(command.action, 'edit_workflow_template')
  assert.equal(command.edit.instruction, 'retain exact disagreement')
  assert.deepEqual(command.edit.snapshot.ref, before.ref)
  assert.equal(command.edit.snapshot.source, before.source)
  assert.deepEqual(command.submission.selection, { kind: 'saved', ref: before.ref })
  assert.equal((await readInputs()).length, calls, 'an explicit edit reads the definition without routing or authoring')

  const entry = `.sidebar [data-conversation-id=${JSON.stringify(conversationId)}]`
  await click(entry)
  await wait(() => evaluate(`document.querySelector('.conversation-chat')?.dataset.conversationId === ${JSON.stringify(conversationId)}`), 'edit conversation composer')
  await wait(() => evaluate('!document.querySelector(".conversation-message-choice").disabled'), 'edit composer ready')
  await route({ route: 'template_edit', target: { scope: 'builtin', templateId } })
  const instruction = 'revise the saved template;\n preserve disagreement, do not execute it'
  await click('textarea[aria-label="描述任务"]')
  const selectAll = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: process.platform === 'darwin' ? 4 : 2 }
  await input('Input.dispatchKeyEvent', { type: 'keyDown', ...selectAll, commands: ['selectAll'] })
  await input('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll })
  await wait(() => evaluate(`(() => { const field = document.querySelector('textarea[aria-label="描述任务"]');
    return field.selectionStart === 0 && field.selectionEnd === field.value.length })()`), 'native editing command selects the retained draft')
  await input('Input.insertText', { text: instruction })
  assert.equal(await evaluate('document.querySelector(\'textarea[aria-label="描述任务"]\').value'), instruction)
  await wait(() => evaluate('!document.querySelector("button.send").disabled'), 'natural-language edit ready')
  await click('button.send')
  await wait(() => evaluate('Boolean(document.querySelector(".workflow-workbench .workflow-template-source"))'), 'source-aware edit workbench')
  const view = await evaluate(`(() => {
    const editor = document.querySelector('.workflow-workbench');
    const source = editor.querySelector('.workflow-template-source');
    return { source: source.value, readOnly: source.readOnly, text: editor.innerText,
      instruction: editor.querySelector('.workflow-edit-instruction').textContent,
      executionDialog: Boolean(document.querySelector('.workflow-goal textarea')) };
  })()`)
  assert.equal(view.source, before.source)
  assert.equal(view.readOnly, true, 'builtin is still read-only; a separate draft action is required')
  assert.ok(view.text.includes(before.ref.templateId))
  assert.ok(view.text.includes(before.ref.revisionHash))
  assert.equal(view.instruction, instruction, 'the exact original instruction is retained, not a model rewrite')
  assert.equal(view.executionDialog, false)
  assert.equal((await readInputs()).length, calls + 1, 'recognition spends exactly one call and no implicit authoring/worker call')
  const afterTasks = await evaluate(`window.scry.workflow.capturedTasks(${JSON.stringify(conversationId)})`)
  assert.equal(afterTasks.items.length, tasks.items.length + 2, 'explicit and routed edits each need one durable configuration Task')
  const newTasks = afterTasks.items.filter(task => !tasks.items.some(beforeTask => beforeTask.submissionId === task.submissionId))
  assert.equal(newTasks.length, 2)
  assert.ok(newTasks.every(task => task.operation === 'template_edit' && task.phase === 'captured'))
  const inspections = await evaluate(`Promise.all(${JSON.stringify(newTasks)}.map(task => window.scry.workflow.inspectTask(task.reference)))`)
  const routedTask = inspections.find(task => task.instruction === instruction)
  assert.ok(routedTask, 'routed edit Task must retain its exact instruction')
  assert.deepEqual(routedTask.edit.snapshot.ref, before.ref)
  assert.equal(routedTask.edit.snapshot.source, before.source)
  assert.equal(routedTask.outcome.kind, 'configure')
  assert.equal(routedTask.authoring.state, 'none')
  const draftsBefore = await evaluate('window.scry.workflow.templates.drafts({ kind: "personal" })')
  const candidateDefinition = JSON.parse(before.source)
  candidateDefinition.description = 'Offline read-only edit candidate'
  const candidateSource = JSON.stringify(candidateDefinition, null, 2)
  await route({ source: candidateSource, summary: 'Strengthened evidence while retaining disagreement.' })
  const candidate = await evaluate(`window.scry.workflow.requestTemplateEditCandidate(${JSON.stringify({
    reference: routedTask.task.reference, expectedTaskRevision: routedTask.task.revision, attemptId: 'offline-edit-candidate', author: { providerId: 'codex' },
    disclosure: { acknowledgesModelCall: true, acknowledgesSourceDisclosure: true }
  })})`)
  assert.equal(candidate.state.kind, 'candidate')
  assert.equal(candidate.state.source, candidateSource)
  assert.equal(candidate.state.summary, 'Strengthened evidence while retaining disagreement.')
  assert.deepEqual(candidate.sourceRef, before.ref)
  assert.equal((await readInputs()).length, calls + 2, 'candidate generation adds exactly one explicit disclosed authoring call')
  const observedCandidate = await evaluate(`window.scry.workflow.inspectTask(${JSON.stringify(routedTask.task.reference)})`)
  assert.equal(observedCandidate.authoring.state, 'available')
  assert.equal(observedCandidate.authoring.attempt.state.kind, 'candidate')
  assert.equal(observedCandidate.authoring.attempt.state.source, candidateSource)
  const after = await evaluate(`window.scry.workflow.templates.read(${JSON.stringify(scope)}, ${JSON.stringify(templateId)})`)
  assert.equal(after.source, before.source, 'candidate generation does not publish or change the template')
  assert.deepEqual(await evaluate('window.scry.workflow.templates.drafts({ kind: "personal" })'), draftsBefore, 'candidate generation does not create a draft')
  await input('Emulation.setDeviceMetricsOverride', { width: 430, height: 760, deviceScaleFactor: 1, mobile: false })
  await wait(() => evaluate('innerWidth === 430'), 'narrow desktop viewport applied')
  const narrow = await evaluate(`(() => { const modal = document.querySelector('.workflow-workbench');
    return { page: document.documentElement.scrollWidth <= innerWidth, modal: modal.scrollWidth <= modal.clientWidth + 1,
      instructionWhitespace: getComputedStyle(document.querySelector('.workflow-edit-instruction')).whiteSpace } })()`)
  assert.deepEqual(narrow, { page: true, modal: true, instructionWhitespace: 'pre-wrap' })
  await click('.workflow-workbench-header button')
  await wait(() => evaluate('!document.querySelector(".workflow-workbench")'), 'close unmodified edit at narrow viewport')
  await input('Emulation.clearDeviceMetricsOverride')
  await click('.conversation-workflow-tasks > summary')
  await wait(() => evaluate(`Boolean(document.querySelector('[data-workflow-task=${JSON.stringify(routedTask.task.submissionId)}]'))`), 'durable edit Task row')
  await click(`[data-workflow-task=${JSON.stringify(routedTask.task.submissionId)}]`)
  await wait(() => evaluate('Boolean(document.querySelector("[data-workflow-task-open]"))'), 'durable edit Task inspection')
  await click('[data-workflow-task-open]')
  await wait(() => evaluate('Boolean(document.querySelector(".workflow-workbench .workflow-template-source"))'), 'reopened durable edit workbench')
  const reopened = await evaluate(`(() => { const editor = document.querySelector('.workflow-workbench'); const candidate = editor.querySelector('[aria-label="只读修改候选"]'); return {
    instruction: editor.querySelector('.workflow-edit-instruction').textContent,
    source: editor.querySelector('.workflow-template-source').value,
    readOnly: editor.querySelector('.workflow-template-source').readOnly,
    candidateText: candidate?.innerText ?? '', candidateSource: candidate?.querySelector('textarea[aria-label="候选源码"]')?.value ?? ''
  } })()`)
  assert.deepEqual({ instruction: reopened.instruction, source: reopened.source, readOnly: reopened.readOnly, candidateSource: reopened.candidateSource },
    { instruction, source: before.source, readOnly: true, candidateSource })
  assert.match(reopened.candidateText, /Strengthened evidence while retaining disagreement/)
  await click('.workflow-template-authoring input[type="checkbox"]')
  await wait(() => evaluate('!document.querySelector("[data-template-candidate-apply]").disabled'), 'candidate draft confirmation')
  await click('[data-template-candidate-apply]')
  await wait(() => evaluate('!document.querySelector(".workflow-template-authoring") && !document.querySelector(".workflow-template-source").readOnly'), 'candidate applied to editable draft')
  const appliedDrafts = await evaluate('window.scry.workflow.templates.drafts({ kind: "personal" })')
  assert.equal(appliedDrafts.drafts.length, draftsBefore.drafts.length + 1)
  const appliedDraft = appliedDrafts.drafts.find(draft => !draftsBefore.drafts.some(beforeDraft => beforeDraft.draftId === draft.draftId))
  assert.ok(appliedDraft)
  assert.equal(appliedDraft.validation.state, 'valid')
  assert.notEqual(appliedDraft.templateId, templateId, 'copying a builtin candidate creates a new draft template identity')
  assert.equal((await readInputs()).length, calls + 2, 'candidate-to-draft application is local and adds no Provider call')
  const afterApply = await evaluate(`window.scry.workflow.templates.read(${JSON.stringify(scope)}, ${JSON.stringify(templateId)})`)
  assert.equal(afterApply.source, before.source, 'creating a candidate draft does not change the builtin source')
  await click('.workflow-workbench-header button')
  await wait(() => evaluate('!document.querySelector(".workflow-workbench")'), 'close reopened durable edit')
  await route({ route: 'template_edit' })
  const targetlessConversation = await conversationOf(conversationId)
  const targetless = await submit(conversationId, targetlessConversation.revision, 'edit a workflow template; choose the exact template after capture', false)
  assert.equal(targetless.action, 'edit_workflow_template')
  assert.deepEqual(targetless.submission.selection, { kind: 'unselected' })
  await route({ source: candidateSource, summary: 'Targetless source was selected explicitly after capture.' })
  const targetlessCandidate = await evaluate(`window.scry.workflow.requestTemplateEditCandidate(${JSON.stringify({
    reference: targetless.submission.reference, expectedTaskRevision: 0, attemptId: 'offline-targetless-edit-candidate', author: { providerId: 'codex' }, selection: before.ref,
    disclosure: { acknowledgesModelCall: true, acknowledgesSourceDisclosure: true }
  })})`)
  assert.equal(targetlessCandidate.state.kind, 'candidate')
  assert.deepEqual(targetlessCandidate.sourceRef, before.ref)
  const targetlessInspection = await evaluate(`window.scry.workflow.inspectTask(${JSON.stringify(targetless.submission.reference)})`)
  assert.deepEqual(targetlessInspection.submission.selection, { kind: 'unselected' })
  assert.deepEqual(targetlessInspection.edit.snapshot.ref, before.ref)
  assert.equal(targetlessInspection.authoring.attempt.attemptId, 'offline-targetless-edit-candidate')
  assert.equal((await readInputs()).length, calls + 4, 'targetless capture and explicit source candidate each add one disclosed call')
  return { explicitEditNoModelCall: true, routedEditCalls: 1, originalInstruction: true, sourceRevision: before.ref.revisionHash,
    readOnlyBuiltin: true, durableEditTasks: 2, taskIds: newTasks.map(task => task.submissionId), coldReopen: true,
    noAutomaticSaveOrPublish: true, readOnlyCandidate: true, explicitDraftApplication: true, appliedDraftId: appliedDraft.draftId,
    candidateTaskId: routedTask.task.submissionId, candidateArchive: candidate.state.archiveRef,
    targetlessTaskId: targetless.submission.editCommandId, targetlessCandidate: true,
    narrowNoOverflow: true, providerCalls: calls + 4 }
}
