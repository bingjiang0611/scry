import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkflowBlock } from '../shared/workflow'
import { FileWorkflowStore } from './workflow-store'
import { workflowOpaqueProvenance } from './workflow-opaque-provenance'
import { fixture } from './workflow-system.fixture'

function body(files: string[]): Extract<WorkflowBlock, { kind: 'sequence' }> {
  return { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'copy' },
    { kind: 'check', blockId: 'tests', replica: { kind: 'ref', name: 'copy' }, check: { parser: 'node_test', argv: [process.execPath, '--test', '--test-reporter=tap', ...files], cwd: '.', timeoutMs: 2000 } },
    { kind: 'verification', blockId: 'verify', required: { native: { check: 'tests', result: { kind: 'ref', name: 'tests' } } } },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'verify' } }
  ] }
}

async function setup(sources: string[]) {
  const f = await fixture(), store = new FileWorkflowStore(join(f.root, 'state'))
  const files = sources.map((_, index) => `suite-${index}.test.cjs`)
  await Promise.all(sources.map((source, index) => writeFile(join(f.source, files[index]), source)))
  const instance = f.create(store, body(files))
  const preview = await instance.service.planCommand({ command: '/scry-workflow run native test evidence', workspace: f.source, orchestrator: f.preview.program.roles[0], roles: [] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await instance.service.approve(approval)
  return { ...f, ...instance, store, preview, approval }
}

describe('canonical main Node test evidence', () => {
  it('executes every frozen file only in the owned copy, preserves cold facts, and rejects hash-valid rewritten counts', async () => {
    const f = await setup([
      "require('node:test').test('first', () => { require('node:fs').writeFileSync('body-entered', JSON.stringify({ file: __filename, cwd: process.cwd() })); console.log('# tests 999\\n# pass 999') })",
      "require('node:test').test('second', () => require('node:fs').writeFileSync('second-body-entered', JSON.stringify({ file: __filename, cwd: process.cwd() })))"
    ])
    expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'completed', dispatchAttempts: 0 })
    const record = (await new FileWorkflowStore(join(f.root, 'state')).load(f.preview.workflowId))!
    expect(record.intents).toHaveLength(0)
    expect(record.systemIntents).toHaveLength(3)
    expect(f.execute).not.toHaveBeenCalled()
    const index = record.systemIntents!.findIndex(intent => intent.kind === 'check')
    const outcome = record.systemOutcomes!.find(outcome => outcome.stepId === record.systemIntents![index].stepId)!
    expect(outcome.check).toMatchObject({ state: 'passed', tests: { state: 'available', counts: { total: 2, passed: 2, skipped: 0 }, discovery: { state: 'unavailable' }, execution: { state: 'unavailable' }, coverage: { state: 'unavailable' } } })
    const canonical = await f.store.loadValue(f.preview.workflowId, outcome.resultRef!)
    if (canonical.state !== 'known' || !canonical.value || Array.isArray(canonical.value) || typeof canonical.value !== 'object') throw new Error('fixture needs a canonical object')
    expect(canonical.value.tests).toEqual(outcome.check!.tests)
    const nodes = f.preview.program.body
    if (nodes.kind !== 'sequence' || nodes.blocks[1].kind !== 'check') throw new Error('fixture needs the frozen test node')
    expect(nodes.blocks[1].authorization!.testFiles).toHaveLength(2)
    const receipt = await f.host.replicas.resolve(outcome.replica!)
    for (const file of nodes.blocks[1].authorization!.testFiles!) expect(file.path.startsWith(f.source + '/')).toBe(true)
    for (const [index, marker] of ['body-entered', 'second-body-entered'].entries()) {
      expect(JSON.parse(await readFile(join(receipt.directory, marker), 'utf8'))).toEqual({ file: join(receipt.directory, `suite-${index}.test.cjs`), cwd: receipt.directory })
      await expect(readFile(join(f.source, marker))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, canonical, { record, verification: f.host.verification })).resolves.toHaveLength(1)
    const verification = record.systemOutcomes!.find(row => record.systemIntents!.find(intent => intent.stepId === row.stepId)?.kind === 'verification')!
    expect(await f.store.loadValue(f.preview.workflowId, verification.resultRef!)).toMatchObject({ state: 'known', value: { state: 'available', passed: true, comparison: { progress: { state: 'unavailable' } } } })

    const forgedTests = structuredClone(outcome.check!.tests!)
    if (forgedTests.state !== 'available') throw new Error('fixture needs reported counts')
    forgedTests.counts.total++
    forgedTests.counts.passed++
    const forged = { ...canonical, value: { ...canonical.value, tests: forgedTests } }
    const forgedReference = await f.store.saveValue(f.preview.workflowId, outcome.stepId, forged)
    const corrupt = structuredClone(record)
    const corruptOutcome = corrupt.systemOutcomes!.find(row => row.stepId === outcome.stepId)!
    corruptOutcome.resultRef = forgedReference
    // First bind the value to the existing receipt. Then rewrite both fields:
    // agreement alone must not replace the authoritative stdout report.
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, forged, { record: corrupt })).rejects.toThrow()
    corruptOutcome.check!.tests = forgedTests
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, forged, { record: corrupt })).rejects.toThrow()
    const verificationNode = nodes.blocks[2]
    if (verificationNode.kind !== 'verification') throw new Error('fixture needs verification')
    await expect(f.host.verification.execute(corrupt, verificationNode, verification.stepId)).rejects.toThrow()
    expect((await f.store.load(f.preview.workflowId))!.systemOutcomes).toEqual(record.systemOutcomes)
  })

  it('keeps skipped checks incomplete and refuses a rewritten pass in both native consumers', async () => {
    const f = await setup(["require('node:test').test('skipped', { skip: true }, () => {})"])
    expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'completed', dispatchAttempts: 0 })
    const record = (await f.store.load(f.preview.workflowId))!
    const outcome = record.systemOutcomes!.find(row => row.check)!
    expect(outcome.check).toMatchObject({ state: 'incomplete', tests: { state: 'available', counts: { total: 1, skipped: 1, passed: 0 } } })
    const canonical = await f.store.loadValue(f.preview.workflowId, outcome.resultRef!)
    if (canonical.state !== 'known' || !canonical.value || Array.isArray(canonical.value) || typeof canonical.value !== 'object') throw new Error('fixture needs a canonical object')
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, canonical, { record })).resolves.toHaveLength(1)
    const verification = record.systemOutcomes!.find(row => record.systemIntents!.find(intent => intent.stepId === row.stepId)?.kind === 'verification')!
    expect(await f.store.loadValue(f.preview.workflowId, verification.resultRef!)).toMatchObject({ state: 'known', value: { state: 'unavailable' } })
    const forged = { ...canonical, value: { ...canonical.value, state: 'passed', passed: true } }
    const corrupt = structuredClone(record), corruptOutcome = corrupt.systemOutcomes!.find(row => row.stepId === outcome.stepId)!
    corruptOutcome.resultRef = await f.store.saveValue(f.preview.workflowId, outcome.stepId, forged)
    corruptOutcome.check!.state = 'passed'
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, forged, { record: corrupt })).rejects.toThrow()
    const nodes = f.preview.program.body
    if (nodes.kind !== 'sequence' || nodes.blocks[2].kind !== 'verification') throw new Error('fixture needs verification')
    await expect(f.host.verification.execute(corrupt, nodes.blocks[2], verification.stepId)).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled()
  })
})
