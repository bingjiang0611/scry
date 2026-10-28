import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const contentIdentity = text => createHash('sha256').update(text, 'utf16le').digest('hex')
const stable = ({ observedAt: _time, ...page }) => page

/** Independent readback of explicitly issued content addresses, never a directory/frame scan. */
export async function exerciseRecordedOutputs({ workflow, userData, record, frameId, agentWorkflowId }) {
  const directory = join(userData, 'workflows'), outputs = []
  async function value(reference, workflowId) {
    assert.equal(reference.workflowId, workflowId)
    const name = `${workflowId}.${createHash('sha256').update(reference.key).digest('hex')}.${reference.hash}.value.json`
    const bytes = await readFile(join(directory, name))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.hash)
    return JSON.parse(bytes.toString('utf8'))
  }
  async function compare(owner, selection, expected, sourceRevision, captureTruncated) {
    const request = { workflowId: owner.preview.workflowId, programRevision: owner.preview.programRevision, selection }
    const response = await workflow('inspectOutput', request)
    if (expected.state === 'unknown') assert.equal(response.reason, 'value_unknown')
    else {
      // These fixed native fixtures fit one page; long durable Unicode paging has a separate real-store test.
      assert.ok(expected.content.length <= 8192, 'Extend native readback to paging if this fixture grows')
      assert.equal(response.state, 'available')
      assert.equal(response.content, expected.content)
      assert.equal(response.total, expected.content.length)
      assert.equal(response.contentKind, expected.contentKind)
      assert.equal(response.contentHashEncoding, 'utf16le')
      assert.equal(response.contentHash, contentIdentity(expected.content))
      assert.deepEqual(response.sourceRevision, { state: 'available', programRevision: sourceRevision })
      if (captureTruncated !== undefined) assert.equal(response.captureTruncated, captureTruncated)
    }
    outputs.push({ request, response: stable(response) })
  }
  const check = record.systemOutcomes.findLast(outcome => outcome.check)
  assert.ok(check)
  const intent = record.systemIntents.findLast(intent => intent.stepId === check.stepId)
  for (const field of ['result', 'stdout', 'stderr']) {
    const reference = field === 'result' ? check.resultRef : field === 'stdout' ? check.check.stdoutRef : check.check.stderrRef
    const selection = { kind: 'system', stepId: check.stepId, field }
    if (!reference) {
      const request = { workflowId: record.preview.workflowId, programRevision: record.preview.programRevision, selection }
      const response = await workflow('inspectOutput', request)
      assert.equal(response.reason, 'output_missing')
      outputs.push({ request, response: stable(response) })
      continue
    }
    const evaluation = await value(reference, record.preview.workflowId)
    const expected = evaluation.state === 'unknown' ? evaluation : { state: 'known', contentKind: field === 'result' ? 'json' : 'text',
      content: field === 'result' ? JSON.stringify(evaluation.value) : evaluation.value }
    await compare(record, selection, expected, intent.programRevision, check.check.truncated)
  }
  const frame = JSON.parse(await readFile(join(directory, `${record.preview.workflowId}.${frameId}.frame.json`), 'utf8'))
  assert.equal(frame.workflowId, record.preview.workflowId)
  assert.ok(frame.resultRef)
  const evaluation = await value(frame.resultRef, frame.workflowId)
  await compare(record, { kind: 'frame', frameId }, evaluation.state === 'unknown' ? evaluation
    : { state: 'known', contentKind: 'json', content: JSON.stringify(evaluation.value) }, frame.programRevision)
  const agentFile = join(directory, agentWorkflowId + '.json'), before = await readFile(agentFile, 'utf8'), agent = JSON.parse(before)
  const outcome = [...new Map(agent.outcomes.map(outcome => [outcome.attemptId, outcome])).values()].find(outcome => outcome.outputRef)
  assert.ok(outcome, 'The existing offline sibling must have a durable recorded Agent body')
  assert.ok(outcome.outputRef.startsWith(agentWorkflowId + '.' + outcome.attemptId + '.'))
  const raw = JSON.parse(await readFile(join(directory, outcome.outputRef), 'utf8'))
  const artifactHash = outcome.outputRef.split('.').at(-3)
  assert.equal(createHash('sha256').update(raw.output).digest('hex'), artifactHash)
  const admitted = agent.intents.findLast(intent => intent.attemptId === outcome.attemptId)
  await compare(agent, { kind: 'attempt', attemptId: outcome.attemptId }, { state: 'known', contentKind: 'text', content: raw.output }, admitted.programRevision)
  assert.equal(await readFile(agentFile, 'utf8'), before)
  const query = outputs[0].request
  assert.equal((await workflow('inspectOutput', { ...query, programRevision: 'f'.repeat(64) })).reason, 'source_changed')
  await assert.rejects(() => workflow('inspectOutput', { ...query, valueRef: check.check.stdoutRef }))
  await assert.rejects(() => workflow('inspectOutput', { ...query, offset: 1 }))
  return { outputs, canonicalArtifactHashesVerified: true, utf16ContentIdentityVerified: true, logicalSelectionsOnly: true, agentLedgerUnchanged: true }
}

export async function verifyRecordedOutputsCold(workflow, result) {
  for (const row of result.outputs) assert.deepEqual(stable(await workflow('inspectOutput', row.request)), row.response, 'Cold read preserves exact recorded output and provenance')
  result.coldBodiesPreserved = true
}
