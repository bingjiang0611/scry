import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecorderEnablement } from '../core/turn-recorder/config'
import type { managedRecorderMode, recoverManagedRecorderTurns } from '../core/turn-recorder/managed'
import type { recoverManagedTraceProgress, recoverManagedTraceTurns } from './managed-turn-commit'
import type { recoverTraceTurnProgress } from './trace-turn-progress'
import { recoverAppRunRecording } from './app-run-recording-recovery'

const calls = vi.hoisted(() => ({
  trace: vi.fn<typeof recoverTraceTurnProgress>(), mode: vi.fn<typeof managedRecorderMode>(),
  journal: vi.fn<typeof recoverManagedTraceTurns>(), progress: vi.fn<typeof recoverManagedTraceProgress>(),
  recorder: vi.fn<typeof recoverManagedRecorderTurns>()
}))
vi.mock('../core/turn-recorder/managed', async original => ({
  ...await original<typeof import('../core/turn-recorder/managed')>(),
  managedRecorderMode: calls.mode, recoverManagedRecorderTurns: calls.recorder
}))
vi.mock('./managed-turn-commit', () => ({ recoverManagedTraceTurns: calls.journal, recoverManagedTraceProgress: calls.progress }))
vi.mock('./trace-turn-progress', () => ({ recoverTraceTurnProgress: calls.trace }))
const recovered = (count = 0, pending = 0) => ({ recovered: count, pending, errors: [] })
beforeEach(() => {
  vi.clearAllMocks()
  calls.trace.mockReset().mockResolvedValue(recovered())
  calls.mode.mockReset().mockResolvedValue({ status: 'disabled', reason: 'missing_config' })
  calls.journal.mockReset().mockResolvedValue(recovered())
  calls.progress.mockReset().mockResolvedValue(recovered())
  calls.recorder.mockReset().mockResolvedValue(recovered())
})
type Input = Parameters<typeof recoverAppRunRecording>[0]
function fixture(overrides: Partial<Input> = {}) {
  let userData = '/fixture/first-userData', live = false
  const mark = vi.fn<Input['startPerf']['mark']>()
  const resolveManagedCommitHookEnv = vi.fn<Input['resolveManagedCommitHookEnv']>(async () => ({}))
  const input: Input = {
    userDataDir: () => userData, cwd: '/fixture/workspace', providerId: 'codex', runtimeProvider: 'codex_cli',
    resume: 'native-session', isAuthoringRun: false, resolveManagedCommitHookEnv,
    isLiveManagedRun: () => live, startPerf: { mark }, ...overrides
  }
  return { input, mark, resolveManagedCommitHookEnv,
    setUserData: (next: string) => { userData = next }, setLive: (next: boolean) => { live = next } }
}

