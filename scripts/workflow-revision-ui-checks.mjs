import assert from 'node:assert/strict'
import { readWorkflowRevisionRecord, assertWorkflowRevisionCopies } from './workflow-revision-ipc-checks.mjs'

/** Reuse the fixture's trusted pointer/keyboard path, not programmatic click(). */
export async function exerciseWorkflowRevisionEditor(cdp, evaluate, fixture, { click, replace, key, capture, wait }) {
  const json = JSON.stringify, id = fixture.workflowRevision.workflowId
  const root = `[data-workflow-id=${json(id)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(root)}))`), 'same-root revision progress entry')
  if (!await evaluate(`document.querySelector(${json(root)}).open`)) await click(root + ' summary')
  const before = await readWorkflowRevisionRecord(fixture)
  const open = async () => {
    await click(root + ' [data-workflow-action="revise"]')
    await wait(() => evaluate(`Boolean(document.querySelector('.workflow-revision-editor textarea:not([readonly])'))`), 'editable revision source')
    assert.equal(await evaluate(`document.querySelector('.workflow-revision-editor').contains(document.activeElement)`), true)
  }
  await open()
  const text = await evaluate(`document.querySelector('.workflow-revision-editor textarea').value`)
  const source = JSON.parse(text)
  assert.deepEqual(Object.keys(source).sort(), ['body', 'roles', 'userGoal'])
  assert.ok(!text.includes('runtimeIdentity') && !text.includes('authorization'))
  await replace('.workflow-revision-editor textarea', 'not-json')
  await click('[data-workflow-action="prepare-revision"]')
  await wait(() => evaluate(`Boolean(document.querySelector('.workflow-revision-editor [role="alert"]'))`), 'invalid source error')
  assert.deepEqual(await readWorkflowRevisionRecord(fixture), before, 'invalid editor text cannot mutate or dispatch')
  source.body.blocks.at(-1).blockId = 'ui_reviewed_report'
  const reviewedSource = JSON.stringify(source, null, 2)
  await replace('.workflow-revision-editor textarea', reviewedSource)
  await click('[data-workflow-action="prepare-revision"]')
  await wait(() => evaluate(`Boolean(document.querySelector('[data-workflow-action="confirm-revision"]:not([disabled])'))`), 'main-prepared revision review')
  assert.deepEqual(await readWorkflowRevisionRecord(fixture), before, 'reviewing a frozen candidate is not execution')
  const candidate = JSON.parse(await evaluate(`document.querySelector('.workflow-revision-editor textarea[readonly]').value`))
  assert.equal(candidate.workflowId, id)
  assert.equal(candidate.workspace, fixture.workspace)
  assert.equal(candidate.body.blocks.at(-1).blockId, 'ui_reviewed_report')
  assert.ok(candidate.body.blocks.find(block => block.kind === 'check').authorization.executableHash)
  await capture('workflow-revision-reviewed')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate(`(() => { const modal = document.querySelector('.workflow-revision-editor'), box = modal.getBoundingClientRect(), text = modal.querySelector('textarea').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && text.left >= box.left && text.right <= box.right })()`), true)
  await capture('workflow-revision-narrow')
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await key('Tab', 'Tab', 9)
  assert.equal(await evaluate(`document.querySelector('.workflow-revision-editor').contains(document.activeElement)`), true)
  await key('Escape', 'Escape', 27)
  await wait(() => evaluate(`!document.querySelector('.workflow-revision-editor')`), 'revision review dismissed without approval')
  assert.deepEqual(await readWorkflowRevisionRecord(fixture), before)
  assert.equal(await evaluate(`document.activeElement.matches('[data-workflow-action="revise"]')`), true, 'dialog restores original control focus')
  await open()
  await replace('.workflow-revision-editor textarea', reviewedSource)
  await click('[data-workflow-action="prepare-revision"]')
  await wait(() => evaluate(`Boolean(document.querySelector('[data-workflow-action="confirm-revision"]:not([disabled])'))`), 'second explicit review')
  await click('[data-workflow-action="confirm-revision"]')
  await wait(async () => {
    const record = await readWorkflowRevisionRecord(fixture)
    return record.revisions.length === 3 && record.progress.state === 'completed'
  }, 'approved revision canonical completion')
  await wait(() => evaluate(`!document.querySelector('.workflow-revision-editor')`), 'revision completion closes editor')
  const record = await readWorkflowRevisionRecord(fixture)
  assert.equal(record.preview.program.programRevision, candidate.programRevision)
  assert.equal(record.preview.program.body.blocks.at(-1).blockId, 'ui_reviewed_report')
  assert.equal(record.execution.segments.length, 3)
  assert.equal(record.progress.dispatchAttempts, 0)
  assert.equal(record.systemIntents.length, 6)
  assert.deepEqual(record.systemOutcomes.slice(0, 4), before.systemOutcomes)
  await assertWorkflowRevisionCopies(fixture, record, 3)
  await capture('workflow-revision-completed')
  return { trustedPointerAndKeyboard: true, invalidSourceNoEffects: true, completeFrozenReview: true,
    explicitExecutionApproval: true, responsiveViewport: true, focusContainedAndRestored: true, cancelledReviewNoEffects: true,
    sameRootRevisions: 3, freshNativeExecutions: 3, agentAttempts: 0 }
}
