import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAgentStartRequest } from '../../shared/runtime'
import { createAppSessionStore } from '../app-store'
import { SessionDiffBaselineRegistry } from '../session-diff'
import { createLiveRunState } from './run-live-state'

const receipts = vi.hoisted(() => ({
  getPath: vi.fn<() => string>(),
  appendUsage: vi.fn(),
  recordTurn: vi.fn(() => true)
}))
vi.mock('electron', () => ({ app: { getPath: receipts.getPath } }))
vi.mock('../usage-jsonl', () => ({ appendUsage: receipts.appendUsage }))
vi.mock('../db', () => ({ recordTurn: receipts.recordTurn }))

let userDataDir: string
beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'scry-live-binding-'))
  receipts.getPath.mockReturnValue(userDataDir)
  receipts.appendUsage.mockClear()
})
afterEach(async () => { await rm(userDataDir, { recursive: true, force: true }) })

describe('live run identity', () => {
  it('attributes later usage to the native session published after startup', async () => {
    const sessions = createAppSessionStore(userDataDir)
    const state = await createLiveRunState({
      options: {}, providerId: 'claude', runtimeProvider: 'claude_sdk',
      request: normalizeAgentStartRequest({ prompt: 'task', providerId: 'claude' }),
      cwd: undefined, catalogCwd: '', contextKey: 'context',
      codexHookTrust: [], openCodePluginTrust: undefined,
      managedRecorderEnabled: false, homeDir: userDataDir,
      createRunId: () => 'run-live-binding',
      llmNetworkConfiguration: { read: async () => undefined },
      sessionDiffBaselines: new SessionDiffBaselineRegistry(),
      appSessionStore: () => sessions,
      recordingBlockedSessions: new Map(), getWindow: () => null,
      runs: { isViewed: () => false }, queueTrace: () => { }, rendererCanReceive: () => false,
      mainEventId: (prefix, id) => `${prefix}-${id}`,
      LIVE_TOOL_CONTENT_POLICY: { toolOutput: 'full', toolContentFieldBytes: 8192, toolContentTurnBytes: 131072 },
      recordingRecoveryHint: '', userDataDir, scopedSessionKey: (id) => id,
      isRemoteRun: false, deleteRunAttachments: () => { },
      sessionBaselineKey: (context, id) => `${context}:${id}`
    })
    expect(state.observedSessionId).toBeUndefined()
    state.observedSessionId = 'native-session-after-start'
    state.emit({
      id: 'result-live-binding', ts: new Date().toISOString(), runId: state.runId,
      kind: 'harness', stage: 'result', providerId: 'claude', runtimeProvider: 'claude_sdk'
    })
    await state.ingestion.idle()
    expect(receipts.appendUsage).toHaveBeenLastCalledWith(
      userDataDir,
      expect.objectContaining({ runId: state.runId, externalSessionId: 'native-session-after-start' }),
      expect.objectContaining({ id: 'result-live-binding' })
    )
  })
})
