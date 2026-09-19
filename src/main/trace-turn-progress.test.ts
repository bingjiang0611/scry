import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deleteTraceTurnProgressArtifacts,
  persistTraceTurnProgress,
  persistUnresolvedTraceTurnProgress,
  recoverTraceTurnProgress,
  traceProgressSessionRunIds
} from './trace-turn-progress'
import { mergeSessionTurns } from './session-history'
import { readTraceArchive, upsertTraceArchiveTurn } from './transcript-archive'

const roots: string[] = []
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), 'scry-trace-progress-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('trace turn progress', () => {
  it('recovers a non-managed terminal turn after a crash before final archive', async () => {
    const userDataDir = root()
    await persistTraceTurnProgress({
      userDataDir,
      cwd: '/repo',
      sessionId: 'session-1',
      providerId: 'opencode',
      runtimeProvider: 'opencode_server',
      turn: { runId: 'run-1', userText: 'hello', items: [], done: true, status: 'failed', ts: 1 }
    })
    expect(traceProgressSessionRunIds(userDataDir, {
      cwd: '/repo', sessionId: 'session-1', providerId: 'opencode'
    })).toEqual(['run-1'])
    await expect(recoverTraceTurnProgress(userDataDir, {
      cwd: '/repo', sessionId: 'session-1', providerId: 'opencode'
    })).resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
    expect(readTraceArchive({
      cwd: '/repo', sessionId: 'session-1', providerId: 'opencode', userDataDir
    })?.turns).toEqual([expect.objectContaining({ runId: 'run-1', status: 'failed' })])
    await expect(recoverTraceTurnProgress(userDataDir)).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
  })

  it('不绑定项目的 terminal progress 也能恢复为 archive', async () => {
    const userDataDir = root()
    await persistTraceTurnProgress({
      userDataDir,
      cwd: '',
      sessionId: 'session-unbound',
      providerId: 'qoder',
      runtimeProvider: 'qoder_cli',
      turn: { runId: 'run-unbound', userText: 'hello', items: [], done: true, status: 'completed', ts: 1 }
    })

    await expect(recoverTraceTurnProgress(userDataDir, {
      cwd: '', sessionId: 'session-unbound', providerId: 'qoder'
    })).resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
    expect(readTraceArchive({
      cwd: '', sessionId: 'session-unbound', providerId: 'qoder', userDataDir
    })?.turns[0]).toMatchObject({ runId: 'run-unbound', status: 'completed' })
  })

  it('deletion removes a pending non-managed progress snapshot', async () => {
    const userDataDir = root()
    await persistTraceTurnProgress({
      userDataDir,
      cwd: '/repo',
      sessionId: 'session-1',
      providerId: 'claude',
      runtimeProvider: 'claude_sdk',
      turn: { runId: 'run-delete', userText: 'secret', items: [], done: true, status: 'failed', ts: 1 }
    })
    expect(deleteTraceTurnProgressArtifacts(userDataDir, new Set(['run-delete']))).toEqual({ failed: [] })
    expect(existsSync(join(userDataDir, 'trace-turn-progress'))).toBe(true)
    await expect(recoverTraceTurnProgress(userDataDir)).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
  })

  it('retains a managed terminal turn without native session id as scoped unresolved evidence', async () => {
    const userDataDir = root()
    await persistUnresolvedTraceTurnProgress({
      userDataDir,
      cwd: '/repo',
      providerId: 'claude',
      runtimeProvider: 'claude_sdk',
      // Provider 已经产出过内容（有 provider turn 边界与 model 事件）却丢了 session id：
      // 这是真正需要 fail closed 的 adapter 缺陷，证据必须保留为 pending。
      turn: {
        runId: 'run-missing-session',
        providerTurnId: 'provider-turn-1',
        userText: 'same prompt',
        items: [{ id: 'model', ts: '2026-08-01T00:00:00.000Z', runId: 'run-missing-session', kind: 'model', stage: 'text_delta', text: 'partial' }],
        done: true,
        status: 'failed',
        ts: 1
      },
      reason: 'missing_provider_session_id'
    })

    await expect(recoverTraceTurnProgress(userDataDir, { cwd: '/other' }))
      .resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
    await expect(recoverTraceTurnProgress(userDataDir, { cwd: '/repo', providerId: 'claude' }))
      .resolves.toEqual({
        recovered: 0,
        pending: 1,
        errors: ['unresolved trace turn progress (missing_provider_session_id): run-missing-session']
      })
    expect(deleteTraceTurnProgressArtifacts(userDataDir, new Set(['run-missing-session']))).toEqual({ failed: [] })
    await expect(recoverTraceTurnProgress(userDataDir)).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
  })

  it('clears unresolved evidence for a runtime-stage failure that produced no Provider evidence', async () => {
    const userDataDir = root()
    // 真实现场：pinned recorder CLI 版本不符在 runtime 阶段报错，Provider 根本没启动，
    // 只留下 harness 的 controls/result。旧行为会把它卡成永久 pending，该工作区再也发不出去。
    await persistUnresolvedTraceTurnProgress({
      userDataDir,
      cwd: '/repo',
      providerId: 'qoder',
      runtimeProvider: 'qoder_cli',
      turn: {
        runId: 'run-version-gate',
        userText: 'hello',
        items: [
          { id: 'controls', ts: '2026-08-01T00:00:00.000Z', runId: 'run-version-gate', kind: 'harness', stage: 'runtime:controls' },
          {
            id: 'result',
            ts: '2026-08-01T00:00:01.000Z',
            runId: 'run-version-gate',
            kind: 'harness',
            stage: 'result',
            isError: true,
            runtimeFailureStage: 'runtime'
          }
        ],
        done: true,
        status: 'failed',
        ts: 1
      },
      reason: 'missing_provider_session_id'
    })

    await expect(recoverTraceTurnProgress(userDataDir, { cwd: '/repo', providerId: 'qoder' }))
      .resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
    await expect(recoverTraceTurnProgress(userDataDir)).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
  })

  it('clears legacy unresolved evidence for a failure before Provider startup', async () => {
    const userDataDir = root()
    await persistUnresolvedTraceTurnProgress({
      userDataDir,
      cwd: '/repo',
      providerId: 'pi',
      runtimeProvider: 'pi_rpc',
      turn: {
        runId: 'run-frontdoor',
        userText: 'hello',
        items: [{
          id: 'result',
          ts: '2026-08-01T00:00:00.000Z',
          runId: 'run-frontdoor',
          kind: 'harness',
          stage: 'result',
          isError: true,
          runtimeFailureStage: 'frontdoor'
        }],
        done: true,
        status: 'failed',
        ts: 1
      },
      reason: 'missing_provider_session_id'
    })

    await expect(recoverTraceTurnProgress(userDataDir, { cwd: '/repo', providerId: 'pi' }))
      .resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
    await expect(recoverTraceTurnProgress(userDataDir)).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
  })

  it('keeps a session-bearing Pi pre-turn failure readable in the local archive', async () => {
    const userDataDir = root()
    await persistTraceTurnProgress({
      userDataDir,
      cwd: '/repo',
      sessionId: 'pi-session-before-turn',
      providerId: 'pi',
      runtimeProvider: 'pi_rpc',
      turn: {
        runId: 'run-pi-preflight',
        userText: '/skill:test diagnose this',
        items: [{
          id: 'result',
          ts: '2026-08-01T00:00:01.000Z',
          runId: 'run-pi-preflight',
          kind: 'harness',
          stage: 'result',
          text: 'prompt preflight failed',
          isError: true,
          runtimeFailureStage: 'runtime'
        }],
        done: true,
        status: 'failed',
        error: 'prompt preflight failed',
        ts: 1
      }
    })

    await expect(recoverTraceTurnProgress(userDataDir, { cwd: '/repo', providerId: 'pi' }))
      .resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
    const archive = readTraceArchive({
      cwd: '/repo', sessionId: 'pi-session-before-turn', providerId: 'pi', userDataDir
    })
    expect(archive?.turns).toEqual([
      expect.objectContaining({
        runId: 'run-pi-preflight',
        userText: '/skill:test diagnose this',
        status: 'failed',
        error: 'prompt preflight failed'
      })
    ])
    expect(mergeSessionTurns([], archive)[0]).toMatchObject({
      runId: 'run-pi-preflight',
      userText: '/skill:test diagnose this',
      error: 'prompt preflight failed'
    })
  })

  it('never overwrites a richer committed archive with a stale pre-diff snapshot', async () => {
    const userDataDir = root()
    const base = {
      runId: 'run-rich',
      userText: 'hello',
      items: [{ id: 'model', ts: '2026-08-01T00:00:00.000Z', runId: 'run-rich', kind: 'model' as const, stage: 'text_delta', text: 'done' }],
      done: true,
      status: 'completed' as const,
      ts: 1
    }
    await persistTraceTurnProgress({
      userDataDir,
      cwd: '/repo',
      sessionId: 'session-rich',
      providerId: 'claude',
      runtimeProvider: 'claude_sdk',
      turn: base
    })
    const diff = {
      id: 'diff',
      ts: '2026-08-01T00:00:01.000Z',
      runId: 'run-rich',
      kind: 'harness' as const,
      stage: 'turn_diff',
      turnDiff: {
        version: 1 as const,
        beforeAt: '2026-08-01T00:00:00.000Z',
        afterAt: '2026-08-01T00:00:01.000Z',
        captureMs: 1,
        status: 'captured' as const,
        cleanup: 'ok' as const,
        files: []
      }
    }
    expect(upsertTraceArchiveTurn({
      cwd: '/repo',
      sessionId: 'session-rich',
      providerId: 'claude',
      runtimeProvider: 'claude_sdk',
      userDataDir,
      turn: { ...base, ts: 2, items: [...base.items, diff] }
    })).toBe(true)

    await expect(recoverTraceTurnProgress(userDataDir)).resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
    expect(readTraceArchive({
      cwd: '/repo', sessionId: 'session-rich', providerId: 'claude', userDataDir
    })?.turns[0].items).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'turn_diff' })]))
  })

  it('keeps malformed progress pending instead of deleting the only recovery evidence', async () => {
    const userDataDir = root()
    const progressRoot = join(userDataDir, 'trace-turn-progress')
    const malformed = join(progressRoot, 'malformed.json')
    mkdirSync(progressRoot, { recursive: true })
    writeFileSync(malformed, JSON.stringify({
      schemaVersion: 1,
      persistedAt: '2026-08-01T00:00:00.000Z',
      request: { cwd: '/repo', sessionId: 'session-1', providerId: 'claude', runtimeProvider: 'claude_sdk', turn: { runId: 'run-bad' } }
    }))
    await expect(recoverTraceTurnProgress(userDataDir)).resolves.toEqual({
      recovered: 0,
      pending: 1,
      errors: ['invalid trace turn progress: malformed.json']
    })
    await expect(recoverTraceTurnProgress(userDataDir, { cwd: '/another-repo' })).resolves.toEqual({
      recovered: 0,
      pending: 0,
      errors: []
    })
    await expect(recoverTraceTurnProgress(userDataDir, { cwd: '/repo' })).resolves.toEqual({
      recovered: 0,
      pending: 1,
      errors: ['invalid trace turn progress: malformed.json']
    })
    expect(existsSync(malformed)).toBe(true)
  })
})
