import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeAgentStartRequest } from '../../shared/runtime'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import { createAppSessionStore } from '../app-store'
import { DockBadgeState } from '../dock-badge'
import { PerformanceTrace, setPerformanceRecordingSink, type PerformanceSample } from '../performance-timing'
import { SessionDiffBaselineRegistry } from '../session-diff'
import { archiveTraceTurn, persistTerminalProgress } from './archive'
import { handleRunCompletion, type RunCompletionContext } from './run-completion'
import { createSessionPublisher } from './run-session'

vi.mock('electron', () => ({ app: {} }))
// This contract covers catalog publication. Archive durability has its own real-directory
// integration tests; completion must still await both of these boundaries here.
vi.mock('./archive', () => ({
  archiveTraceTurn: vi.fn(async () => undefined),
  persistTerminalProgress: vi.fn(async () => undefined),
  observedTurnTiming: () => undefined
}))

const directories: string[] = []
afterEach(async () => {
  setPerformanceRecordingSink(null)
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const userData = await mkdtemp(join(tmpdir(), 'scry-completion-catalog-'))
  directories.push(userData)
  const store = createAppSessionStore(userData)
  const record = vi.spyOn(store, 'record')
  const send = vi.fn()
  const notifyChanged = vi.fn()
  const getWindow = () => ({ webContents: { send } }) as unknown as BrowserWindow
  const runState: ActiveRun = { runId: 'run-1', userText: 'question', done: false, items: [] }
  let observedSessionId: string | undefined
  let diffContext = 'run-1'
  const observed = vi.fn((id: string) => { observedSessionId = id })
  const publishSessionId = createSessionPublisher({
    runState, providerId: 'codex', runtimeProvider: 'codex_cli', runId: runState.runId,
    cwd: undefined, catalogCwd: userData, displayPrompt: 'question', contextKey: 'context',
    isRemoteRun: false, getContextRevision: () => 0,
    getDiffContextKey: () => diffContext, setDiffContextKey: key => { diffContext = key },
    setObservedSessionId: observed, sessionBaselineKey: (context, id) => `${context}:${id}`,
    sessionDiffBaselines: new SessionDiffBaselineRegistry(),
    sessionByContext: new Map(), sessionAliasesByContext: new Map(), sessionRevisionByContext: new Map(),
    scopedSessionKey: id => id, dockBadge: new DockBadgeState(() => undefined),
    appSessionStore: () => store, runs: { isViewed: () => false, notifyChanged }, getWindow
  })
  const timing: TraceEvent = { id: 'timing', runId: runState.runId, ts: new Date(0).toISOString(), kind: 'model', stage: 'text', text: '' }
  const ctx: RunCompletionContext = {
    state: { terminalArchiveCommitted: false, remoteRecordingFailed: false },
    providerId: 'codex', runtimeProvider: 'codex_cli', cwd: undefined, catalogCwd: userData,
    runId: runState.runId, request: normalizeAgentStartRequest({ providerId: 'codex', prompt: 'question' }),
    options: {}, displayPrompt: 'question', attachments: [], runState, managedCommitHookEnv: undefined,
    managedRecorderEnabled: false, canonicalLifecycle: true, isRemoteRun: false,
    recordingRecoveryHint: 'recover', recordingBlockedSessions: new Map(), scopedSessionKey: id => id,
    getWindow, emit: () => undefined, finishTurnWallTiming: () => timing,
    finalizeTurnDiff: async () => undefined, finalizeSessionDiff: async () => undefined,
    persistLlmPerformance: async () => undefined, observedProviderStartedAt: undefined,
    getObservedSessionId: () => observedSessionId, getResume: () => undefined, publishSessionId,
    appSessionStore: () => store, mirrorSessionTranscript: async () => undefined,
    ingestion: { idle: async () => undefined, liveIdle: async () => undefined },
    flushTraceSend: () => undefined, persistRunData: () => undefined,
    settleManagedConversation: async () => undefined, finishRemote: () => undefined,
    markTerminalAttention: () => undefined, firstTextPerf: new PerformanceTrace('test.first_text'),
    runs: { isFocused: () => false }
  }
  return { ctx, store, record, observed, send, publishSessionId, notifyChanged }
}

describe('terminal catalog publication', () => {
  it.each(['completed', 'interrupted'] as const)('separates terminal work before diff completion: %s', async status => {
    const current = await fixture()
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    await handleRunCompletion({ externalSessionId: 'native-1', status }, current.ctx)
    const terminal = samples.filter(sample => sample.name === 'agent.terminal_finalize')
    expect(terminal).toHaveLength(1)
    expect(terminal[0].checkpoints.map(point => point.stage)).toEqual([
      'provider_terminal', 'llm_performance_settled', 'attachment_owner_settled',
      'catalog_settled', 'live_ingestion_idle', 'terminal_progress_settled',
      'turn_diff_joined', 'diff_complete', 'archive_committed', 'database_projected', 'renderer_terminal'
    ])
    expect(terminal[0].dimensions).toEqual({ provider: 'codex' })
    expect(terminal[0].counters).toEqual({ events: 0, committed: 1 })
    expect(JSON.stringify(terminal)).not.toContain('native-1')
    expect(JSON.stringify(terminal)).not.toContain(current.ctx.catalogCwd)
  })

  it.each([false, true])('records identity and outcome once when the Provider ID was already published: %s', async alreadyPublished => {
    const current = await fixture()
    if (alreadyPublished) {
      current.publishSessionId('native-1')
      expect(current.record).toHaveBeenCalledTimes(1)
      current.record.mockClear()
      current.observed.mockClear()
    }
    await handleRunCompletion({ externalSessionId: 'native-1', status: 'completed' }, current.ctx)
    expect(current.record).toHaveBeenCalledTimes(1)
    expect(current.record).toHaveBeenCalledWith(expect.objectContaining({ externalSessionId: 'native-1', lastRunOutcome: 'completed' }))
    // Only the duplicate catalog write is removed, not identity/baseline publication.
    expect(current.observed).toHaveBeenCalledWith('native-1')
    expect(current.store.load()).toEqual([expect.objectContaining({ sessionId: 'native-1', runId: 'run-1', lastRunOutcome: 'completed' })])
    expect(persistTerminalProgress).toHaveBeenCalledTimes(1)
    expect(archiveTraceTurn).toHaveBeenCalledTimes(1)
    expect(current.ctx.state.terminalArchiveCommitted).toBe(true)
  })

  it('retains the terminal catalog error instead of losing it in identity publication', async () => {
    const current = await fixture()
    current.record.mockImplementationOnce(() => { throw new Error('catalog write failed') })
    await handleRunCompletion({ externalSessionId: 'native-1', status: 'completed' }, current.ctx)
    expect(current.record).toHaveBeenCalledTimes(1)
    expect(current.send).toHaveBeenCalledWith('agent:error', expect.objectContaining({ category: 'catalog', message: expect.stringContaining('catalog write failed') }))
    expect(current.store.load()).toEqual([])
    expect(archiveTraceTurn).toHaveBeenCalledTimes(1)
  })
})

describe('session binding signal', () => {
  it('notifies the live-run readers so a bound session is visible without a tick', async () => {
    const { publishSessionId, notifyChanged } = await fixture()
    publishSessionId('native-session-1')
    expect(notifyChanged).toHaveBeenCalled()
  })
})
