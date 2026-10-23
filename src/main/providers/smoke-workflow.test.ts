import { afterEach, expect, it, vi } from 'vitest'
import { createSmokeProviderAdapter } from './smoke'
import { workflowBindingControls } from '../workflow-capability'

// Explicit synthetic functions, not SDK/process/recorder acceptance.
afterEach(() => vi.unstubAllEnvs())
it('does not opt ordinary smoke catalogs into workflow execution', async () => {
  vi.stubEnv('SCRY_ELECTRON_SMOKE_WORKFLOW', '0')
  const adapter = createSmokeProviderAdapter('codex')
  expect(adapter.workflowExecution).toBeUndefined()
  expect((await adapter.runControls!.read({ providerId: 'codex', cwd: '/fixture' })).data?.models).toEqual([])
})
it('exposes the opt-in synthetic catalog and keeps stop/results scoped to each fixture run', async () => {
  vi.stubEnv('SCRY_ELECTRON_SMOKE_WORKFLOW', '1')
  vi.stubEnv('SCRY_ELECTRON_SMOKE_CALLS', '')
  vi.stubEnv('SCRY_ELECTRON_SMOKE_INPUTS', '')
  const adapter = createSmokeProviderAdapter('codex'), context = { providerId: 'codex' as const, cwd: '/fixture' }
  const controls = await adapter.runControls!.read(context)
  const binding = workflowBindingControls({ role: 'orchestrator', providerId: 'codex' }, context, await adapter.describe(), controls, adapter.workflowExecution, true)
  expect(binding).toMatchObject({ model: true, stop: true, independentRun: true, terminalOutput: true })
  expect(binding.identity).toMatch(/^[a-f0-9]{64}$/)
  expect(controls.data?.models[0].model.id).toBe('workflow-fixture')
  const first = adapter.run({ runId: 'first', prompt: 'native composer stop-immediate fixture', attachments: [], emit: vi.fn() })
  const second = adapter.run({ runId: 'second', prompt: 'native composer complete fixture', attachments: [], emit: vi.fn() })
  first.interrupt()
  expect(await first.promise).toMatchObject({ status: 'interrupted', stopped: true, externalSessionId: 'smoke-session-first' })
  expect(await second.promise).toMatchObject({ status: 'completed', stopped: false, externalSessionId: 'smoke-session-second' })
  expect(first.forceKillScope).toBe('run_scoped')
})
