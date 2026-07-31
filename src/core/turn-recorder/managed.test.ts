import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { aggregateTurnEvidence } from './aggregate'
import {
  commitManagedRecorderTurn,
  prepareManagedRecorderTurn,
  recoverManagedRecorderTurns
} from './managed'
import { handleRecorderHook } from './recorder'
import { commitRecord, listRecords, readHealth, safeKey, stableHash } from './store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-managed-recorder-test-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'managed-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  return root
}

function canonicalEvidence(userText = '/rate-workflow 1') {
  const events: TraceEvent[] = [
    {
      id: 'assistant',
      ts: '2026-07-29T12:00:05.000Z',
      runId: 'run-1',
      kind: 'model',
      stage: 'text_delta',
      text: '完成'
    },
    {
      id: 'result',
      ts: '2026-07-29T12:00:10.000Z',
      runId: 'run-1',
      kind: 'harness',
      stage: 'result',
      durationMs: 10_000,
      tokensIn: 100,
      tokensOut: 20,
      modelUsage: [{ model: 'gpt-test', inputTokens: 100, outputTokens: 20 }]
    }
  ]
  return aggregateTurnEvidence({ userText, events, source: 'scry_provider_adapter' })
}

const timing = {
  startedAt: '2026-07-29T12:00:00.000Z',
  completedAt: '2026-07-29T12:00:10.000Z',
  durationMs: 10_000
}

async function startManaged(root: string, sessionId = 'session-1'): Promise<void> {
  await handleRecorderHook({
    provider: 'codex',
    event: 'UserPromptSubmit',
    workspace: root,
    managed: true,
    payload: {
      session_id: sessionId,
      turn_id: 'turn-1',
      prompt: '/rate-workflow 1',
      timestamp: timing.startedAt
    }
  })
}

