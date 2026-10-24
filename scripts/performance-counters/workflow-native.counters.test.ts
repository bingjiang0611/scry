import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'
import { FileWorkflowStore } from '../../src/main/workflow-store'
import { WorkflowService } from '../../src/main/workflow-service'
import { WorkflowSystemHost } from '../../src/main/workflow-system-host'
import { WorkflowSlots } from '../../src/main/workflow-slots'

const meter = vi.hoisted(() => ({ directory: '', active: false, nativeWrites: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    const result = await actual.writeFile(...args)
    if (meter.active && String(args[0]).startsWith(meter.directory + sep)) {
      const value: unknown = JSON.parse(String(args[1]))
      if (value && typeof value === 'object' && 'state' in value && value.state === 'known' && 'derivedFrom' in value && Array.isArray(value.derivedFrom) && value.derivedFrom.some(source => typeof source === 'string' && source.startsWith('system:'))) {
        expect(args[2]).toMatchObject({ flush: true })
        meter.nativeWrites++
      }
    }
    return result
  } }
})

// This per-result counter is not a substitute for the unchanged eight-step,
// two-revision legacy acceptance test or its five-second deadline.
async function workload(extraWrite = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'scry-native-counter-'))), source = join(directory, 'source'), data = join(directory, 'data')
  await mkdir(source)
  await writeFile(join(source, 'input'), 'x')
  const store = new FileWorkflowStore(data), host = new WorkflowSystemHost(join(directory, 'replicas'), store, () => ({}))
  const execute = vi.fn(() => { throw new Error('Native steps must not dispatch an Agent') })
  const service = new WorkflowService({ store, systems: host, slots: new WorkflowSlots(1), providerRegistered: () => true,
    runControls: async role => ({ descriptor: { id: role.providerId, label: role.providerId, runtimeProvider: 'claude_sdk', transport: 'counter', available: true,
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'counter' } },
    identity: 'native-counter', model: true, stop: true, independentRun: true, terminalOutput: true }),
    plan: async () => ({ output: JSON.stringify({ body: { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'replica', blockId: 'candidate' }, { kind: 'return', blockId: 'finish', ref: { nodeId: 'candidate' } }
    ] } }) }), execute })
  const started = performance.now()
  meter.directory = join(data, 'workflows')
  meter.nativeWrites = 0
  meter.active = true
  try {
    const preview = await service.planCommand({ workspace: source, command: '/scry-workflow run native checkpoint', orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const progress = await service.start(preview.workflowId, approval), record = (await store.load(preview.workflowId))!
    expect(progress.state).toBe('completed')
    expect(progress.dispatchAttempts).toBe(0)
    expect(execute).not.toHaveBeenCalled()
    expect(record.systemIntents).toHaveLength(1)
    expect(record.systemOutcomes).toHaveLength(1)
    const outcome = record.systemOutcomes![0]
    expect(outcome).toMatchObject({ state: 'completed', settled: true, replica: { workflowId: preview.workflowId } })
    const value = await store.loadValue(preview.workflowId, outcome.resultRef!)
    expect(value).toMatchObject({ state: 'known', replica: outcome.replica, value: outcome.replica })
    if (extraWrite) await store.saveValue(preview.workflowId, 'extra-native-copy', value)
    return { writes: meter.nativeWrites, durationMs: performance.now() - started }
  } finally {
    meter.active = false
    service.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('native result fixed workload', () => {
  it('counts flushed native-value writes through the canonical Service and FileStore', async () => {
    const durations: number[] = []
    const counters = await repeatCounters(defaultRepeats, async () => {
      const result = await workload()
      durations.push(result.durationMs)
      return { writes: result.writes }
    })
    writeCollector('workflow-native', [measured({ scenario: 'workflow.native-result-checkpoint', metric: 'io.native-value.writes', layer: 'io', unit: 'count',
      workload: 'source-files=1;source-bytes=1;roots=1;replica-steps=1;agent-attempts=0',
      source: 'pass-through completed flushed FileWorkflowStore writes of main SystemStep envelopes on the canonical Service execution chain' }, counters.writes)])
    if (process.env.SCRY_WORKFLOW_NATIVE_TIMINGS) await writeFile(process.env.SCRY_WORKFLOW_NATIVE_TIMINGS, JSON.stringify({ durations }, null, 2))
  })

  it('observes one deliberately added real durable value write', async () => {
    const ordinary = await workload(), redundant = await workload(true)
    expect(redundant.writes).toBe(ordinary.writes + 1)
  })
})
