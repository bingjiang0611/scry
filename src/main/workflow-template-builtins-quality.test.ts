import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowTemplateStore } from './workflow-template-store'
import { adversarialReviewTemplateId, builtinTemplateIds, multiAngleTemplateId } from './workflow-template-builtins'
import { workflowChildBlocks } from '../shared/workflow'
// The grammar admits exactly these roles; a template cannot invent a new one.
const WORKFLOW_ROLES = ['orchestrator', 'worker', 'reviewer', 'summarizer']

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function store() {
  const user = await realpath(await mkdtemp(join(tmpdir(), 'scry-quality-template-')))
  roots.push(user)
  return new WorkflowTemplateStore(user, () => { throw new Error('builtin data must not authorize a project directory') })
}
type Block = { kind: string; blockId: string; role?: string; blocks?: Block[]; inputRefs?: Array<{ nodeId: string }>; ref?: { nodeId: string }; outputSchema?: unknown }
const walk = (block: Block): Block[] => [block, ...workflowChildBlocks(block as never).flatMap(child => walk(child as Block))]

describe('quality builtin templates', () => {
  it('publishes adversarial review and multi-angle programs as valid frozen data', async () => {
    const templates = await store()
    for (const [id, name] of [[adversarialReviewTemplateId, 'adversarial'], [multiAngleTemplateId, 'multi-angle']] as const) {
      expect(builtinTemplateIds).toContain(id)
      const record = await templates.read({ kind: 'builtin' }, id)
      expect(record?.state, name).toBe('valid')
      expect(record?.source).toContain(id)
    }
  })

  it('keeps every call on a declared role and every input on an earlier block', async () => {
    const templates = await store()
    for (const id of [adversarialReviewTemplateId, multiAngleTemplateId]) {
      const definition = JSON.parse((await templates.read({ kind: 'builtin' }, id))!.source) as
        { roles: Array<{ role: string }>; parameters: Record<string, unknown>; body: Block }
      const parameters = Object.keys(definition.parameters)
      const declared = definition.roles.map(entry => entry.role)
      expect(new Set(declared).size, id).toBe(declared.length)
      const order: string[] = []
      const visit = (block: Block) => {
        order.push(block.blockId)
        if (block.role) expect(WORKFLOW_ROLES).toContain(block.role)
        // Inputs are either earlier committed blocks or declared parameters.
        for (const ref of block.inputRefs ?? []) expect([...order, ...parameters]).toContain(ref.nodeId)
        if (block.role) expect(declared).toContain(block.role)
        for (const child of block.blocks ?? []) visit(child)
      }
      visit(definition.body)
      // Every declared role participates: an unused role would be a silent no-op.
      const used = new Set(walk(definition.body).map(block => block.role).filter(Boolean))
      for (const role of declared) expect(used, id).toContain(role)
    }
  })

  it('separates generation, review and arbitration so one opinion cannot pass itself', async () => {
    const templates = await store()
    const definition = JSON.parse((await templates.read({ kind: 'builtin' }, adversarialReviewTemplateId))!.source) as { body: Block }
    const blocks = walk(definition.body)
    const reviews = blocks.find(block => block.blockId === 'reviews')
    expect(reviews?.kind).toBe('parallel')
    expect(reviews?.blocks?.map(block => block.blockId)).toEqual(['counterexamples', 'evidence'])
    // Both reviews see the same candidate; the adjudicator sees both reviews.
    for (const review of reviews!.blocks!) expect(review.inputRefs?.map(ref => ref.nodeId)).toContain('candidate')
    const adjudicate = blocks.find(block => block.blockId === 'adjudicate')!
    expect(adjudicate.role).toBe('summarizer')
    expect(adjudicate.inputRefs?.map(ref => ref.nodeId)).toEqual(['goal', 'candidate', 'counterexamples', 'evidence'])
    expect(adjudicate.outputSchema).toEqual({ type: 'object', properties: { refutation: { type: 'string' }, feedback: { type: 'string' } }, required: ['refutation', 'feedback'] })
    expect(blocks.find(block => block.blockId === 'finish')?.ref).toEqual({ nodeId: 'adjudicate' })
  })

  it('keeps the three drafts private and returns only the improved single plan', async () => {
    const templates = await store()
    const definition = JSON.parse((await templates.read({ kind: 'builtin' }, multiAngleTemplateId))!.source) as { body: Block }
    const blocks = walk(definition.body)
    const drafts = blocks.find(block => block.blockId === 'drafts')
    expect(drafts?.blocks?.map(block => block.blockId)).toEqual(['minimalDraft', 'resilienceDraft', 'behaviourDraft'])
    const arbitrate = blocks.find(block => block.blockId === 'arbitrate')!
    for (const draft of drafts!.blocks!) expect(arbitrate.inputRefs?.map(ref => ref.nodeId)).toContain(draft.blockId)
    expect(blocks.find(block => block.blockId === 'finish')?.ref).toEqual({ nodeId: 'constraintGate' })
    expect(blocks.find(block => block.blockId === 'constraintGate')?.kind).toBe('branch')
  })
})
