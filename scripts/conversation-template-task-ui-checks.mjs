import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Real renderer input; the scripted bridge is not production Main evidence. */
export async function checkConversationTemplateTaskUi(win, temp, { read, wait, click, key, type, queue, send, frame, snapshot }) {
  const command = '  /scry-workflow template personal:00000000-0000-4000-8000-000000000005 {"goal":"<frozen>"}  '
  const submission = {
    reference: { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'template-ui-one' },
    instanceCommandId: 'template-instance-ui-one',
    size: { state: 'available', snapshot: { value: 'medium', source: 'default', fingerprint: '0'.repeat(64) }, readAt: 1 },
    template: { state: 'available', name: 'Frozen template', roles: ['orchestrator', 'worker'],
      ref: { scope: { kind: 'personal' }, domainId: 'a'.repeat(64),
        templateId: '00000000-0000-4000-8000-000000000005', revisionHash: 'b'.repeat(64) } }
  }
  const prepare = '[data-workflow-action=prepare-template]'
  const open = async (id, extra = {}) => {
    const next = { ...submission, reference: { ...submission.reference, commandId: id }, instanceCommandId: id, ...extra }
    await type(command)
    await queue({ kind: 'control', commandId: id, action: 'open_workflow_template', command, workspace: '/synthetic/command-ui', submission: next })
    await send()
    await wait('document.querySelector("[data-workflow-action=prepare-template]")')
    return next
  }
  const choose = async role => {
    // Closed-select typeahead uses the existing workflow fixture's native input
    // path. Opening an OS popup in a hidden window is not a supported driver.
    await read(`document.querySelector('[data-workflow-role="${role}"] select').focus()`)
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 's' })
    try { await wait(`document.querySelector('[data-workflow-role="${role}"] select').value==='codex'`) }
    catch (error) {
      await writeFile(join(temp, 'template-role-selection.json'), JSON.stringify(await read('({active:document.activeElement?.outerHTML,roles:Array.from(document.querySelectorAll("[data-workflow-role] select")).map(e=>({value:e.value,disabled:e.disabled}))})'), null, 2))
      throw error
    }
  }
  const baseline = await snapshot()
  const original = await open('template-instance-ui-one')
  assert.equal((await snapshot()).controls.length, baseline.controls.length, 'unbound template must not discover a default provider')
  assert.equal(await read('Array.from(document.querySelectorAll("[data-workflow-role] select")).every(e=>e.value==="")'), true)
  assert.equal(await read(`document.querySelector('${prepare}').disabled`), true)
  assert.equal(await read('document.querySelector(".conversation-task-input").textContent'), command)
  assert.equal(await read('document.querySelector(".conversation-task-input").children.length'), 0, 'raw input must be escaped text')
  assert.equal(await read('window.conversationCommandFixture.draft()'), command, 'fixed template entry must retain its draft')
  await choose('orchestrator')
  assert.equal(await read(`document.querySelector('${prepare}').disabled`), true, 'all declared roles require explicit binding')
  await choose('worker')
  await wait('!document.querySelector("[data-workflow-action=prepare-template]").disabled')
  win.setSize(430, 900)
  await wait('innerWidth===430')
  await frame()
  assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true, 'template input and revision must fit narrow view')
  const rawInput = await read('(()=>{const e=document.querySelector(".conversation-task-input"),s=getComputedStyle(e);return {height:e.clientHeight,scrollHeight:e.scrollHeight,lineHeight:parseFloat(s.lineHeight),flexShrink:s.flexShrink}})()')
  await writeFile(join(temp, 'template-task-input-layout.json'), JSON.stringify(rawInput, null, 2))
  assert.equal(rawInput.height >= rawInput.lineHeight, true, 'immutable raw command must remain visibly readable, not shrink to zero')
  await writeFile(join(temp, 'template-task-narrow.png'), (await win.webContents.capturePage()).toPNG())
  await click(prepare)
  await wait('document.querySelector("[data-workflow-action=approve]")')
  let calls = await snapshot()
  assert.equal(calls.templatePreparations.length, baseline.templatePreparations.length + 1)
  const request = calls.templatePreparations.at(-1)
  assert.deepEqual(request.reference, original.reference)
  assert.deepEqual(Object.keys(request).sort(), ['orchestrator', 'reference', 'roles'])
  assert.equal(request.orchestrator.providerId, 'codex')
  assert.deepEqual(request.roles.map(role => [role.role, role.providerId]), [['worker', 'codex']])
  assert.equal(calls.workflowPlans.length, baseline.workflowPlans.length, 'fixed template must not invoke model planning')
  assert.equal(calls.approvals.length, baseline.approvals.length, 'preparation is not approval')
  assert.equal(calls.starts.length, baseline.starts.length)
  assert.equal(await read('document.querySelector("[data-workflow-action=reconfigure]")===null'), true, 'fixed source must not switch to a model planner')
  await click('[data-workflow-action=approve]')
  await wait('!document.querySelector(".workflow-modal")')
  calls = await snapshot()
  assert.equal(calls.approvals.length, baseline.approvals.length + 1)
  assert.equal(calls.starts.length, baseline.starts.length + 1)
  assert.equal(calls.approvals.at(-1)[0].programRevision, 'synthetic-template-revision')
  assert.equal(calls.starts.at(-1)[0], 'synthetic-template-workflow')
  assert.equal(calls.starts.at(-1)[1].programRevision, 'synthetic-template-revision')
  win.setSize(1280, 960)
  await wait('innerWidth===1280')

  const cancelled = await open('template-instance-ui-cancel')
  await choose('orchestrator'); await choose('worker')
  await wait('!document.querySelector("[data-workflow-action=prepare-template]").disabled')
  await read('window.conversationCommandFixture.holdTemplatePreparation()')
  await click(prepare)
  await wait(`window.conversationCommandFixture.calls.templatePreparations.length===${baseline.templatePreparations.length + 2}`)
  key('Escape')
  await wait('!document.querySelector(".workflow-modal")')
  assert.deepEqual((await snapshot()).cancellations.at(-1), [cancelled.instanceCommandId, cancelled.reference])
  await read('window.conversationCommandFixture.releaseTemplatePreparation()')
  await frame()
  assert.equal(await read('document.querySelector(".workflow-modal")===null'), true, 'cancelled late preparation must not open approval')
  assert.equal((await snapshot()).starts.length, baseline.starts.length + 1)
  assert.equal(await read('document.activeElement===document.querySelector("textarea[aria-label=描述任务]")'), true, 'cancel must restore composer focus')

  await open('template-instance-ui-unavailable', { template: { state: 'unavailable', ref: submission.template.ref, reason: 'Synthetic retained history unavailable' } })
  assert.equal(await read('document.querySelector(".workflow-modal [role=alert]").textContent'), 'Synthetic retained history unavailable')
  assert.equal(await read(`document.querySelector('${prepare}').disabled`), true)
  key('Escape')
  await wait('!document.querySelector(".workflow-modal")')
  const final = await snapshot()
  assert.equal(final.workflowPlans.length, baseline.workflowPlans.length)
  assert.equal(final.previews, baseline.previews, 'template intake must not prepare a native conversation')
  assert.equal(final.metadata.length, baseline.metadata.length)
  return { explicitRoles: true, frozenRawCommand: true, noModelPlanner: true, exactRevisionApproval: true,
    cancelledLateResultFenced: true, unavailableHistoryBlocked: true, narrowNoOverflow: true }
}
