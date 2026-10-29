import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { fixture } from './workflow-system.fixture'
import { WorkflowSourceApplicationService } from './workflow-source-application-service'

const role = { role: 'orchestrator' as const, providerId: 'claude' as const }

describe('workflow source application production service', () => {
  it('derives the candidate from canonical evidence, mutates source once, and returns the durable receipt cold', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'check.cjs'), "console.log('checked')")
    f.execute.mockImplementation(request => ({ stop: () => true, result: (async () => {
      await writeFile(join(request.workspace, 'feature.txt'), 'candidate bytes')
      return { runId: 'source-candidate', status: 'completed', output: 'done', settled: true }
    })() }))
    const body = { kind: 'sequence' as const, blockId: 'root', blocks: [
      { kind: 'replica' as const, blockId: 'copy' },
      { kind: 'call' as const, blockId: 'work', role: 'orchestrator' as const, prompt: 'edit candidate', replica: { kind: 'ref' as const, name: 'copy' } },
      { kind: 'replica' as const, blockId: 'candidate', source: { kind: 'ref' as const, name: 'copy' } },
      { kind: 'check' as const, blockId: 'verify', replica: { kind: 'ref' as const, name: 'candidate' }, check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 2000, parser: 'exit_code' as const } },
      { kind: 'return' as const, blockId: 'report', ref: { nodeId: 'verify', path: ['passed'] } }
    ] }
    const runtime = f.create(f.store, body)
    const preview = await runtime.service.planCommand({ command: '/scry-workflow run source apply', workspace: f.source, orchestrator: role, roles: [] })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await runtime.service.approve(approval)
    await expect(runtime.service.start(preview.workflowId, approval)).resolves.toMatchObject({ state: 'completed' })

    const userData = join(f.root, 'user-data')
    const createApplications = () => new WorkflowSourceApplicationService({ userData, store: f.store, systems: runtime.host, resolveWorkspace: workspace => workspace })
    const catalog = await createApplications().catalog(preview.workflowId, preview.programRevision)
    expect(catalog.items).toHaveLength(1)
    expect(catalog.items[0]).toMatchObject({ nodeId: 'verify', changedPaths: ['feature.txt'], check: 'recorded_passed' })
    const review = catalog.items[0]!
    const command = { operationId: '00000000-0000-4000-8000-000000000001', target: { workflowId: review.workflowId, programRevision: review.programRevision, workflowRevision: review.workflowRevision, stepId: review.stepId, nodeId: review.nodeId },
      expected: { baseHash: review.baseHash, candidateHash: review.candidateHash, trustFingerprint: review.trustFingerprint },
      confirmation: { acknowledgesSourceMutation: true as const, acknowledgesNoAutomaticRollback: true as const } }
    const candidate = (await runtime.host.replicas.resolve((await f.store.load(preview.workflowId))!.systemOutcomes!.find(outcome => outcome.check)?.check!.inputs!.materialization!.candidate!)).directory
    await writeFile(join(candidate, 'tamper.txt'), 'not checked')
    await expect(createApplications().apply(command)).rejects.toThrow('持久化检查输入')
    await unlink(join(candidate, 'tamper.txt'))
    const receipt = await createApplications().apply(command)
    expect(receipt).toMatchObject({ state: 'applied', changedPaths: ['feature.txt'] })
    expect(await readFile(join(f.source, 'feature.txt'), 'utf8')).toBe('candidate bytes')
    await expect(createApplications().catalog(preview.workflowId, preview.programRevision)).resolves.toMatchObject({ items: [], receipts: [{ operationId: command.operationId, state: 'applied' }] })

    await rm(candidate, { recursive: true, force: true })
    await expect(createApplications().catalog(preview.workflowId, preview.programRevision)).resolves.toMatchObject({ items: [], receipts: [{ operationId: command.operationId, state: 'applied' }] })
    await expect(createApplications().apply(command)).resolves.toEqual(receipt)
    await expect(createApplications().apply({ ...command, expected: { ...command.expected, baseHash: 'f'.repeat(64) } })).rejects.toThrow('其他请求')
  })
})
