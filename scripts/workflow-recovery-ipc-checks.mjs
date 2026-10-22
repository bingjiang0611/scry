import assert from 'node:assert/strict'
import { readFile, access, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const readLedger = async path => {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

const workflowFiles = async userData => {
  try { return (await readdir(join(userData, 'workflows'))).sort() } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** Actual built main/preload API, but intentionally no Provider or executable run. */
export async function exerciseMissingWorkflowHistory(evaluate, fixture) {
  const id = 'missing-workflow-history-smoke'
  const ledgers = [fixture.inputsFile, fixture.callsFile]
  const before = await Promise.all(ledgers.map(readLedger))
  const filesBefore = await workflowFiles(fixture.userData)
  const recordPath = join(fixture.userData, 'workflows', `${id}.json`)
  await assert.rejects(access(recordPath), { code: 'ENOENT' })
  const approval = { workflowId: id, programRevision: 'missing-revision', approvedAt: 1 }
  for (const commandId of ['missing-history-command', 'missing-history-command', 'missing-history-fresh']) {
    const result = await evaluate(`window.scry.workflow.resume(${JSON.stringify(id)}, ${JSON.stringify(approval)}, ${JSON.stringify(commandId)})`)
    assert.deepEqual(result, { state: 'nothing_to_resume', progress: null })
  }
  assert.equal(await evaluate(`window.scry.workflow.snapshot(${JSON.stringify(id)})`), null)
  await assert.rejects(access(recordPath), { code: 'ENOENT' })
  assert.deepEqual(await workflowFiles(fixture.userData), filesBefore, 'missing history must not synthesize any workflow record')
  assert.deepEqual(await Promise.all(ledgers.map(readLedger)), before, 'missing history must not enter any Provider')
  return { test: 'workflow missing history production preload/main IPC', requests: 3, syntheticRecords: 0, providerInvocations: 0 }
}
