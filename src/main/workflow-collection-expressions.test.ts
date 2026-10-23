import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKFLOW_MAX_VALUE_BYTES, type WorkflowCollectionEntry, type WorkflowEvaluation, type WorkflowExpression, type WorkflowValue } from '../shared/workflow'
import { workflowExpressionCopy } from '../shared/constants/copy'
import { WorkflowControl } from './workflow-control'
import { collectionEntries } from './workflow-collections'
import { workflowField } from './workflow-expressions'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { FileWorkflowStore } from './workflow-store'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const ref: WorkflowExpression = { kind: 'ref', name: 'input' }
const literal = (value: WorkflowValue): WorkflowExpression => ({ kind: 'literal', value })
const known = (value: WorkflowValue): Extract<WorkflowEvaluation, { state: 'known' }> => ({ state: 'known', value, derivedFrom: [] })
async function fixture(values: WorkflowValue[]) {
  const root = await mkdtemp(join(tmpdir(), 'scry-collection-expressions-')); roots.push(root)
  const role = { role: 'worker' as const, providerId: 'claude' as const, runtimeIdentity: 'fixture' }
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: 'workflow-stream', programRevision: 'pending', userGoal: 'host collection test', workspace: root, roles: [role],
    body: { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'bind', blockId: 'placeholder', value: literal([]) }, { kind: 'return', blockId: 'report', ref: { nodeId: 'placeholder' } }] } })
  const { programRevision: _revision, ...snapshot } = program
  program.programRevision = workflowRevision(snapshot)
  const preview = makePlanPreview(program, [], role), store = new FileWorkflowStore(root), control = new WorkflowControl(store, preview)
  const entries: WorkflowCollectionEntry[] = []
  for (const [index, value] of values.entries()) entries.push({ key: 'item-' + index, index, state: 'completed', settled: true, valueRef: await control.saveCollectionValue(known(value)) })
  const source = await control.collection({ frameId: 'source' }, entries, true)
  control.bind(control.root, 'input', source)
  return { root, store, control, preview, source, entries, run: (expression: WorkflowExpression, stopped = () => false) => control.evaluate(expression, control.root, 'expression', stopped) }
}
const select = (name: string, path: string[]): WorkflowExpression => ({ kind: 'field', source: { kind: 'ref', name }, path })

