import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowOutputInspectionRequest, WorkflowOutputSelection } from '../shared/workflow-output-inspection'
import { WORKFLOW_OUTPUT_INSPECTION_PAGE_SIZE } from '../shared/workflow-output-inspection'
import { FileWorkflowStore } from './workflow-store'
import { fixture as revisionFixture } from './workflow-revision.fixture'
import { fixture as nativeFixture } from './workflow-system.fixture'
import { inspectWorkflowOutput } from './workflow-output-inspection'

const owned: Array<Awaited<ReturnType<typeof revisionFixture>>> = []
afterEach(async () => { await Promise.all(owned.splice(0).map(value => value.cleanup())) })
async function completed(prompt = 'PRIVATE_RECORDED_OUTPUT', file = false) {
  const f = await revisionFixture(file, false, true, { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'call', blockId: 'body', role: 'worker', prompt },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'body' } }
  ] })
  owned.push(f)
  expect((await f.start()).state).toBe('completed')
  f.execute.mockClear()
  const record = await f.record(), attemptId = record.outcomes[0].attemptId
  const query = (selection: WorkflowOutputSelection = { kind: 'attempt', attemptId }): WorkflowOutputInspectionRequest => ({
    workflowId: f.preview.workflowId, programRevision: f.preview.programRevision, selection
  })
  return { ...f, query, attemptId, expected: prompt + '-output' }
}

