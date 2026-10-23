import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowExpression, WorkflowValue } from '../shared/workflow'
import { WorkflowRunner, WorkflowSlots, type WorkflowProviderExecution, type WorkflowProviderExecutionRequest, type WorkflowProviderExecutionResult } from './workflow-runner'
import { FileWorkflowStore } from './workflow-store'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { workflowFrameId } from './workflow-frames'
import { validateWorkflowValueSchema } from './workflow-values'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const bind = (value: WorkflowValue): WorkflowBlock => ({ kind: 'bind', blockId: 'input', value: { kind: 'literal', value } })
const map = (body: WorkflowBlock, maxItems = 4): Extract<WorkflowBlock, { kind: 'map' }> => ({ kind: 'map', blockId: 'mapped', items: { kind: 'ref', name: 'input' }, item: 'entry', key: ['id'], maxItems, body })
const collect: WorkflowBlock = { kind: 'collect', blockId: 'collected', items: { kind: 'ref', name: 'mapped' } }
const report = (nodeId: string): WorkflowBlock => ({ kind: 'return', blockId: 'report', ref: { nodeId } })
async function fixture(blocks: WorkflowBlock[], execute: (request: WorkflowProviderExecutionRequest) => { result: Promise<WorkflowProviderExecutionResult>; stop: () => boolean }, limit = 2) {
  const root = await mkdtemp(join(tmpdir(), 'scry-workflow-map-')); roots.push(root)
  const role = { role: 'worker' as const, providerId: 'claude' as const, runtimeIdentity: 'fixture' }
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: 'workflow-' + randomUUID(), programRevision: 'pending', userGoal: 'map fixture', workspace: root, roles: [role], body: { kind: 'sequence', blockId: 'root', blocks } })
  const { programRevision: _revision, ...snapshot } = program
  program.programRevision = workflowRevision(snapshot)
  const preview = makePlanPreview(program, [], role)
  const store = new FileWorkflowStore(root), runner = new WorkflowRunner({ store, slots: new WorkflowSlots(limit), execute })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  runner.approve(preview, approval)
  return { root, preview, store, runner, run: () => runner.start(preview, approval) }
}
const effect: WorkflowBlock = { kind: 'call', blockId: 'work', role: 'worker', prompt: 'work', inputRefs: [{ nodeId: 'entry', path: ['id'] }] }

