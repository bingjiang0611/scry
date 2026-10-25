import { rename, readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'
import { FileWorkflowStore } from '../../src/main/workflow-store'
import { fixture, revision } from '../../src/main/workflow-revision.fixture'
import type { WorkflowBlock } from '../../src/shared/workflow'

const meter = vi.hoisted(() => ({ directory: '', root: '', active: false, governing: 0, manifests: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof rename>) => {
    const result = await actual.rename(...args)
    const target = String(args[1])
    if (meter.active && target.startsWith(meter.directory + sep)) {
      if (target.endsWith('.governing.json')) meter.governing++
      if (target === meter.root) meter.manifests++
    }
    return result
  } }
})

const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'bind', blockId: 'fact', value: { kind: 'literal', value: 'known' } },
  { kind: 'return', blockId: 'finish', ref: { nodeId: 'fact' } }
] }

// This diagnostic measures publication of an already completed two-revision root.
// Setup is intentionally outside this component counter, not outside the unchanged
// native OS-process acceptance test. It is not a new performance gate or speedup.
async function workload(extraPublication = false) {
  const f = await fixture(true, false, true, body)
  try {
    expect((await f.start()).state).toBe('completed')
    const next = revision(f.preview, root => {
      if (root.kind !== 'sequence') throw new Error('Fixture shape')
      root.blocks.at(-1)!.blockId = 'finish-next'
    })
    expect((await f.revise(next)).state).toBe('completed')
    expect(f.execute).not.toHaveBeenCalled()
    const before = await f.record()
    expect(before.revisions).toHaveLength(2)
    expect(before.execution!.segments).toHaveLength(2)
    expect(before.intents).toHaveLength(0)
    const cold = new FileWorkflowStore(f.userData)
    meter.directory = join(f.userData, 'workflows')
    meter.root = join(meter.directory, f.preview.workflowId + '.json')
    meter.governing = 0
    meter.manifests = 0
    meter.active = true
    const loaded = (await cold.load(f.preview.workflowId))!
    await cold.save(loaded)
    if (extraPublication) await cold.save(loaded)
    meter.active = false
    expect(meter.manifests).toBe(extraPublication ? 2 : 1)
    const manifest = JSON.parse(await readFile(meter.root, 'utf8')) as { revisions: Array<{ reference: string }> }
    expect(manifest.revisions).toHaveLength(2)
    const after = await new FileWorkflowStore(f.userData).load(f.preview.workflowId)
    expect(after).toEqual(before)
    return { governing: meter.governing, manifests: meter.manifests }
  } finally {
    meter.active = false
    await f.cleanup()
  }
}

describe('cold governing publication fixed workload', () => {
  it('counts actual atomic publications while retaining both governing revisions', async () => {
    const counters = await repeatCounters(defaultRepeats, async () => {
      const result = await workload()
      return { governing: result.governing, manifests: result.manifests }
    })
    const meta = { scenario: 'workflow.cold-governing-publication', layer: 'io', unit: 'count',
      workload: 'roots=1;revisions=2;agent-attempts=0;store=file;controllers=2;cold-loads=1;root-saves=1',
      source: 'pass-through completed fs.rename publications during production cold FileWorkflowStore load/save; canonical Service creates the unchanged completed root before observation' }
    writeCollector('workflow-cold-governing', [
      measured({ ...meta, metric: 'io.governing.publications' }, counters.governing),
      measured({ ...meta, metric: 'io.root-manifest.publications' }, counters.manifests)
    ])
  })

  it('detects one deliberately added real root publication', async () => {
    const ordinary = await workload(), redundant = await workload(true)
    expect(redundant.manifests).toBe(ordinary.manifests + 1)
    expect(redundant.governing).toBe(ordinary.governing)
  })
})
