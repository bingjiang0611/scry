import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowReplicas } from './workflow-replica'
import { validateWorkflowBody } from './workflow-program'
import { WORKFLOW_MAX_BATCH } from '../shared/workflow'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-combine-'))), source = join(root, 'source'), registry = join(root, 'registry')
  roots.push(root); await mkdir(source); await writeFile(join(source, 'base.txt'), 'base'); await writeFile(join(source, 'same.txt'), 'old')
  const replicas = new WorkflowReplicas(registry, async () => {})
  const base = await replicas.prepare('workflow', 'base', source)
  return { root, source, replicas, base }
}
async function candidate(f: Awaited<ReturnType<typeof fixture>>, id: string) { return f.replicas.prepare('workflow', id, f.base) }

describe('deterministic main-owned replica combination', () => {
  it('combines non-overlapping and identical same-path edits without touching source', async () => {
    const f = await fixture(), left = await candidate(f, 'left'), right = await candidate(f, 'right')
    const l = await f.replicas.resolve(left), r = await f.replicas.resolve(right)
    await writeFile(join(l.directory, 'left.txt'), 'left'); await writeFile(join(r.directory, 'right.txt'), 'right')
    await writeFile(join(l.directory, 'same.txt'), 'new'); await writeFile(join(r.directory, 'same.txt'), 'new')
    const result = await f.replicas.combine('workflow', f.base, [right, left], 'integration')
    expect(result.summary).toMatchObject({ state: 'combined', candidateCount: 2, changedPathCount: 3 })
    const integration = await f.replicas.resolve(result.replica!)
    expect(await readFile(join(integration.directory, 'left.txt'), 'utf8')).toBe('left')
    expect(await readFile(join(integration.directory, 'right.txt'), 'utf8')).toBe('right')
    expect(await readFile(join(integration.directory, 'same.txt'), 'utf8')).toBe('new')
    expect(await readFile(join(f.source, 'same.txt'), 'utf8')).toBe('old')
  })
  it('returns durable path/candidate conflict evidence for same-path and delete/change edits', async () => {
    const f = await fixture(), left = await candidate(f, 'left'), right = await candidate(f, 'right')
    const l = await f.replicas.resolve(left), r = await f.replicas.resolve(right)
    await writeFile(join(l.directory, 'same.txt'), 'left'); await writeFile(join(r.directory, 'same.txt'), 'right')
    await rm(join(l.directory, 'base.txt')); await writeFile(join(r.directory, 'base.txt'), 'changed')
    const result = await f.replicas.combine('workflow', f.base, [left, right], 'integration')
    expect(result.replica).toBeUndefined()
    expect(result.summary).toMatchObject({ state: 'conflict', integration: null, conflicts: [
      { path: 'base.txt', candidateReplicaIds: ['left', 'right'] },
      { path: 'same.txt', candidateReplicaIds: ['left', 'right'] }
    ] })
    await expect(f.replicas.resolve({ workflowId: 'workflow', replicaId: 'integration', inputHash: '0'.repeat(64) })).rejects.toThrow()
  })
  it('rejects forged/wrong ancestry and bounded candidate collections', async () => {
    const f = await fixture(), other = await mkdtemp(join(f.root, 'other-')); await writeFile(join(other, 'other.txt'), 'other')
    const wrongBase = await f.replicas.prepare('workflow', 'other-base', other), forged = await f.replicas.prepare('workflow', 'forged', wrongBase)
    await expect(f.replicas.combine('workflow', f.base, [forged], 'integration')).rejects.toThrow()
    const tooMany = Array.from({ length: WORKFLOW_MAX_BATCH + 1 }, (_, index) => ({ workflowId: 'workflow', replicaId: 'x' + index, inputHash: 'a'.repeat(64) }))
    await expect(f.replicas.combine('workflow', f.base, tooMany, 'bounded')).rejects.toThrow()
  })
  it('accepts filtered/projected/collected replica references as combine candidates', () => {
    const body = { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'map', blockId: 'mapped', items: { kind: 'literal', value: [{ id: 'candidate' }] }, item: 'input', key: ['id'], maxItems: 1,
        body: { kind: 'replica', blockId: 'candidateReplica' } },
      { kind: 'bind', blockId: 'filtered', value: { kind: 'filter', items: { kind: 'ref', name: 'mapped' }, item: 'row', when: { kind: 'literal', value: true } } },
      { kind: 'bind', blockId: 'projected', value: { kind: 'project', items: { kind: 'field', source: { kind: 'ref', name: 'filtered' }, path: ['matched'] }, item: 'row', value: { kind: 'field', source: { kind: 'ref', name: 'row' }, path: ['value', 'value', 'value'] } } },
      { kind: 'collect', blockId: 'collected', items: { kind: 'ref', name: 'projected' } },
      { kind: 'replica', blockId: 'base' },
      { kind: 'combine', blockId: 'combined', base: { kind: 'ref', name: 'base' }, candidates: { kind: 'ref', name: 'collected' } },
      { kind: 'return', blockId: 'result', ref: { nodeId: 'combined' } }
    ] }
    expect(() => validateWorkflowBody(body, new Set())).not.toThrow()
  })

  it('accepts the typed combine program shape at the replica abstraction level', () => {
    const body = { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'replica', blockId: 'base' },
      { kind: 'combine', blockId: 'combined', base: { kind: 'ref', name: 'base' }, candidates: { kind: 'literal', value: [{ workflowId: 'workflow', replicaId: 'candidate', inputHash: 'a'.repeat(64) }] } },
      { kind: 'return', blockId: 'result', ref: { nodeId: 'combined' } }
    ] }
    expect(() => validateWorkflowBody(body, new Set())).not.toThrow()
  })
})