describe('dynamic map / controlled collections', () => {
  it('runs item pipelines across admission windows, without waiting for a slow item to finish a page', async () => {
    let releaseSlow!: (result: WorkflowProviderExecutionResult) => void
    let slowDone = false
    const slow = new Promise<WorkflowProviderExecutionResult>(resolve => { releaseSlow = result => { slowDone = true; resolve(result) } })
    const events: string[] = []
    const execute = vi.fn((request: WorkflowProviderExecutionRequest): WorkflowProviderExecution => {
      const id = request.prompt.includes('\na\n') || request.prompt.endsWith('\na') ? 'a' : request.prompt.includes('\nb\n') || request.prompt.endsWith('\nb') ? 'b' : 'c'
      const stage = request.prompt.startsWith('scan') ? 'scan' : 'verify'
      events.push(stage + '-' + id)
      if (stage === 'scan' && id === 'a') return { result: slow, stop: () => true }
      if (stage === 'verify' && id === 'c') {
        expect(slowDone).toBe(false)
        releaseSlow({ runId: 'slow-a', status: 'completed', output: 'scanned-a', settled: true })
      }
      return { result: Promise.resolve({ runId: request.attemptId, status: 'completed' as const, output: stage + '-' + id, settled: true }), stop: () => true }
    })
    const body: WorkflowBlock = { kind: 'sequence', blockId: 'pipeline', blocks: [
      { kind: 'call', blockId: 'scan', role: 'worker', prompt: 'scan', inputRefs: [{ nodeId: 'entry', path: ['id'] }] },
      { kind: 'call', blockId: 'verify', role: 'worker', prompt: 'verify', inputRefs: [{ nodeId: 'entry', path: ['id'] }, { nodeId: 'scan' }] }
    ] }
    const f = await fixture([bind([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), map(body, 3), collect, report('collected')], execute)
    const result = await f.run()
    expect(result.state).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(6)
    expect(events.indexOf('verify-c')).toBeLessThan(events.indexOf('verify-a'))
    const values = JSON.parse(result.finalReport!)
    expect(values.map((entry: { key: string }) => entry.key)).toEqual(['a', 'b', 'c'])
    expect(values.every((entry: { state: string; settled: boolean }) => entry.state === 'completed' && entry.settled)).toBe(true)
    const parent = await f.store.loadFrame(f.preview.workflowId, workflowFrameId('mapped', ['revision:' + f.preview.programRevision]))
    const value = await new FileWorkflowStore(f.root).loadValue(f.preview.workflowId, parent!.resultRef!)
    expect(value.state === 'known' && value.collection?.count).toBe(3)
    expect(value.state === 'known' && value.collection?.sealed).toBe(true)
  })

  it('retains failed and zero-valued slots; only explicit collect consumes the failed summary', async () => {
    const execute = vi.fn((request: WorkflowProviderExecutionRequest) => ({ result: Promise.resolve(request.prompt.includes('\na\n') || request.prompt.endsWith('\na')
      ? { runId: 'a', status: 'completed' as const, output: '0', settled: true }
      : { runId: 'b', status: 'failed' as const, error: 'fixture failed', settled: true }), stop: () => true }))
    const body: WorkflowBlock = { ...effect, outputSchema: { type: 'number' } }
    const f = await fixture([bind([{ id: 'a' }, { id: 'b' }]), map(body, 2), collect, report('collected')], execute)
    const result = await f.run()
    expect(result.state).toBe('failed')
    const values = JSON.parse(result.finalReport!)
    expect(values).toHaveLength(2)
    expect(values[0]).toMatchObject({ key: 'a', state: 'completed', value: 0 })
    expect(values[1]).toMatchObject({ key: 'b', state: 'failed', error: 'fixture failed' })
    expect(Object.hasOwn(values[1], 'value')).toBe(false)
  })

  it.each([{ rows: [{ id: 'same' }, { id: 'same' }] }, { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }])('refuses duplicate keys or the complete oversized batch before an item dispatch', async ({ rows }) => {
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'must-not-run', status: 'completed' as const, output: 'bad', settled: true }), stop: () => true }))
    const f = await fixture([bind(rows), map(effect, 2), report('mapped')], execute)
    await expect(f.run()).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
    expect((await f.store.load(f.preview.workflowId))?.intents).toEqual([])
  })

  it('accepts sealed empty input but does not turn an unavailable source into empty', async () => {
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'unused', status: 'completed' as const, output: '{}', settled: true }), stop: () => true }))
    const f = await fixture([bind([]), map({ kind: 'bind', blockId: 'item_value', value: { kind: 'ref', name: 'entry' } }, 0), collect, report('collected')], execute)
    expect((await f.run()).finalReport).toBe('[]')
    expect(execute).not.toHaveBeenCalled()
  })

  it('maps a controlled collection by its existing key and loads only each live item payload', async () => {
    const execute = vi.fn((request: WorkflowProviderExecutionRequest) => ({ result: Promise.resolve({ runId: request.attemptId, status: 'completed' as const, output: 'done', settled: true }), stop: () => true }))
    const second: WorkflowBlock = { kind: 'map', blockId: 'remapped', items: { kind: 'ref', name: 'mapped' }, item: 'result_entry', key: ['key'], maxItems: 2,
      body: { kind: 'call', blockId: 'consume', role: 'worker', prompt: 'consume', inputRefs: [{ nodeId: 'result_entry', path: ['value', 'id'] }] } }
    const f = await fixture([bind([{ id: 'a' }, { id: 'b' }]), map({ kind: 'bind', blockId: 'copy', value: { kind: 'ref', name: 'entry' } }, 2), second,
      { ...collect, items: { kind: 'ref', name: 'remapped' } }, report('collected')], execute)
    const progress = await f.run()
    expect(progress.state).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls.map(([request]) => request.prompt)).toEqual(expect.arrayContaining([expect.stringContaining('\na'), expect.stringContaining('\nb')]))
    expect(JSON.parse(progress.finalReport!).map((entry: { key: string }) => entry.key)).toEqual(['a', 'b'])
  })

  it('groups host outcomes without collect and maps each controlled member set', async () => {
    const execute = vi.fn(() => { throw new Error('data-only program must not dispatch') })
    const grouped: WorkflowBlock = { kind: 'bind', blockId: 'grouped', value: { kind: 'group', items: { kind: 'ref', name: 'mapped' }, key: ['value', 'category'] } }
    const readGroups: WorkflowBlock = { kind: 'map', blockId: 'read_groups', items: { kind: 'ref', name: 'grouped' }, item: 'bucket', key: ['key'], maxItems: 2,
      body: { kind: 'sequence', blockId: 'read_group', blocks: [
        { kind: 'map', blockId: 'read_members', items: { kind: 'field', source: { kind: 'ref', name: 'bucket' }, path: ['members'] }, item: 'member', key: ['key'], maxItems: 3,
          body: { kind: 'bind', blockId: 'flag', value: { kind: 'field', source: { kind: 'ref', name: 'member' }, path: ['value', 'flag'] } } },
        { kind: 'collect', blockId: 'member_flags', items: { kind: 'ref', name: 'read_members' } }
      ] } }
    const f = await fixture([bind([{ id: 'a', category: 'same', flag: 0 }, { id: 'b', category: 'same', flag: false }, { id: 'c', category: 'other', flag: true }]),
      map({ kind: 'bind', blockId: 'copy', value: { kind: 'ref', name: 'entry' } }, 3), grouped, readGroups,
      { ...collect, items: { kind: 'ref', name: 'read_groups' } }, report('collected')], execute)
    const result = await f.run()
    expect(result.state).toBe('completed')
    expect(JSON.parse(result.finalReport!).map((row: { value: Array<{ value: WorkflowValue }> }) => row.value.map(member => member.value))).toEqual([[0, false], [true]])
    expect(result.dispatchAttempts).toBe(0)
    expect(execute).not.toHaveBeenCalled()
  })

  it('partitions host outcomes without dropping false, zero or rejected rows', async () => {
    const execute = vi.fn(() => { throw new Error('data-only program must not dispatch') })
    const partitioned: WorkflowBlock = { kind: 'bind', blockId: 'partitioned', value: { kind: 'partition', items: { kind: 'ref', name: 'mapped' }, item: 'candidate',
      when: { kind: 'compare', operator: 'ne', left: { kind: 'field', source: { kind: 'ref', name: 'candidate' }, path: ['value', 'flag'] }, right: { kind: 'literal', value: true } } } }
    const f = await fixture([bind([{ id: 'a', flag: 0 }, { id: 'b', flag: false }, { id: 'c', flag: true }]),
      map({ kind: 'bind', blockId: 'copy', value: { kind: 'ref', name: 'entry' } }, 3), partitioned,
      { kind: 'collect', blockId: 'accepted', items: { kind: 'field', source: { kind: 'ref', name: 'partitioned' }, path: ['matched'] } }, report('accepted')], execute)
    const result = await f.run()
    expect(result.state).toBe('completed')
    expect(JSON.parse(result.finalReport!).map((row: { value: { value: { value: { flag: WorkflowValue } } } }) => row.value.value.value.flag)).toEqual([0, false])
    const record = await f.store.loadFrame(f.preview.workflowId, workflowFrameId('partitioned', ['revision:' + f.preview.programRevision]))
    const value = await new FileWorkflowStore(f.root).loadValue(f.preview.workflowId, record!.resultRef!)
    expect(value.state === 'known' && value.collectionFields?.map(field => [field.path[0], field.collection.count])).toEqual([['matched', 2], ['rejected', 1], ['unknown', 0]])
    expect(execute).not.toHaveBeenCalled()
  })

  it('resolves host operations in loop initial, carry, condition and result without a second evaluator', async () => {
    const execute = vi.fn(() => { throw new Error('data-only program must not dispatch') })
    const partitionCount: WorkflowExpression = { kind: 'count', value: { kind: 'field', source: { kind: 'partition', items: { kind: 'ref', name: 'frozen' }, item: 'candidate',
      when: { kind: 'literal', value: true } }, path: ['matched'] } }
    const groupCount: WorkflowExpression = { kind: 'count', value: { kind: 'field', source: { kind: 'group', items: { kind: 'ref', name: 'frozen' }, key: ['state'] }, path: ['0', 'members'] } }
    const repeated: WorkflowBlock = { kind: 'loop', blockId: 'repeat', invariants: { frozen: { kind: 'ref', name: 'mapped' } }, initial: { kept: partitionCount }, stateSchema: { kept: { type: 'number' } },
      maxIterations: 1, iteration: 'round', outcome: 'loop_status', progress: 'bounded_only',
      body: { kind: 'bind', blockId: 'marker', value: { kind: 'literal', value: true } },
      until: { kind: 'compare', operator: 'eq', left: partitionCount, right: { kind: 'literal', value: 2 } },
      carry: { kept: groupCount }, result: groupCount, policy: { error: 'fail_closed', unknown: 'block', stop: 'cancel', logicalExit: 'report_partial' } }
    const f = await fixture([bind([{ id: 'a', flag: 0 }, { id: 'b', flag: false }]), map({ kind: 'bind', blockId: 'copy', value: { kind: 'ref', name: 'entry' } }), repeated, report('repeat')], execute)
    const result = await f.run()
    expect(result.state).toBe('completed')
    expect(result.finalReport).toBe('2')
    expect(result.dispatchAttempts).toBe(0)
    expect(execute).not.toHaveBeenCalled()
  })

  it('projects a nested host collection through a committed outcome value without losing read authority', async () => {
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'must-not-run', status: 'failed' as const, settled: true }), stop: () => true }))
    const source: WorkflowValue = [{ id: 'group-a', rows: [{ id: 'a', flag: 0 }, { id: 'b', flag: false }] }]
    const nested: WorkflowBlock = { kind: 'map', blockId: 'inner', items: { kind: 'field', source: { kind: 'ref', name: 'entry' }, path: ['rows'] }, item: 'row', key: ['id'], maxItems: 2,
      body: { kind: 'bind', blockId: 'copy_row', value: { kind: 'ref', name: 'row' } } }
    const consume: WorkflowBlock = { kind: 'map', blockId: 'remapped', items: { kind: 'ref', name: 'mapped' }, item: 'group_entry', key: ['key'], maxItems: 1,
      body: { kind: 'sequence', blockId: 'consume_group', blocks: [
        { kind: 'map', blockId: 'read_inner', items: { kind: 'field', source: { kind: 'ref', name: 'group_entry' }, path: ['value'] }, item: 'row_entry', key: ['key'], maxItems: 2,
          body: { kind: 'bind', blockId: 'copy_value', value: { kind: 'field', source: { kind: 'ref', name: 'row_entry' }, path: ['value'] } } },
        { kind: 'collect', blockId: 'inner_rows', items: { kind: 'ref', name: 'read_inner' } }
      ] } }
    const f = await fixture([bind(source), map(nested, 1), consume, { ...collect, items: { kind: 'ref', name: 'remapped' } }, report('collected')], execute)
    const progress = await f.run()
    expect(progress.state).toBe('completed')
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.parse(progress.finalReport!)[0].value.map((row: { value: WorkflowValue }) => row.value)).toEqual([{ id: 'a', flag: 0 }, { id: 'b', flag: false }])
  })

  it.each(['parallel', 'collect'] as const)('retains host authority through %s aggregation and a later map', async kind => {
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'must-not-run', status: 'failed' as const, settled: true }), stop: () => true }))
    const rows: WorkflowValue = [{ id: 'a', flag: 0 }, { id: 'b', flag: false }]
    let source: WorkflowBlock[], path: string[]
    const copy: WorkflowBlock = { kind: 'bind', blockId: 'copy_row', value: { kind: 'ref', name: 'row' } }
    if (kind === 'parallel') {
      source = [bind(rows), { kind: 'parallel', blockId: 'aggregated', blocks: [{ kind: 'map', blockId: 'inner', items: { kind: 'ref', name: 'input' }, item: 'row', key: ['id'], maxItems: 2, body: copy }] }]
      path = ['inner']
    } else {
      source = [bind([{ id: 'group', rows }]), map({ kind: 'map', blockId: 'inner', items: { kind: 'field', source: { kind: 'ref', name: 'entry' }, path: ['rows'] }, item: 'row', key: ['id'], maxItems: 2, body: copy }, 1),
        { kind: 'collect', blockId: 'aggregated', items: { kind: 'ref', name: 'mapped' } }]
      path = ['0', 'value']
    }
    const f = await fixture([...source, { kind: 'bind', blockId: 'selected', value: { kind: 'field', source: { kind: 'ref', name: 'aggregated' }, path } },
      { kind: 'map', blockId: 'consumed', items: { kind: 'ref', name: 'selected' }, item: 'member', key: ['key'], maxItems: 2,
        body: { kind: 'bind', blockId: 'flag', value: { kind: 'field', source: { kind: 'ref', name: 'member' }, path: ['value', 'flag'] } } },
      { kind: 'collect', blockId: 'reported', items: { kind: 'ref', name: 'consumed' } }, report('reported')], execute)
    const progress = await f.run()
    expect(progress.state).toBe('completed')
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.parse(progress.finalReport!).map((entry: { value: WorkflowValue }) => entry.value)).toEqual([0, false])
  })

  it('keeps an unknown result distinct from physical settlement, stops admission and leaves pending slots visible', async () => {
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'unknown-result', status: 'unknown' as const, settled: true }), stop: () => true }))
    const f = await fixture([bind([{ id: 'a' }, { id: 'b' }]), map(effect, 2), collect, report('collected')], execute, 1)
    const progress = await f.run()
    expect(progress.state).toBe('unknown')
    expect(progress.finalReportStatus).toBe('unavailable')
    expect(execute).toHaveBeenCalledTimes(1)
    const frame = await f.store.loadFrame(f.preview.workflowId, workflowFrameId('mapped', ['revision:' + f.preview.programRevision]))
    const value = await f.store.loadValue(f.preview.workflowId, frame!.resultRef!)
    if (value.state !== 'known' || !value.collection) throw new Error('missing collection fixture')
    expect(value.collection.sealed).toBe(false)
    expect(await f.store.loadCollection(f.preview.workflowId, value.collection)).toMatchObject([
      { key: 'a', state: 'unknown', settled: true }, { key: 'b', state: 'pending', settled: false }
    ])
    expect((await f.store.load(f.preview.workflowId))?.intents).toHaveLength(1)
  })

  it('rejects 4097 literal items before execution and blocks a missing dynamic source instead of fabricating empty input', async () => {
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'source', status: 'completed' as const, output: '{}', settled: true }), stop: () => true }))
    await expect(fixture([bind(Array.from({ length: 4097 }, (_, id) => ({ id }))), map(effect), report('mapped')], execute)).rejects.toThrow('上限')
    expect(execute).not.toHaveBeenCalled()
    const f = await fixture([
      { kind: 'call', blockId: 'source', role: 'worker', prompt: 'source', outputSchema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, maxItems: 1 } }, required: [] } },
      { ...map(effect, 1), items: { kind: 'field', source: { kind: 'ref', name: 'source' }, path: ['rows'] } }, report('mapped')
    ], execute)
    expect((await f.run()).state).toBe('blocked')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not accept a literal/model-shaped descriptor as collection authority', async () => {
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'unused', status: 'completed' as const, settled: true }), stop: () => true }))
    await expect(fixture([bind({ kind: 'workflow_collection', count: 0, sealed: true, reference: { workflowId: 'elsewhere', key: 'fake', hash: '0'.repeat(64) } }), map(effect), report('mapped')], execute)).rejects.toThrow()
    expect(() => validateWorkflowValueSchema({ type: 'collection', items: { type: 'number' } })).toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('stores a maximum-size outcome manifest separately from the bounded data value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-workflow-map-manifest-')); roots.push(root)
    const store = new FileWorkflowStore(root)
    const entries = Array.from({ length: 4096 }, (_, index) => ({ key: 'k'.repeat(1000) + index, index, state: 'pending' as const, settled: false }))
    expect(Buffer.byteLength(JSON.stringify(entries))).toBeGreaterThan(4 * 1024 * 1024)
    const reference = await store.saveCollection('workflow-manifest', 'entries', entries, false)
    expect(await new FileWorkflowStore(root).loadCollection('workflow-manifest', reference)).toEqual(entries)
    await expect(store.saveCollection('workflow-manifest', 'too-many', [...entries, { key: 'extra', index: 4096, state: 'pending', settled: false }], false)).rejects.toThrow()
  })

  it('rejects missing collection artifacts on cold read instead of trusting the descriptor count', async () => {
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'unused', status: 'completed' as const, settled: true }), stop: () => true }))
    const f = await fixture([bind([]), map({ kind: 'bind', blockId: 'item_value', value: { kind: 'ref', name: 'entry' } }, 0), report('mapped')], execute)
    await f.run()
    const frame = await f.store.loadFrame(f.preview.workflowId, workflowFrameId('mapped', ['revision:' + f.preview.programRevision]))
    const value = await f.store.loadValue(f.preview.workflowId, frame!.resultRef!)
    if (value.state !== 'known' || !value.collection) throw new Error('missing collection fixture')
    const reference = value.collection.reference
    const file = reference.workflowId + '.' + createHash('sha256').update(reference.key).digest('hex') + '.' + reference.hash + '.collection.json'
    expect(await readdir(join(f.root, 'workflows'))).toContain(file)
    await rm(join(f.root, 'workflows', file))
    await expect(new FileWorkflowStore(f.root).loadValue(f.preview.workflowId, frame!.resultRef!)).rejects.toThrow('缺失')
  })
})
