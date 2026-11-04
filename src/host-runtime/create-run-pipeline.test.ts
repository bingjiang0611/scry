import { describe, expect, it, vi } from 'vitest'
import { createRunPipeline } from './create-run-pipeline'
import { DockBadgeState } from '../main/dock-badge'

// M2-4: this module is the assembly entry both main and the daemon call. The test
// builds it with fakes and no Electron at all - if any pipeline module started
// needing the electron runtime again, importing this file would fail here.
function inputs(overrides: Record<string, unknown> = {}) {
  const startWorkspaceRun = vi.fn(async () => ({ ok: true, runId: 'workspace' }))
  const startRun = vi.fn(async () => ({ ok: true, runId: 'run' }))
  return {
    startWorkspaceRun, startRun,
    inputs: {
      renderer: { send: () => {}, isFocused: () => true },
      rendererCanReceive: () => true,
      activeRunSessionKey: () => null,
      dockBadge: new DockBadgeState(),
      mainEventId: (prefix: string, runId: string) => `${prefix}-${runId}`,
      getWindow: () => null,
      getCurrentCwd: () => '/workspace',
      getStartupManagedRecovery: () => Promise.resolve(),
      isShuttingDown: () => false,
      nextRunSequence: () => 0,
      sourceControl: {},
      providerRegistry: {},
      resolveKnownProjectDirectory: () => '/workspace',
      resolveRemoteProjectDirectory: () => undefined,
      startWorkspaceRun, startRun,
      piRunDiagnostics: {},
      appSessionStore: {},
      providerOperationGate: {},
      providerContextKey: () => 'context',
      providerSessionKey: () => 'session',
      contextAdmission: {},
      resetSessionContext: () => {},
      sessionRevisionByContext: new Map(),
      sessionByContext: new Map(),
      sessionAliasesByContext: new Map(),
      deletingSessions: new Set(),
      conversationStore: {},
      assertLegacyConversationWriteAllowed: () => {},
      recordingBlockedSessions: new Set(),
      homeDir: '/home',
      sessionDiffBaselines: new Map(),
      recordingRecoveryHint: () => undefined,
      sessionBaselineKey: () => 'baseline',
      requestRunStop: () => true,
      bumpSessionRevision: () => 0,
      remoteRunIds: new Set<string>(),
      remoteRunLedgerIds: new Map<string, string>(),
      mirrorSessionTranscript: async () => {},
      ...overrides
    } as unknown as Parameters<typeof createRunPipeline>[0]
  }
}

describe('createRunPipeline', () => {
  it('exposes the run registry, trace output and receipts main consumes', () => {
    const pipeline = createRunPipeline(inputs().inputs)
    for (const key of ['runs', 'runStopLifecycle', 'userQuestionBroker', 'traceOutput',
      'boundedLiveRun', 'runTraces', 'startAppRun', 'remoteStartReceipts', 'requestRunStop'] as const) {
      expect(pipeline[key], key).toBeDefined()
    }
    expect(pipeline.runs).toBeInstanceOf(Object)
    expect(typeof pipeline.startAppRun).toBe('function')
  })

  it('routes a workspace payload to the injected workspace start', async () => {
    const fixture = inputs()
    const pipeline = createRunPipeline(fixture.inputs)
    await pipeline.startAppRun({ workspace: '/workspace', prompt: 'hi' } as never)
    expect(fixture.startWorkspaceRun).toHaveBeenCalledTimes(1)
    expect(fixture.startRun).not.toHaveBeenCalled()
  })

  it('routes a plain payload to the injected run start', async () => {
    const fixture = inputs()
    const pipeline = createRunPipeline(fixture.inputs)
    await pipeline.startAppRun({ prompt: 'hi' } as never)
    expect(fixture.startRun).toHaveBeenCalledTimes(1)
    expect(fixture.startWorkspaceRun).not.toHaveBeenCalled()
  })
})