describe('bounded recorded output inspection', () => {
  it('pages exact durable Unicode content, pins identity, rejects invalid boundaries and survives a cold store', async () => {
    const f = await completed('x'.repeat(WORKFLOW_OUTPUT_INSPECTION_PAGE_SIZE - 1) + '😀tail', true)
    const before = await f.record(), authorize = vi.fn()
    const first = await f.service.inspectOutput(f.query(), authorize)
    expect(first.state).toBe('available')
    if (first.state !== 'available') throw new Error('missing first page')
    expect(first.content).toBe('x'.repeat(WORKFLOW_OUTPUT_INSPECTION_PAGE_SIZE - 1))
    expect(first.nextOffset).toBe(WORKFLOW_OUTPUT_INSPECTION_PAGE_SIZE - 1)
    expect(first.contentHash).toBe(createHash('sha256').update(f.expected, 'utf16le').digest('hex'))
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(authorize.mock.calls).toEqual([[f.workspace], [f.workspace]])
    const cold = new FileWorkflowStore(f.userData)
    const second = await inspectWorkflowOutput(cold, (await cold.load(f.preview.workflowId))!, {
      ...f.query(), offset: first.nextOffset, expectedContentHash: first.contentHash
    }, 2)
    expect(second.state).toBe('available')
    if (second.state !== 'available') throw new Error('missing second page')
    expect(first.content + second.content).toBe(f.expected)
    expect(second.nextOffset).toBeUndefined()
    await expect(f.service.inspectOutput({ ...f.query(), offset: WORKFLOW_OUTPUT_INSPECTION_PAGE_SIZE, expectedContentHash: first.contentHash }, authorize)).rejects.toThrow(/分页位置/)
    await expect(f.service.inspectOutput({ ...f.query(), offset: f.expected.length + 1, expectedContentHash: first.contentHash }, authorize)).rejects.toThrow(/分页位置/)
    expect(await f.service.inspectOutput({ ...f.query(), expectedContentHash: 'a'.repeat(64) }, authorize)).toMatchObject({ state: 'unavailable', reason: 'content_changed' })
    const metadata = await f.service.inspectExecution({ ...f.query(), kind: 'attempts' }, authorize)
    expect(JSON.stringify(metadata)).not.toContain(f.expected.slice(0, 128))
    expect(JSON.stringify(metadata)).not.toMatch(/"(output|outputRef|resultRef|content)":/)
    expect(await f.record()).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('reports changed identity before checking an old offset against shorter content, preserving unpaired UTF-16', async () => {
    const f = await completed('x'.repeat(9000), true)
    const first = await f.service.inspectOutput(f.query(), () => {})
    if (first.state !== 'available' || first.nextOffset === undefined) throw new Error('missing paged body')
    const record = await f.record(), content = 'short\ud800'
    record.outcomes.push({ ...record.outcomes[0], output: content, outputRef: undefined })
    await f.store.save(record)
    expect(await f.service.inspectOutput({ ...f.query(), offset: first.nextOffset, expectedContentHash: first.contentHash }, () => {}))
      .toMatchObject({ state: 'unavailable', reason: 'content_changed' })
    const latest = await f.service.inspectOutput(f.query(), () => {})
    expect(latest).toMatchObject({ state: 'available', content, total: content.length,
      contentHash: createHash('sha256').update(content, 'utf16le').digest('hex') })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('uses the same last canonical outcome as metadata, not an older body with the same logical ID', async () => {
    const f = await completed('first', true), record = await f.record()
    record.outcomes.push({ ...record.outcomes[0], output: 'LATEST_CANONICAL_BODY', outputRef: undefined, state: 'unknown', settled: false })
    await f.store.save(record)
    const metadata = await f.service.inspectExecution({ ...f.query(), kind: 'attempts' }, () => {})
    expect(metadata).toMatchObject({ state: 'available', total: 1, records: [{ outcome: { value: { state: 'unknown', settled: false } } }] })
    expect(await f.service.inspectOutput(f.query(), () => {})).toMatchObject({ state: 'available', content: 'LATEST_CANONICAL_BODY' })
  })

  it('distinguishes a recorded intent without outcome from an absent selection, and retains outcome-only provenance', async () => {
    const f = await completed(), record = await f.record(), outcome = record.outcomes[0]
    record.outcomes = []
    await f.store.save(record)
    expect(await f.service.inspectOutput(f.query(), () => {})).toMatchObject({ state: 'unavailable', reason: 'output_missing', sourceRevision: { state: 'available', programRevision: f.preview.programRevision } })
    expect(await f.service.inspectOutput(f.query({ kind: 'attempt', attemptId: 'absent' }), () => {})).toMatchObject({ state: 'unavailable', reason: 'selection_missing' })
    record.intents = []; record.outcomes = [outcome]
    await f.store.save(record)
    expect(await f.service.inspectOutput(f.query(), () => {})).toMatchObject({ state: 'available', content: f.expected, sourceRevision: { state: 'unavailable', reason: 'missing_intent' } })
  })

  it('verifies durable Agent artifacts even when a live outcome carries an inline body, and rejects corruption', async () => {
    const f = await completed('durable', true), record = await f.record()
    const outcome = { ...record.outcomes[0], output: 'UNCOMMITTED_INLINE_SHADOW' }
    expect(await f.store.loadOutput(f.preview.workflowId, outcome)).toBe(f.expected)
    await writeFile(join(f.userData, 'workflows', outcome.outputRef!), JSON.stringify({ output: 'CORRUPTED_ARTIFACT' }))
    await expect(f.store.loadOutput(f.preview.workflowId, outcome)).rejects.toThrow(/输出/)
    await expect(f.service.inspectOutput(f.query(), () => {})).rejects.toThrow(/输出/)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('authorizes before artifacts and rejects revocation while an asynchronous read is outstanding', async () => {
    const f = await completed(), original = f.store.loadOutput.bind(f.store), load = vi.spyOn(f.store, 'loadOutput')
    await expect(f.service.inspectOutput(f.query(), () => { throw new Error('workspace denied') })).rejects.toThrow('workspace denied')
    expect(load).not.toHaveBeenCalled()
    expect(await f.service.inspectOutput({ ...f.query(), programRevision: 'a'.repeat(64) }, () => {})).toMatchObject({ state: 'unavailable', reason: 'source_changed' })
    expect(load).not.toHaveBeenCalled()
    let release!: () => void, entered!: () => void
    const pending = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
    load.mockImplementation(async (...args) => { entered(); await pending; return original(...args) })
    let authorized = true
    const result = f.service.inspectOutput(f.query(), () => { if (!authorized) throw new Error('workspace revoked') })
    await ready; authorized = false; release()
    await expect(result).rejects.toThrow('workspace revoked')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('reads actual Node stdout/stderr/result and known frame values without re-running a check or Agent', async () => {
    const f = await nativeFixture()
    expect((await f.service.start(f.preview.workflowId, f.approval)).state).toBe('completed')
    const record = (await f.store.load(f.preview.workflowId))!, intent = record.systemIntents!.find(value => value.kind === 'check')!
    const base = { workflowId: f.preview.workflowId, programRevision: f.preview.programRevision }
    const before = structuredClone(record)
    const stdout = await f.service.inspectOutput({ ...base, selection: { kind: 'system', stepId: intent.stepId, field: 'stdout' } }, () => {})
    expect(stdout).toMatchObject({ state: 'available', contentKind: 'text', content: 'observed\n', captureTruncated: false })
    expect(await f.service.inspectOutput({ ...base, selection: { kind: 'system', stepId: intent.stepId, field: 'stderr' } }, () => {})).toMatchObject({ state: 'available', content: '', total: 0 })
    const result = await f.service.inspectOutput({ ...base, selection: { kind: 'system', stepId: intent.stepId, field: 'result' } }, () => {})
    expect(result.state).toBe('available')
    if (result.state !== 'available') throw new Error('missing native result')
    expect(JSON.parse(result.content)).toMatchObject({ passed: true, state: 'passed', settled: true })
    expect(await f.service.inspectOutput({ ...base, selection: { kind: 'frame', frameId: intent.frameId! } }, () => {})).toMatchObject({ state: 'available', contentKind: 'json', sourceRevision: { state: 'available', programRevision: intent.programRevision } })
    const outcome = record.systemOutcomes!.find(value => value.stepId === intent.stepId)!
    const stdoutRef = outcome.check!.stdoutRef
    await f.store.saveValue(base.workflowId, 'unknown-output', { state: 'unknown', reason: 'u'.repeat(4096), derivedFrom: [] }).then(reference => { outcome.check!.stdoutRef = reference })
    await f.store.save(record)
    expect(await f.service.inspectOutput({ ...base, selection: { kind: 'system', stepId: intent.stepId, field: 'stdout' } }, () => {})).toMatchObject({ state: 'unavailable', reason: 'value_unknown', detail: 'u'.repeat(4096) })
    outcome.check!.stdoutRef = outcome.resultRef!
    await f.store.save(record)
    await expect(f.service.inspectOutput({ ...base, selection: { kind: 'system', stepId: intent.stepId, field: 'stdout' } }, () => {})).rejects.toThrow(/类型/)
    outcome.check!.stdoutRef = stdoutRef
    await f.store.save(record)
    expect(await f.store.load(base.workflowId)).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled()
  })
})
