import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStartRequest } from '../shared/runtime'
import type { TraceEvent } from '../shared/trace'
import { WORKFLOW_SIZE_GUIDELINES } from '../shared/workflow-size'
import { workflowAuthoringCopy } from '../shared/constants/workflow-authoring-copy'
import type { ProviderStructuredOutput } from './providers/types'
import { FileWorkflowStore } from './workflow-store'
import type { AppRunStartOptions } from './app-run-start'
import { createAppWorkflowRuntime } from './workflow-app-runtime'
import { ProviderRegistry } from './providers/registry'
import { createSmokeProviderAdapter } from './providers/smoke'

const homes: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('production App workflow planning bridge with an offline terminal fixture', () => {
  it.each(WORKFLOW_SIZE_GUIDELINES)('passes the frozen %s advice through startAppRun exactly once', async value => {
    vi.stubEnv('SCRY_ELECTRON_SMOKE_WORKFLOW', '1')
    const home = await mkdtemp(join(tmpdir(), 'scry-size-bridge-'))
    homes.push(home)
    // Explicit mock declaration, not a Codex native-authoring capability claim.
    const adapter = { ...createSmokeProviderAdapter('codex'), workflowAuthoring: { source: 'claude_sdk_success_result' as const } }
    const nativeRun = vi.spyOn(adapter, 'run').mockImplementation(() => { throw new Error('No actual Provider execution in bridge test') })
    const registry = new ProviderRegistry([adapter])
    const goal = 'Inspect exactly 20 reviewers. Preserve this original request.'
    const startAppRun = vi.fn(async (_request: AgentStartRequest, options?: AppRunStartOptions) => {
      if (!options?.runId || !options.onTerminal) throw new Error('Missing production planning bridge options')
      options.onProviderDispatchAttempt?.()
      const output = JSON.stringify({ schemaVersion: 1, workflowId: 'candidate', programRevision: 'candidate', workspace: home,
        userGoal: goal, roles: [], sizeOverrideReason: 'The current user explicitly requested 20 reviewers.',
        body: { kind: 'sequence', blockId: 'root', blocks: [
          ...Array.from({ length: 20 }, (_, index) => ({ kind: 'call', blockId: 'review_' + index, role: 'worker', prompt: 'review' })),
          { kind: 'return', blockId: 'finish', ref: { nodeId: 'review_19' } }
        ] } })
      const base = { runId: options.runId, ts: new Date().toISOString() }
      const items: TraceEvent[] = [
        { ...base, id: 'output', kind: 'model', stage: 'text', text: 'SHADOW_ASSISTANT_TEXT_MUST_NOT_BE_A_PROGRAM' },
        { ...base, id: 'terminal', kind: 'harness', stage: 'result' }
      ]
      await options.onTerminal({ runId: options.runId, status: 'completed', settled: true, items,
        archiveRef: 'fixture-archive:' + options.runId,
        structuredOutput: { source: 'claude_sdk_success_result', json: output } })
      return { runId: options.runId }
    })
    const stop = vi.fn(() => true)
    const { workflowService: service } = createAppWorkflowRuntime({
      userData: join(home, 'userData'), providerRegistry: registry,
      providerContextKey: (provider, cwd, profile) => JSON.stringify([provider, cwd, profile]),
      withProviderOperation: async (_provider, operation) => await operation(),
      startAppRun, requestRunStop: stop, requestRunStopAgain: stop,
      resolveTemplateProjectDirectory: cwd => cwd, onProgress: () => {}
    })
    await service.setSizeGuideline(value)
    expect(startAppRun).not.toHaveBeenCalled()
    const binding = { providerId: 'codex' as const, requestedModel: { id: 'workflow-fixture' }, permissionMode: 'default' as const }
    const preview = await service.planCommand({ command: '/scry-workflow run ' + goal, commandId: 'bridge-size', workspace: home,
      orchestrator: { ...binding, role: 'orchestrator' }, roles: [{ ...binding, role: 'worker' }] })
    expect(startAppRun).toHaveBeenCalledTimes(1)
    const [request, options] = startAppRun.mock.calls[0]
    expect(request.prompt).toContain(goal)
    expect(request.cwd).toBe(home)
    expect(options).toMatchObject({ origin: 'workflow', purpose: 'workflow_authoring', runId: 'workflow-plan-' + preview.workflowId })
    expect(options?.expectedWorkflowCapability).toBeTypeOf('string')
    const prompt = request.prompt
    if (value === 'unrestricted') expect(prompt).not.toContain('Soft workflow size guideline')
    else expect(prompt).toContain('prefer fewer than ' + ({ small: 5, medium: 10, large: 50 }[value]) + ' logical Agent calls')
    expect(preview).toMatchObject({ plannedCalls: 20, planningSize: { snapshot: { value, source: 'preference' },
      overrideReason: 'The current user explicitly requested 20 reviewers.' } })
    expect((await service.snapshot(preview.workflowId))?.dispatchAttempts).toBe(0)
    expect((await new FileWorkflowStore(join(home, 'userData')).loadPlanningIntent(preview.workflowId))?.result)
      .toMatchObject({ outputSource: 'claude_sdk_success_result', archiveRef: 'fixture-archive:workflow-plan-' + preview.workflowId })
    expect(nativeRun).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it.each(['undeclared', 'text_only', 'no_archive', 'no_result', 'launch_unknown', 'wrong_source', 'failed'] as const)(
    'does not admit or execute a candidate from %s evidence', async mode => {
      vi.stubEnv('SCRY_ELECTRON_SMOKE_WORKFLOW', '1')
      const home = await mkdtemp(join(tmpdir(), 'scry-authoring-evidence-'))
      homes.push(home)
      const adapter = { ...createSmokeProviderAdapter('codex'),
        ...(mode === 'undeclared' ? {} : { workflowAuthoring: { source: 'claude_sdk_success_result' as const } }) }
      const nativeRun = vi.spyOn(adapter, 'run').mockImplementation(() => { throw new Error('No native calls in this boundary test') })
      const output = JSON.stringify({ schemaVersion: 1, body: { kind: 'sequence', blockId: 'root', blocks: [
        { kind: 'call', blockId: 'work', role: 'worker', prompt: 'work' },
        { kind: 'return', blockId: 'finish', ref: { nodeId: 'work' } }
      ] } })
      let plannedId: string | undefined
      const startAppRun = vi.fn(async (_request: AgentStartRequest, options?: AppRunStartOptions) => {
        if (!options?.runId || !options.onTerminal) throw new Error('Missing planning terminal callback')
        plannedId = options.runId.slice('workflow-plan-'.length)
        options.onProviderDispatchAttempt?.()
        if (mode === 'launch_unknown') throw new Error('fixture-start-return-unknown')
        const base = { runId: options.runId, ts: new Date().toISOString() }
        const items: TraceEvent[] = [{ ...base, id: 'shadow', kind: 'model', stage: 'text', text: output }]
        if (mode !== 'no_result') items.push({ ...base, id: 'terminal', kind: 'harness', stage: 'result' })
        await options.onTerminal({ runId: options.runId, status: mode === 'failed' ? 'failed' : 'completed',
          settled: true, items,
          ...(mode === 'no_archive' ? {} : { archiveRef: 'fixture/archive' }),
          ...(mode === 'text_only' ? {} : { structuredOutput: {
            source: mode === 'wrong_source' ? 'foreign_shadow' : 'claude_sdk_success_result', json: output
          } as ProviderStructuredOutput }) })
        return { runId: options.runId }
      })
      const stop = vi.fn(() => true)
      const { workflowService: service } = createAppWorkflowRuntime({
        userData: join(home, 'userData'), providerRegistry: new ProviderRegistry([adapter]),
        providerContextKey: (provider, cwd, profile) => JSON.stringify([provider, cwd, profile]),
        withProviderOperation: async (_provider, operation) => await operation(),
        startAppRun, requestRunStop: stop, requestRunStopAgain: stop,
        resolveTemplateProjectDirectory: cwd => cwd, onProgress: () => {}
      })
      const binding = { providerId: 'codex' as const, requestedModel: { id: 'workflow-fixture' }, permissionMode: 'default' as const }
      await expect(service.planCommand({ command: '/scry-workflow run Test canonical evidence', commandId: 'boundary-' + mode,
        workspace: home, orchestrator: { ...binding, role: 'orchestrator' }, roles: [{ ...binding, role: 'worker' }] }))
        .rejects.toThrow(mode === 'undeclared' ? workflowAuthoringCopy.unavailable : mode === 'launch_unknown' ? 'fixture-start-return-unknown'
          : mode === 'failed' ? workflowAuthoringCopy.providerIncomplete('failed') : workflowAuthoringCopy.missingCandidate)
      expect(startAppRun).toHaveBeenCalledTimes(mode === 'undeclared' ? 0 : 1)
      const store = new FileWorkflowStore(join(home, 'userData'))
      const intents = []
      for await (const intent of store.planningIntents()) intents.push(intent)
      expect(intents).toHaveLength(1)
      expect(intents[0]).toMatchObject({ status: mode === 'launch_unknown' ? 'unknown' : 'failed', scopeSettled: mode !== 'launch_unknown' })
      expect(intents[0].result?.output).toBeUndefined()
      expect(intents[0].result?.outputSource).toBeUndefined()
      if (plannedId) expect(await service.snapshot(plannedId)).toBeUndefined()
      else expect(intents[0].providerDispatch).toBe('not_attempted')
      expect(nativeRun).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
    })
})
