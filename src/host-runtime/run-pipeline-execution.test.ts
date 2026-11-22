import { describe, expect, it, vi } from 'vitest'
import { createRunPipeline, type RunPipelineInputs } from './create-run-pipeline'
import type { AgentStartRequest } from '../shared/runtime'


const payload: AgentStartRequest = { prompt: 'go', providerId: 'claude', cwd: '/w' }

function assembly(execution: 'in-process' | 'daemon') {
  const startRun = vi.fn(async () => { throw new Error('provider must not start') })
  const startWorkspaceRun = vi.fn(async () => { throw new Error('workspace run must not start') })
  const inputs = {
    renderer: { send: () => {} }, rendererCanReceive: () => true,
    activeRunSessionKey: () => null, dockBadge: { view: () => {}, snapshot: () => [] },
    mainEventId: (prefix: string, runId: string) => `${prefix}:${runId}`,
    getCurrentCwd: () => '/w', getStartupManagedRecovery: async () => undefined,
    isShuttingDown: () => false, nextRunSequence: () => 1,
    sourceControl: {}, providerRegistry: { get: () => undefined },
    resolveKnownProjectDirectory: (cwd: string) => cwd, resolveRemoteProjectDirectory: (cwd: string) => cwd,
    startWorkspaceRun, startRun,
    piRunDiagnostics: {}, appSessionStore: () => ({ isArchived: () => false }),
    providerOperationGate: {}, providerContextKey: () => 'k', providerSessionKey: () => 'k',
    contextAdmission: {}, resetSessionContext: () => {},
    sessionRevisionByContext: new Map(), sessionByContext: new Map(), sessionAliasesByContext: new Map(),
    deletingSessions: new Set(), conversationStore: {}, assertLegacyConversationWriteAllowed: () => {},
    recordingBlockedSessions: new Set(), homeDir: '/home', sessionDiffBaselines: new Map(),
    recordingRecoveryHint: () => undefined, sessionBaselineKey: () => 'k',
    requestRunStop: () => true, bumpSessionRevision: () => {},
    remoteRunIds: new Set(), remoteRunLedgerIds: new Map(), mirrorSessionTranscript: async () => undefined,
    execution
  } as unknown as RunPipelineInputs
  return { pipeline: createRunPipeline(inputs), startRun, startWorkspaceRun }
}

describe('run pipeline execution ownership', () => {
  it('keeps the registry and trace views available when the daemon owns runs', () => {
    const { pipeline } = assembly('daemon')
    expect(pipeline.runs.activeStates()).toEqual([])
    expect(typeof pipeline.traceOutput.ack).toBe('function')
    expect(typeof pipeline.requestRunStop).toBe('function')
  })

  it('refuses to start a run in-process and never reaches a Provider', async () => {
    const { pipeline, startRun, startWorkspaceRun } = assembly('daemon')
    await expect(pipeline.startAppRun(payload)).rejects.toThrow('daemon_mode_owns_runs')
    await expect(pipeline.startAppRun({ ...payload, workspace: {} } as AgentStartRequest)).rejects.toThrow('daemon_mode_owns_runs')
    expect(startRun).not.toHaveBeenCalled()
    expect(startWorkspaceRun).not.toHaveBeenCalled()
  })
})