describe('managed canonical recorder', () => {
  it('Codex 非 completed 轮次仍保持 exact assistant 的原有 fail-closed 语义', async () => {
    const root = await workspace()
    await startManaged(root)
    const evidence = aggregateTurnEvidence({
      userText: '/rate-workflow 1',
      events: [{
        id: 'result',
        ts: timing.completedAt,
        runId: 'run-1',
        kind: 'harness',
        stage: 'result',
        durationMs: timing.durationMs
      }],
      source: 'scry_provider_adapter'
    })

    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'failed',
      archiveFingerprint: stableHash({ runId: 'run-1', evidence, timing })
    })).rejects.toThrow('requires non-empty exact assistant evidence')
  })

  it('Qoder hook 未暴露 promptId 时先去重 provisional open，再绑定 App 取得的 native turn ID', async () => {
    const root = await workspace()
    const direct = {
      session_id: 'qoder-session',
      prompt: '/rate-workflow 1\n\n[attachment injected for Provider]',
      timestamp: timing.startedAt
    }
    const bridge = {
      session_id: 'qoder-session',
      prompt: direct.prompt,
      turn_id: 'bridge-envelope-id',
      raw_qoder_payload: direct,
      timestamp: timing.startedAt
    }

    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root, managed: true, payload: direct
    })).resolves.toMatchObject({ status: 'started' })
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root, managed: true, payload: bridge
    })).resolves.toMatchObject({ status: 'duplicate' })

    const evidence = canonicalEvidence()
    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'qoder',
      sessionId: 'qoder-session',
      runId: 'run-qoder',
      providerTurnId: 'native-prompt-id',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint: stableHash({ runId: 'run-qoder', evidence, timing })
    })).resolves.toMatchObject({ status: 'prepared' })

    const open = JSON.parse(await readFile(join(
      root, '.scry', 'runtime', 'qoder', safeKey('qoder-session'), 'open.json'
    ), 'utf8')) as { providerTurnId?: string }
    expect(open.providerTurnId).toBe('native-prompt-id')
  })

  it('pending recovery 按 provider 隔离，不让 Qoder 阻塞 Codex', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'qoder-session',
        promptId: 'qoder-turn',
        prompt: '/rate-workflow 1',
        timestamp: timing.startedAt
      }
    })

    await expect(recoverManagedRecorderTurns(root, process.env, { provider: 'codex' }))
      .resolves.toEqual({ recovered: 0, pending: 0 })
    await expect(recoverManagedRecorderTurns(root, process.env, { provider: 'qoder' }))
      .resolves.toEqual({ recovered: 0, pending: 1 })
  })

  it('App-first 时序先持久化 prepared，archive 确认后才提交同一 evidence', async () => {
    const root = await workspace()
    await startManaged(root)
    const evidence = canonicalEvidence()
    const archiveFingerprint = stableHash({ runId: 'run-1', evidence, timing })
    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })

    expect(prepared).toMatchObject({ status: 'prepared' })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
    expect(await recoverManagedRecorderTurns(root)).toEqual({ recovered: 0, pending: 1 })

    const committed = await commitManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      recordId: prepared.status === 'prepared' ? prepared.recordId : '',
      archiveFingerprint,
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed'
    })
    const [record] = await listRecords(join(root, '.scry'))

    expect(committed.status).toBe('committed')
    expect(record).toMatchObject({
      startedAt: timing.startedAt,
      completedAt: timing.completedAt,
      durationMs: timing.durationMs,
      user: evidence.user,
      assistant: evidence.assistant,
      tools: evidence.tools,
      hooks: evidence.hooks,
      errors: evidence.errors
    })
    expect(record.assistant.value).toEqual({
      text: '完成',
      textHash: `sha256:${createHash('sha256').update('完成').digest('hex')}`
    })
    expect(await readHealth(join(root, '.scry'))).toMatchObject({
      pendingCount: 0,
      oldestPendingAgeMs: 0
    })
  })

  it('Stop-first 只转 pending，canonical commit 仍能闭合', async () => {
    const root = await workspace()
    await startManaged(root)
    await expect(handleRecorderHook({
      provider: 'codex',
      event: 'Stop',
      workspace: root,
      payload: { session_id: 'session-1', turn_id: 'turn-1', timestamp: timing.completedAt }
    })).resolves.toMatchObject({ status: 'pending' })
    expect(await recoverManagedRecorderTurns(root, process.env, { sessionId: 'session-1' }))
      .toEqual({ recovered: 0, pending: 1 })
    expect(await recoverManagedRecorderTurns(root, process.env, { sessionId: 'other-session' }))
      .toEqual({ recovered: 0, pending: 0 })

    const evidence = canonicalEvidence()
    const archiveFingerprint = stableHash({ runId: 'run-1', evidence, timing })
    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })
    expect(prepared.status).toBe('prepared')
    if (prepared.status !== 'prepared') return
    await commitManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      recordId: prepared.recordId,
      archiveFingerprint,
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed'
    })

    expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
  })

  it('通用 recovery 只重放 archive_committed，不提交 prepared', async () => {
    const root = await workspace()
    await startManaged(root)
    const evidence = canonicalEvidence()
    const archiveFingerprint = stableHash({ runId: 'run-1', evidence, timing })
    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })
    expect(prepared.status).toBe('prepared')
    expect(await recoverManagedRecorderTurns(root)).toEqual({ recovered: 0, pending: 1 })

    const canonical = join(
      root,
      '.scry',
      'runtime',
      'codex',
      safeKey('session-1'),
      'turns',
      '00000001',
      'canonical.json'
    )
    const handoff = JSON.parse(await readFile(canonical, 'utf8')) as Record<string, unknown>
    await writeFile(canonical, JSON.stringify({ ...handoff, phase: 'archive_committed' }))

    expect(await recoverManagedRecorderTurns(root)).toEqual({ recovered: 1, pending: 0 })
    expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
  })

  it('record rename 后崩溃也会在 duplicate recovery 中清理 runtime', async () => {
    const root = await workspace()
    await startManaged(root)
    const evidence = canonicalEvidence()
    const archiveFingerprint = stableHash({ runId: 'run-1', evidence, timing })
    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })
    expect(prepared.status).toBe('prepared')
    if (prepared.status !== 'prepared') return
    const runtimeRoot = join(root, '.scry', 'runtime', 'codex', safeKey('session-1'))
    const canonical = join(runtimeRoot, 'turns', '00000001', 'canonical.json')
    const handoff = JSON.parse(await readFile(canonical, 'utf8')) as {
      record: Parameters<typeof commitRecord>[1]
    }
    await commitRecord(join(root, '.scry'), handoff.record)

    await expect(commitManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      recordId: prepared.recordId,
      archiveFingerprint,
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed'
    })).resolves.toMatchObject({ status: 'duplicate' })

    await expect(readFile(join(runtimeRoot, 'open.json'))).rejects.toThrow()
    await expect(readFile(canonical)).rejects.toThrow()
    expect(await recoverManagedRecorderTurns(root)).toEqual({ recovered: 0, pending: 0 })
  })

  it('相同 recordId 的错误旧记录不会被 duplicate 路径接受', async () => {
    const root = await workspace()
    await startManaged(root)
    const evidence = canonicalEvidence()
    const archiveFingerprint = stableHash({ runId: 'run-1', evidence, timing })
    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })
    expect(prepared.status).toBe('prepared')
    if (prepared.status !== 'prepared') return

    const runtimeRoot = join(root, '.scry', 'runtime', 'codex', safeKey('session-1'))
    const canonical = join(runtimeRoot, 'turns', '00000001', 'canonical.json')
    const handoff = JSON.parse(await readFile(canonical, 'utf8')) as {
      record: Parameters<typeof commitRecord>[1]
    }
    const wrongText = '错误旧输出'
    await commitRecord(join(root, '.scry'), {
      ...handoff.record,
      assistant: {
        ...handoff.record.assistant,
        value: {
          text: wrongText,
          textHash: `sha256:${createHash('sha256').update(wrongText).digest('hex')}`
        }
      }
    })

    await expect(commitManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      recordId: prepared.recordId,
      archiveFingerprint,
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed'
    })).rejects.toThrow('duplicate record differs')

    await expect(readFile(join(runtimeRoot, 'open.json'))).resolves.toBeTruthy()
    await expect(readFile(canonical)).resolves.toBeTruthy()
  })

  it('legacy quarantine 与 managed open 使用同一 pending 口径', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: {
        session_id: 'session-1',
        turn_id: 'legacy-turn',
        prompt: 'legacy',
        timestamp: timing.startedAt
      }
    })
    await startManaged(root)

    expect(await recoverManagedRecorderTurns(root)).toEqual({ recovered: 0, pending: 2 })
    expect(await readHealth(join(root, '.scry'))).toMatchObject({
      pendingCount: 2
    })
  })

  it('异常的下一次 managed start 不会把上一轮 pending 隐藏掉', async () => {
    const root = await workspace()
    await startManaged(root)
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'session-1',
        turn_id: 'turn-2',
        prompt: 'next',
        timestamp: '2026-07-29T12:00:11.000Z'
      }
    })

    expect(await recoverManagedRecorderTurns(root, process.env, { sessionId: 'session-1' }))
      .toEqual({ recovered: 0, pending: 2 })
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ pendingCount: 2 })

    const evidence = canonicalEvidence()
    const archiveFingerprint = stableHash({ runId: 'run-1', evidence, timing })
    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })
    expect(prepared.status).toBe('prepared')
    if (prepared.status !== 'prepared') return
    await commitManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId: 'run-1',
      recordId: prepared.recordId,
      archiveFingerprint,
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed'
    })

    expect(await recoverManagedRecorderTurns(root, process.env, { sessionId: 'session-1' }))
      .toEqual({ recovered: 0, pending: 1 })
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ pendingCount: 1 })
  })
})