// These are orchestration seams, not native recovery acceptance. Existing real
// journal/progress/recorder suites and the isolated App exercise persistence.
describe('App startup recording recovery phase', () => {
  it('keeps App trace evidence but excludes recorder and commit execution during authoring', async () => {
    const f = fixture({ isAuthoringRun: true })
    calls.trace.mockResolvedValue(recovered(2))
    await expect(recoverAppRunRecording(f.input)).resolves.toEqual({ managedRecorderEnabled: false,
      managedRecorderEnablement: undefined, managedCommitHookEnv: undefined, recoveredManagedTurns: 2 })
    expect(calls.trace).toHaveBeenCalledOnce()
    expect(calls.mode).not.toHaveBeenCalled()
    expect(f.resolveManagedCommitHookEnv).not.toHaveBeenCalled()
    expect(calls.journal).not.toHaveBeenCalled()
    expect(calls.recorder).not.toHaveBeenCalled()
  })

  it('does not inspect a recorder without a workspace', async () => {
    const f = fixture({ cwd: undefined })
    await expect(recoverAppRunRecording(f.input)).resolves.toMatchObject({ managedRecorderEnabled: false, recoveredManagedTurns: 0 })
    expect(calls.trace).not.toHaveBeenCalled()
    expect(calls.mode).not.toHaveBeenCalled()
    expect(f.mark).toHaveBeenCalledExactlyOnceWith('trace_progress_recovery_ready', { recovered: 0 })
  })

  it('rejects pending App trace evidence before recorder/config/callback work', async () => {
    const f = fixture()
    calls.trace.mockResolvedValue(recovered(0, 4))
    await expect(recoverAppRunRecording(f.input)).rejects.toThrow('Scry trace 仍有 4 轮待恢复')
    expect(calls.mode).not.toHaveBeenCalled()
    expect(calls.journal).not.toHaveBeenCalled()
    expect(f.resolveManagedCommitHookEnv).not.toHaveBeenCalled()
  })

  it('still recovers existing journals/progress/opens when new recording is disabled', async () => {
    const f = fixture()
    await expect(recoverAppRunRecording(f.input)).resolves.toMatchObject({ managedRecorderEnabled: false })
    expect(calls.journal).toHaveBeenCalledOnce()
    expect(calls.progress).toHaveBeenCalledOnce()
    expect(calls.recorder).toHaveBeenCalledExactlyOnceWith(f.input.cwd, undefined, {
      provider: 'codex', sessionId: 'native-session', abandonProvisional: true,
      commitNotifications: 'detach', isLiveManagedRun: f.input.isLiveManagedRun
    })
    expect(f.resolveManagedCommitHookEnv).not.toHaveBeenCalled()
  })

  it('preserves recovery order, exact enablement/environment objects, totals and milestone positions', async () => {
    const f = fixture(), order: string[] = []
    const enablement: Extract<RecorderEnablement, { enabled: true }> = {
      enabled: true, workspaceRoot: '/fixture/workspace', dataRoot: '/fixture/workspace/.scry',
      config: { schemaVersion: 1, enabled: true, workspaceId: 'fixture', dataDir: '.scry',
        repositories: { mode: 'workspace-only' }, capture: { prompt: true, assistant: true, toolOutput: 'full', diff: true, hooks: true } }
    }
    const env = { SCRY_RECOVERY_FIXTURE: '1' }
    calls.trace.mockImplementation(async () => { order.push('trace'); return recovered(1) })
    f.mark.mockImplementation(stage => { order.push(stage) })
    calls.mode.mockImplementation(async () => { order.push('mode'); return { status: 'enabled', enablement } })
    f.resolveManagedCommitHookEnv.mockImplementation(async () => { order.push('environment'); return env })
    calls.journal.mockImplementation(async () => { order.push('journal'); return recovered(2) })
    calls.progress.mockImplementation(async () => { order.push('progress'); return recovered(3) })
    calls.recorder.mockImplementation(async () => { order.push('recorder'); return recovered(4) })
    const result = await recoverAppRunRecording(f.input)
    expect(order).toEqual(['trace', 'trace_progress_recovery_ready', 'mode', 'environment', 'journal', 'progress', 'recorder', 'managed_recording_recovery_ready'])
    expect(result.managedRecorderEnablement).toBe(enablement)
    expect(result.managedCommitHookEnv).toBe(env)
    expect(result.recoveredManagedTurns).toBe(10)
    expect(f.resolveManagedCommitHookEnv.mock.calls[0][1]).toBe(enablement)
    for (const mock of [calls.journal, calls.progress]) expect(mock.mock.calls[0][1]).toMatchObject({ waitMs: 250, commitHookEnv: env })
    expect(f.mark.mock.calls).toEqual([['trace_progress_recovery_ready', { recovered: 1 }], ['managed_recording_recovery_ready', { recovered: 10 }]])
  })

  it.each([{ journal: 1, progress: 0 }, { journal: 0, progress: 1 }, { journal: 1, progress: 1 }])(
    'does not abandon provisional identity while a canonical artifact is pending: %o', async pending => {
      const f = fixture()
      calls.journal.mockResolvedValue(recovered(0, pending.journal))
      calls.progress.mockResolvedValue(recovered(0, pending.progress))
      await expect(recoverAppRunRecording(f.input)).rejects.toThrow('Scry 精确记录仍有 1 轮待恢复')
      expect(calls.recorder.mock.calls[0][2]).toMatchObject({ abandonProvisional: false, commitNotifications: 'detach' })
    })

  it('does not count the same pending turn in three recovery layers three times', async () => {
    const f = fixture()
    calls.journal.mockResolvedValue(recovered(0, 1))
    calls.progress.mockResolvedValue(recovered(0, 1))
    calls.recorder.mockResolvedValue(recovered(0, 1))
    await expect(recoverAppRunRecording(f.input)).rejects.toThrow('Scry 精确记录仍有 1 轮待恢复')
  })

  it('preserves live owner callbacks and current userData reads across awaits', async () => {
    const f = fixture(), liveObserved: boolean[] = []
    calls.trace.mockImplementation(async (_root, scope) => {
      expect(scope?.isLiveManagedRun).toBe(f.input.isLiveManagedRun)
      liveObserved.push(scope!.isLiveManagedRun!('run'))
      return recovered()
    })
    calls.journal.mockImplementation(async () => {
      f.setLive(true); f.setUserData('/fixture/current-userData'); return recovered()
    })
    calls.progress.mockImplementation(async (root, scope) => {
      expect(root).toBe('/fixture/current-userData')
      expect(scope?.isLiveManagedRun).toBe(f.input.isLiveManagedRun)
      liveObserved.push(scope!.isLiveManagedRun!('run'))
      return recovered()
    })
    await recoverAppRunRecording(f.input)
    expect(liveObserved).toEqual([false, true])
    expect(calls.recorder.mock.calls[0][2]?.isLiveManagedRun).toBe(f.input.isLiveManagedRun)
  })
})
