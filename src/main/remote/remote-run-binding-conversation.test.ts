import { describe, expect, it, vi } from 'vitest'
import { createRemoteRunBinding, type RemoteRunBindingDependencies } from './remote-run-binding'
import type { ManagedLaunch } from './managed-launches'
import type { ManagedConversationStart } from '../conversation-service-deps'
import type { AgentStartRequest } from '../../shared/runtime'

// Daemon mode `conversation:send`: the ledger intent carries only a marker, and the
// dispatch runs the launch the daemon prepared in memory, under the turn's own run id.

type StartInput = Parameters<NonNullable<RemoteRunBindingDependencies['startAppRun']>>[0]
const marker = { conversationId: 'conversation-1', runId: 'turn-run-1' }
const image = { kind: 'image' as const, name: 'a.png', mimeType: 'image/png' as const, dataBase64: 'AA==', size: 1 }
const request: AgentStartRequest = { prompt: 'continue', providerId: 'claude', cwd: '/w', attachments: [image] }

function launch(overrides: Partial<AgentStartRequest> = {}) {
  const managedConversation = { conversationId: marker.conversationId, runId: marker.runId } as unknown as ManagedConversationStart
  const value: ManagedLaunch = { request: { ...request, ...overrides }, managedConversation, started: vi.fn(), failed: vi.fn() }
  return value
}

const routing = { cwd: '/w', providerId: 'claude', prompt: 'continue', conversation: marker }

describe('remote run binding: conversation runs', () => {
  it('runs the prepared launch under the conversation turn run id', async () => {
    const prepared = launch()
    const progress = vi.fn()
    const startAppRun = vi.fn(async (input: StartInput) => {
      input.onStarted?.(input.runId)
      return { status: 'completed' as const, recording: 'committed' as const }
    })
    const managedLaunch = vi.fn(() => prepared)
    const start = createRemoteRunBinding({ startAppRun, managedLaunch, nextScryRunId: () => 'minted-id' })
    await start({ runId: 'ledger-1', routing, progress, output: vi.fn(), grantScope: 'local' })
    expect(managedLaunch).toHaveBeenCalledWith(marker.runId)
    const input = startAppRun.mock.calls[0]![0]
    expect(input.runId).toBe(marker.runId)
    // The App's original request and attachments, not the ledger's inlined copy.
    expect(input.request).toBe(prepared.request)
    expect(input.providerPrompt).toBeUndefined()
    expect(input.managedConversation).toBe(prepared.managedConversation)
    expect(prepared.started).toHaveBeenCalledWith(marker.runId)
    expect(prepared.failed).not.toHaveBeenCalled()
    expect(progress).toHaveBeenCalledWith(expect.stringContaining(`"scryRunId":"${marker.runId}"`))
  })

  it('fails before any Provider when the launch is gone, as after a daemon restart', async () => {
    const startAppRun = vi.fn()
    const start = createRemoteRunBinding({ startAppRun, managedLaunch: () => undefined })
    await expect(start({ runId: 'ledger-1', routing, progress: vi.fn(), output: vi.fn(), grantScope: 'local' }))
      .rejects.toThrow('conversation_start_unavailable')
    expect(startAppRun).not.toHaveBeenCalled()
    // A host without a launch registry refuses the marker the same way.
    await expect(createRemoteRunBinding({ startAppRun })({ runId: 'ledger-2', routing, progress: vi.fn(), output: vi.fn() }))
      .rejects.toThrow('conversation_start_unavailable')
  })

  it('refuses a launch whose target differs from the recorded routing', async () => {
    const prepared = launch({ cwd: '/elsewhere' })
    const startAppRun = vi.fn()
    const start = createRemoteRunBinding({ startAppRun, managedLaunch: () => prepared })
    await expect(start({ runId: 'ledger-1', routing, progress: vi.fn(), output: vi.fn(), grantScope: 'local' }))
      .rejects.toThrow('conversation_start_mismatch')
    expect(startAppRun).not.toHaveBeenCalled()
    expect(prepared.failed).toHaveBeenCalledTimes(1)
  })

  it('settles the send from the error when the run never started, and only then', async () => {
    const refused = launch()
    const start = createRemoteRunBinding({ startAppRun: vi.fn(async () => { throw new Error('admission refused') }), managedLaunch: () => refused })
    await expect(start({ runId: 'ledger-1', routing, progress: vi.fn(), output: vi.fn(), grantScope: 'local' })).rejects.toThrow('admission refused')
    expect(refused.failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'admission refused' }))

    // After the run started, its outcome belongs to the conversation's own settlement.
    const started = launch()
    const failingRun = createRemoteRunBinding({
      startAppRun: vi.fn(async (input: StartInput) => {
        input.onStarted?.(input.runId)
        return { status: 'failed' as const, recording: 'committed' as const, error: 'provider failed' }
      }),
      managedLaunch: () => started
    })
    await expect(failingRun({ runId: 'ledger-2', routing, progress: vi.fn(), output: vi.fn(), grantScope: 'local' })).rejects.toThrow('provider failed')
    expect(started.failed).not.toHaveBeenCalled()
  })
})
