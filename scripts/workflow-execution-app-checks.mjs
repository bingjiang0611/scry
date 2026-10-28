import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exerciseRecordedOutputs } from './workflow-output-app-checks.mjs'

/** Real renderer/preload/Main and durable native-only root; no new execution. */
export async function exerciseWorkflowExecutionInspection({ workflow, evaluate, wait, click, workflowId, agentWorkflowId, userData, evidence, readInputs }) {
  const path = join(userData, 'workflows', workflowId + '.json')
  const before = await readFile(path, 'utf8')
  const record = JSON.parse(before)
  const calls = (await readInputs()).length
  const query = { workflowId, programRevision: record.preview.programRevision, kind: 'systems' }
  const page = await workflow('inspectExecution', query)
  assert.equal(page.state, 'available')
  assert.equal(page.source, 'canonical_ledger')
  assert.equal(page.total, record.systemIntents.length)
  assert.ok(page.records.length > 0 && page.records.length <= 32)
  for (const row of page.records) {
    const intent = record.systemIntents.find(intent => intent.stepId === row.stepId)
    assert.equal(row.intent.state, 'available')
    assert.equal(row.intent.value.programRevision, intent.programRevision)
    assert.equal(row.intent.value.frame.frameId, intent.frameId)
    const outcome = record.systemOutcomes.find(outcome => outcome.stepId === row.stepId)
    assert.equal(row.outcome.state, outcome ? 'available' : 'unavailable')
    if (outcome) {
      assert.equal(row.outcome.value.state, outcome.state)
      assert.equal(row.outcome.value.settled, outcome.settled)
      for (const field of ['check', 'stdout', 'stderr', 'diagnostics', 'replica', 'verification', 'inputSnapshot']) assert.equal(Object.hasOwn(row.outcome.value, field), false)
    }
  }
  assert.deepEqual((await workflow('inspectExecution', { ...query, kind: 'attempts' })).records, [])
  assert.equal((await workflow('inspectExecution', { ...query, programRevision: 'f'.repeat(64) })).reason, 'source_changed')
  await assert.rejects(() => workflow('inspectExecution', { ...query, cwd: '/outside' }))
  const card = `[data-workflow-id=${JSON.stringify(workflowId)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(card)}))`), 'native-only history card')
  if (!await evaluate(`document.querySelector(${JSON.stringify(card)}).open`)) await click(card + ' summary')
  await click(`[data-workflow-inspection-open=${JSON.stringify(workflowId)}]`)
  await wait(() => evaluate('Boolean(document.querySelector(".workflow-program-code textarea"))'), 'frozen program source')
  assert.deepEqual(await evaluate('JSON.parse(document.querySelector(".workflow-program-code textarea").value)'), record.preview.program.body)
  await click('[data-workflow-inspection-tab=history]')
  await wait(() => evaluate('document.querySelector(".workflow-execution-history")?.textContent.includes("此范围尚无")'), 'genuine zero Agent records')
  await click('[data-workflow-inspection-kind=systems]')
  await wait(() => evaluate(`document.querySelectorAll('[data-workflow-inspection-record]').length === ${page.records.length}`), 'canonical system rows')
  const first = page.records.find(row => row.intent.value.frame.state === 'available')
  assert.ok(first)
  const frameId = first.intent.value.frame.frameId
  const output = await exerciseRecordedOutputs({ workflow, userData, record, frameId, agentWorkflowId })
  await click(`[data-workflow-inspection-frame=${JSON.stringify(frameId)}]`)
  await wait(() => evaluate(`Boolean(document.querySelector('[data-workflow-frame=${JSON.stringify(frameId)}]'))`), 'canonical nested control instance')
  const frameBody = output.outputs.find(row => row.request.selection.kind === 'frame').response
  assert.equal(frameBody.state, 'available')
  await click(`[data-workflow-frame-output=${JSON.stringify(frameId)}]`)
  await wait(() => evaluate(`document.querySelector('.workflow-output-inspector textarea')?.value === ${JSON.stringify(frameBody.content)}`), 'real Main frame result body')
  await click('.workflow-output-inspector [data-workflow-output-action=close]')
  await wait(() => evaluate('!document.querySelector(".workflow-output-inspector") && Boolean(document.querySelector(".workflow-frame-inspector"))'), 'output closes without closing frame')
  await click('[data-workflow-frame-action=close]')
  await wait(() => evaluate('!document.querySelector(".workflow-frame-inspector") && Boolean(document.querySelector(".workflow-execution-inspector"))'), 'parent inspection retained')
  const stdout = output.outputs.find(row => row.request.selection.kind === 'system' && row.request.selection.field === 'stdout')
  assert.equal(stdout.response.state, 'available')
  await click(`[data-workflow-inspection-record=${JSON.stringify(stdout.request.selection.stepId)}] [data-workflow-inspection-output=stdout]`)
  await wait(() => evaluate('Boolean(document.querySelector(".workflow-output-inspector [data-workflow-output-page]"))'), 'native recorded stdout body')
  if (stdout.response.content === '') assert.equal(await evaluate('document.querySelector(".workflow-output-inspector").textContent.includes("已记录为空内容")'), true)
  else assert.equal(await evaluate('document.querySelector(".workflow-output-inspector textarea").value'), stdout.response.content)
  await click('.workflow-output-inspector [data-workflow-output-action=close]')
  await wait(() => evaluate('!document.querySelector(".workflow-output-inspector")'), 'native stdout closed')
  await click('[data-workflow-inspection-action=close]')
  await wait(() => evaluate('!document.querySelector(".workflow-execution-inspector")'), 'readonly inspection closed')
  assert.equal(await readFile(path, 'utf8'), before, 'inspecting cannot rewrite canonical ledger bytes')
  assert.equal((await readInputs()).length, calls, 'inspection cannot dispatch a Provider')
  const result = { workflowId, programRevision: query.programRevision, records: page.records, output, exactSource: true, nativeOnlyEmptyAgents: true,
    payloadsExcluded: true, nestedFrame: frameId, sourceChangedRefused: true, extraAuthorityRejected: true, ledgerBytesUnchanged: true, additionalProviderCalls: 0 }
  await writeFile(join(evidence, 'execution-inspection.json'), JSON.stringify(result, null, 2))
  return result
}
