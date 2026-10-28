import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowCheckFixTemplate } from '../shared/workflow-check-fix'
import type { WorkflowCheckRequest } from '../shared/workflow-check'
import { WorkflowTemplateStore } from './workflow-template-store'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { WorkflowSlots } from './workflow-runner'
import { FileWorkflowStore } from './workflow-store'
import { WorkflowSystemHost } from './workflow-system-host'

const roots: string[] = [], services: WorkflowService[] = [], pending = new Set<Promise<unknown>>()
afterEach(async () => {
  await Promise.all(services.map(service => service.prepareForShutdown()))
  await Promise.allSettled([...pending])
  services.splice(0).forEach(service => service.close())
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(initialPass: boolean, repairWrites: boolean, script?: string, timeoutMs = 2000) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-check-fix-'))); roots.push(root)
  const project = join(root, 'project'), userData = join(root, 'user')
  await Promise.all([mkdir(project), mkdir(userData)])
  await writeFile(join(project, 'check.cjs'), script ?? "const fs = require('node:fs'); console.log('real local check'); process.exitCode = fs.existsSync('fixed.marker') ? 0 : 1\n")
  if (initialPass) await writeFile(join(project, 'fixed.marker'), 'already valid')
  const check: WorkflowCheckRequest = { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs, parser: 'exit_code' }
  const templates = new WorkflowTemplateStore(userData, cwd => { if (cwd !== project) throw new Error('unexpected workspace'); return cwd }, join(root, 'locks'))
  const draft = await templates.saveDraft({ scope: { kind: 'project', workspace: project }, source: JSON.stringify(workflowCheckFixTemplate(check)) })
  expect(draft.validation).toEqual({ state: 'valid' })
  const publication = await templates.publish({ draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId: randomUUID() })
  if (publication.state !== 'published') throw new Error('fixture publication failed')
  const store = new FileWorkflowStore(userData), slots = new WorkflowSlots(1)
  const host = new WorkflowSystemHost(join(root, 'copies'), store, () => ({ HOME: root, PATH: '/usr/bin:/bin' }))
  const execute = vi.fn<WorkflowServiceOptions['execute']>(request => ({ stop: () => true, result: (async () => {
    expect(request.workspace).not.toBe(project)
    expect(request.replicaRun).toBeDefined()
    await host.assertRun(request.replicaRun!, request.workspace)
    expect(request.prompt).toContain('failed')
    if (repairWrites) await writeFile(join(request.workspace, 'fixed.marker'), 'repaired only in copy')
    // Deliberately untrustworthy: this must not override the actual check result.
    return { runId: 'offline-repair', status: 'completed', output: 'all checks passed', settled: true }
  })() }))
  const plan = vi.fn(async () => { throw new Error('template must not plan') })
  const service = new WorkflowService({ store, templates, systems: host, slots, execute, plan, providerRegistered: () => true,
    runControls: async () => ({ descriptor: { id: 'codex', label: 'offline fixture', runtimeProvider: 'codex_cli', transport: 'fixture', available: true,
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } },
      identity: 'offline-fixture', model: true, stop: true, independentRun: true, terminalOutput: true }) })
  services.push(service)
  const preview = await service.instantiateTemplate({ source: { kind: 'saved', ref: publication.ref }, commandId: randomUUID(), cwd: project,
    userGoal: 'check then repair once', parameters: {}, orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [{ role: 'worker', providerId: 'codex' }] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  const run = async () => {
    await service.approve(approval)
    const task = service.start(preview.workflowId, approval)
    pending.add(task)
    try { return await task } finally { pending.delete(task) }
  }
  return { project, service, store, slots, host, execute, plan, preview, run }
}

describe('project check/fix uses the canonical interpreter and real local checks', () => {
  it('returns a native timeout without buying a repair call', async () => {
    const f = await fixture(false, true, 'setInterval(() => {}, 1000)\n', 100), progress = await f.run()
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 0 })
    expect(JSON.parse(progress.finalReport!)).toMatchObject({ state: 'timed_out', passed: false })
    expect(f.execute).not.toHaveBeenCalled()
    const record = (await f.store.load(f.preview.workflowId))!
    expect(record.systemOutcomes?.flatMap(outcome => outcome.check ? [outcome.check.state] : [])).toEqual(['timed_out'])
    expect(f.slots.active).toBe(0)
  })

  it('does not route an unknown host check into repair or replay it', async () => {
    const f = await fixture(false, true), executeSystem = f.host.execute.bind(f.host)
    const checks = vi.fn()
    vi.spyOn(f.host, 'execute').mockImplementation((...args) => {
      if (args[1].kind !== 'check') return executeSystem(...args)
      checks()
      return { result: Promise.resolve({ state: 'unknown', settled: true,
        value: { state: 'unknown', reason: 'injected lost check result', derivedFrom: [] } }), settled: Promise.resolve(), stop: () => true }
    })
    const progress = await f.run()
    expect(progress.state).not.toBe('completed')
    expect(progress.dispatchAttempts).toBe(0)
    expect(checks).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
    const observed = await f.service.snapshot(f.preview.workflowId)
    expect(observed?.dispatchAttempts).toBe(0)
    expect(checks).toHaveBeenCalledTimes(1)
  })

  it('returns a first-round pass without invoking the repair Provider', async () => {
    const f = await fixture(true, true), progress = await f.run()
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 0 })
    expect(JSON.parse(progress.finalReport!)).toMatchObject({ state: 'passed', passed: true, exitCode: 0 })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.plan).not.toHaveBeenCalled()
    const record = (await f.store.load(f.preview.workflowId))!
    expect(record.systemOutcomes?.flatMap(outcome => outcome.check ? [outcome.check.state] : [])).toEqual(['passed'])
    expect(f.slots.active).toBe(0)
  })

  it('preserves the first failure and rechecks the repaired owned copy exactly once', async () => {
    const f = await fixture(false, true), progress = await f.run()
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 1 })
    expect(JSON.parse(progress.finalReport!)).toMatchObject({ state: 'passed', passed: true, exitCode: 0 })
    expect(f.execute).toHaveBeenCalledTimes(1)
    const record = (await f.store.load(f.preview.workflowId))!
    expect(record.systemOutcomes?.flatMap(outcome => outcome.check ? [outcome.check.state] : [])).toEqual(['failed', 'passed'])
    const replica = record.systemOutcomes!.find(outcome => outcome.replica)!.replica!
    const receipt = await f.host.replicas.resolve(replica)
    expect(await readFile(join(receipt.directory, 'fixed.marker'), 'utf8')).toBe('repaired only in copy')
    await expect(readFile(join(f.project, 'fixed.marker'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.slots.active).toBe(0)
  })

  it('does not trust a repair success claim or repeat repair when the second check still fails', async () => {
    const f = await fixture(false, false), progress = await f.run()
    // Completed means the program returned; the returned check explicitly failed.
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 1 })
    expect(JSON.parse(progress.finalReport!)).toMatchObject({ state: 'failed', passed: false, exitCode: 1 })
    expect(f.execute).toHaveBeenCalledTimes(1)
    const record = (await f.store.load(f.preview.workflowId))!
    expect(record.systemOutcomes?.flatMap(outcome => outcome.check ? [outcome.check.state] : [])).toEqual(['failed', 'failed'])
    expect(record.intents).toHaveLength(1)
    expect(f.slots.active).toBe(0)
  })
})