describe('streaming controlled collection expressions', () => {
  it.each(['group', 'unique', 'filter', 'partition'] as const)('supports %s above the aggregate JSON value bound with one live item read', async kind => {
    const values = [0, false, true].map(flag => ({ flag, category: 'same', payload: 'x'.repeat(1_500_000) }))
    expect(Buffer.byteLength(JSON.stringify(values))).toBeGreaterThan(WORKFLOW_MAX_VALUE_BYTES)
    const f = await fixture(values)
    const load = f.store.loadValue.bind(f.store)
    let active = 0, peak = 0
    const reads = vi.spyOn(f.store, 'loadValue').mockImplementation(async (...args) => {
      active++; peak = Math.max(peak, active)
      try { return await load(...args) } finally { active-- }
    })
    const expression: WorkflowExpression = kind === 'group' || kind === 'unique' ? { kind, items: ref, key: ['value', 'category'] }
      : { kind, items: ref, item: 'candidate', when: { kind: 'compare', operator: 'ne', left: select('candidate', ['value', 'flag']), right: literal(true) } }
    const result = await f.run(expression)
    expect(result.state).toBe('known')
    expect(reads).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)
    if (result.state !== 'known') throw new Error('expected a committed transform')
    const projected = workflowField(result.value, kind === 'group' || kind === 'unique' ? ['0', 'members'] : ['matched'], result.derivedFrom, result)
    expect(projected).toMatchObject({ state: 'known', collection: { count: kind === 'group' || kind === 'unique' ? 3 : 2, sealed: true } })
    const saved = await f.control.saveCollectionValue(result)
    const coldStore = new FileWorkflowStore(f.root), cold = new WorkflowControl(coldStore, f.preview)
    const retained = await coldStore.loadValue(f.preview.workflowId, saved)
    expect(retained).toEqual(result)
    if (projected.state !== 'known') throw new Error('expected collection authority')
    const members = await cold.entries(projected)
    const member = await cold.entryValue(members[0])
    expect(workflowField(member.value, kind === 'group' || kind === 'unique' ? ['value', 'flag'] : ['value', 'value', 'value', 'flag']))
      .toMatchObject({ state: 'known', value: 0 })
    if (kind === 'filter' || kind === 'partition') expect(result.collectionFields?.map(field => field.collection.count)).toEqual([2, 1, 0])
  })

  it('preserves unknown predicate rows and reasons without inventing an unknown native effect', async () => {
    const f = await fixture([0, false])
    const value = await f.run({ kind: 'filter', items: ref, item: 'candidate', when: select('candidate', ['missing']) })
    expect(value).toMatchObject({ state: 'known', collectionFields: [{ collection: { count: 0 } }, { collection: { count: 0 } }, { collection: { count: 2, sealed: true } }] })
    if (value.state !== 'known') throw new Error('missing partition')
    const unknown = workflowField(value.value, ['unknown'], value.derivedFrom, value)
    if (unknown.state !== 'known') throw new Error('missing authority')
    for (const entry of await f.control.entries(unknown)) {
      expect(entry).toMatchObject({ state: 'completed', settled: true })
      const member = await f.control.entryValue(entry)
      expect(workflowField(member.value, ['value', 'reason'])).toMatchObject({ state: 'known', value: expect.stringContaining('missing') })
    }
  })

  it('keeps failed source states and errors in grouped and filtered manifests', async () => {
    const f = await fixture([])
    const failed = await f.control.collection({ frameId: 'failed' }, [{ key: 'failed', index: 0, state: 'failed', settled: true, error: 'original failure' }], true)
    f.control.bind(f.control.root, 'failed', failed)
    for (const expression of [{ kind: 'group', items: { kind: 'ref', name: 'failed' }, key: ['state'] },
      { kind: 'partition', items: { kind: 'ref', name: 'failed' }, item: 'candidate', when: literal(true) }] satisfies WorkflowExpression[]) {
      const value = await f.run(expression)
      if (value.state !== 'known') throw new Error('missing failed group')
      const group = workflowField(value.value, expression.kind === 'group' ? ['0', 'members'] : ['matched'], value.derivedFrom, value)
      if (group.state !== 'known') throw new Error('missing authority')
      expect(await f.control.entries(group)).toMatchObject([{ state: 'failed', error: 'original failure', settled: true }])
    }
  })

  it.each(['group', 'partition'] as const)('does not consume an unsealed source or publish a partial %s after stop', async kind => {
    const f = await fixture([0, false, true])
    const expression: WorkflowExpression = kind === 'group' ? { kind, items: ref, key: ['state'] } : { kind, items: ref, item: 'candidate', when: literal(true) }
    const unsealed = await f.control.collection({ frameId: 'pending' }, [{ key: 'unknown', index: 0, state: 'unknown', settled: false }], false)
    const scope = { path: f.control.root.path, bindings: new Map([['input', unsealed]]) }
    const loads = vi.spyOn(f.store, 'loadValue')
    expect(await f.control.evaluate(expression, scope, 'unsealed', () => false)).toMatchObject({ state: 'unknown' })
    expect(loads).not.toHaveBeenCalled()
    let stopped = false
    const read = f.control.entryValue.bind(f.control)
    vi.spyOn(f.control, 'entryValue').mockImplementation(async entry => { const value = await read(entry); stopped = true; return value })
    const publications = vi.spyOn(f.control, 'collection')
    expect(await f.run(expression, () => stopped)).toMatchObject({ state: 'unknown' })
    expect(publications).not.toHaveBeenCalled()
    expect(await f.control.entries(f.source)).toHaveLength(3)
  })

  it('preserves nested authority through a derived partition row on cold read', async () => {
    const f = await fixture([false])
    const parent: WorkflowEvaluation = { state: 'known', value: { children: f.source.value }, collectionFields: [{ path: ['children'], collection: f.source.collection }], derivedFrom: [] }
    const valueRef = await f.control.saveCollectionValue(parent)
    const outer = await f.control.collection({ frameId: 'outer' }, [{ key: 'parent', index: 0, state: 'completed', settled: true, valueRef }], true)
    f.control.bind(f.control.root, 'outer', outer)
    const result = await f.run({ kind: 'partition', items: { kind: 'ref', name: 'outer' }, item: 'parent', when: { kind: 'compare', operator: 'gt',
      left: { kind: 'count', value: select('parent', ['value', 'children']) }, right: literal(0) } })
    if (result.state !== 'known') throw new Error('missing partition')
    const matched = workflowField(result.value, ['matched'], result.derivedFrom, result)
    if (matched.state !== 'known') throw new Error('missing authority')
    const cold = new WorkflowControl(new FileWorkflowStore(f.root), f.preview)
    const entry = (await cold.entries(matched))[0], value = await cold.entryValue(entry)
    expect(workflowField(value.value, ['value', 'value', 'value', 'children'], value.derivedFrom, value)).toMatchObject({ state: 'known', collection: { count: 1 } })
  })

  it('bounds retained group keys before publishing any member manifest', async () => {
    const f = await fixture([{ key: 'a'.repeat(2_200_000) }, { key: 'b'.repeat(2_200_000) }])
    const writes = vi.spyOn(f.control, 'collection')
    await expect(f.run({ kind: 'group', items: ref, key: ['value', 'key'] })).rejects.toThrow(workflowExpressionCopy.valueLimit)
    expect(writes).not.toHaveBeenCalled()
  })

  it.each(['array', 'collection'] as const)('uses the same evaluator for nested host requests inside an %s predicate', async source => {
    const f = await fixture([0, false])
    const predicate: WorkflowExpression = { kind: 'compare', operator: 'eq', left: { kind: 'count', value: { kind: 'group', items: ref, key: ['state'] } }, right: literal(1) }
    const result = await f.run({ kind: 'partition', items: source === 'array' ? literal([0, false]) : ref, item: 'candidate', when: predicate })
    if (result.state !== 'known') throw new Error('missing nested evaluation')
    const matched = workflowField(result.value, ['matched'], result.derivedFrom, result)
    if (source === 'array') expect(matched).toMatchObject({ state: 'known', value: [{ index: 0, value: 0 }, { index: 1, value: false }] })
    else expect(matched).toMatchObject({ state: 'known', collection: { count: 2 } })
  })

  it('rejects dual/foreign value references and missing derived data instead of returning an empty member', async () => {
    const f = await fixture([0]), valueRef = f.entries[0].valueRef!
    expect(() => collectionEntries({ schemaVersion: 1, sealed: true, entries: [{ ...f.entries[0], valueRef: { ...valueRef, workflowId: 'foreign' } }] }, f.preview.workflowId, 1, true)).toThrow()
    expect(() => collectionEntries({ schemaVersion: 1, sealed: true, entries: [{ ...f.entries[0], reference: { frameId: 'frame', revision: 1, resultRef: valueRef } }] }, f.preview.workflowId, 1, true)).toThrow()
    const directory = join(f.root, 'workflows')
    const names = (await readdir(directory)).filter(name => name.endsWith('.value.json'))
    expect(names).toHaveLength(1)
    await unlink(join(directory, names[0]))
    await expect(new WorkflowControl(new FileWorkflowStore(f.root), f.preview).entryValue(f.entries[0])).rejects.toThrow()
  })
})
