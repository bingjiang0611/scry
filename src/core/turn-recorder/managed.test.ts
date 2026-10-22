import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { aggregateTurnEvidence } from './aggregate'
import {
  cancelManagedRecorderTurn,
  commitManagedRecorderTurn,
  isManagedProviderRuntimePair,
  isManagedRecorderProvider,
  prepareManagedRecorderTurn,
  recoverManagedRecorderTurns
} from './managed'
import { handleRecorderHook } from './recorder'
import { recorderHasOpenTurn, recorderPendingHealth } from './runtime-state'
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
  it('commits root prompt and supplementary admission outcomes together without creating another recorder turn', async () => {
    const root = await workspace()
    await startManaged(root)
    const user = aggregateTurnEvidence({ userText: '/rate-workflow 1', source: 'scry_provider_adapter', events: [
      { id: 'steer-accepted', ts: '2026-07-29T12:00:04.000Z', runId: 'run-1', kind: 'human', stage: 'steer', steer: { messageId: 'message-1', prompt: '补充要求', attachments: [], status: 'accepted', providerTurnId: 'turn-1' } },
      { id: 'steer-unknown', ts: '2026-07-29T12:00:06.000Z', runId: 'run-1', kind: 'human', stage: 'steer', steer: { messageId: 'message-2', prompt: '不自动重发', attachments: [], status: 'unknown', message: 'response unconfirmed' } }
    ] }).user
    const evidence = { ...canonicalEvidence(), user }
    const archiveFingerprint = stableHash({ evidence, timing })
    const prepared = await prepareManagedRecorderTurn({ workspace: root, provider: 'codex', sessionId: 'session-1', runId: 'run-1', providerTurnId: 'turn-1', userText: '/rate-workflow 1', evidence, timing, status: 'completed', archiveFingerprint })
    expect(prepared.status).toBe('prepared')
    if (prepared.status !== 'prepared') throw new Error('expected canonical handoff')
    await expect(commitManagedRecorderTurn({ workspace: root, provider: 'codex', sessionId: 'session-1', runId: 'run-1', recordId: prepared.recordId, providerTurnId: 'turn-1', userText: '/rate-workflow 1', evidence, timing, status: 'completed', archiveFingerprint })).resolves.toMatchObject({ status: 'committed' })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].user.value).toMatchObject({ text: '/rate-workflow 1', steers: [
      { messageId: 'message-1', prompt: '补充要求', status: 'accepted' },
      { messageId: 'message-2', prompt: '不自动重发', status: 'unknown' }
    ] })
    expect(records[0].usage.value).toMatchObject({ inputTokens: 100, outputTokens: 20 })
  })

  it('includes Claude in the managed recorder provider set', () => {
    expect(isManagedRecorderProvider('claude')).toBe(true)
  })

  it('includes OpenCode in the managed recorder provider set', () => {
    expect(isManagedRecorderProvider('opencode')).toBe(true)
  })

  it('includes Pi and accepts only its pi_rpc runtime pair', () => {
    expect(isManagedRecorderProvider('pi')).toBe(true)
    expect(isManagedProviderRuntimePair('pi', 'pi_rpc')).toBe(true)
    expect(isManagedProviderRuntimePair('pi', 'codex_cli')).toBe(false)
  })

  it('Pi 用受信 managed 身份把 provisional lifecycle 绑定到 session entry id', async () => {
    const root = await workspace()
    const runId = 'run-pi'
    const prompt = '/skill:rate-workflow 85781174 理解prd后停下'
    const evidence = canonicalEvidence(prompt)
    const archiveFingerprint = stableHash({ runId, evidence, timing })
    await handleRecorderHook({
      provider: 'pi',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'pi-session',
        prompt,
        timestamp: timing.startedAt
      },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: runId,
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex')
      }
    })

    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'pi',
      sessionId: 'pi-session',
      runId,
      providerTurnId: 'pi-user-entry-1',
      userText: prompt,
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })
    expect(prepared).toMatchObject({ status: 'prepared' })
    if (prepared.status !== 'prepared') return

    await expect(commitManagedRecorderTurn({
      workspace: root,
      provider: 'pi',
      sessionId: 'pi-session',
      runId,
      recordId: prepared.recordId,
      archiveFingerprint,
      providerTurnId: 'pi-user-entry-1',
      userText: prompt,
      evidence,
      timing,
      status: 'completed'
    })).resolves.toMatchObject({ status: 'committed' })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([
      expect.objectContaining({
        provider: expect.objectContaining({ id: 'pi' }),
        providerTurnId: 'pi-user-entry-1'
      })
    ])
  })

  it('Pi 附件-only 轮次允许精确的空文本证据', async () => {
    const root = await workspace()
    const runId = 'run-pi-attachment-only'
    const evidence = canonicalEvidence('')
    const archiveFingerprint = stableHash({ runId, evidence, timing })
    await handleRecorderHook({
      provider: 'pi',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'pi-session-attachment-only',
        prompt: '',
        timestamp: timing.startedAt
      },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: runId,
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update('').digest('hex')
      }
    })

    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'pi',
      sessionId: 'pi-session-attachment-only',
      runId,
      providerTurnId: 'pi-user-entry-attachment-only',
      userText: '',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })).resolves.toMatchObject({ status: 'prepared' })
  })

  it('Pi 不允许缺失 authoritative session entry id', async () => {
    const root = await workspace()
    const prompt = '/skill:rate-workflow 85781174 理解prd后停下'
    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'pi',
      sessionId: 'pi-session',
      runId: 'run-pi-missing-id',
      userText: prompt,
      evidence: canonicalEvidence(prompt),
      timing,
      status: 'interrupted',
      archiveFingerprint: 'fixture'
    })).rejects.toThrow('authoritative Provider turn id')
  })

  it('Pi interrupted turn accepts missing assistant text but keeps the entry id mandatory', async () => {
    const root = await workspace()
    const runId = 'run-pi-interrupted'
    const prompt = '停止当前任务'
    const evidence = aggregateTurnEvidence({ userText: prompt, events: [], source: 'scry_provider_adapter' })
    const archiveFingerprint = stableHash({ runId, evidence, timing })
    await handleRecorderHook({
      provider: 'pi',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: { session_id: 'pi-session-interrupted', prompt, timestamp: timing.startedAt },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: runId,
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex')
      }
    })

    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'pi',
      sessionId: 'pi-session-interrupted',
      runId,
      providerTurnId: 'pi-user-entry-interrupted',
      userText: prompt,
      evidence,
      timing,
      status: 'interrupted',
      archiveFingerprint
    })).resolves.toMatchObject({ status: 'prepared' })
  })

  it('default managed recovery scans pending Pi lifecycles', async () => {
    const root = await workspace()
    const prompt = '恢复 Pi 轮次'
    await handleRecorderHook({
      provider: 'pi',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: { session_id: 'pi-session-recovery', prompt, timestamp: timing.startedAt },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: 'run-pi-recovery',
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex')
      }
    })

    await expect(recoverManagedRecorderTurns(root)).resolves.toEqual({ recovered: 0, pending: 1 })
  })

  it.each([false, true])('workspace recovery leaves a live Pi turn untouched (native identity: %s)', async (hasNativeIdentity) => {
    const root = await workspace()
    const sessionId = 'pi-session-live'
    const runId = 'run-pi-live'
    const prompt = '另一会话仍在执行'
    await handleRecorderHook({
      provider: 'pi',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: { session_id: sessionId, prompt, timestamp: timing.startedAt },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: runId,
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex')
      }
    })
    const openPath = join(root, '.scry', 'runtime', 'pi', safeKey(sessionId), 'open.json')
    if (hasNativeIdentity) {
      const open = JSON.parse(await readFile(openPath, 'utf8'))
      await writeFile(openPath, JSON.stringify({ ...open, providerTurnId: 'pi-live-entry' }))
    }
    const before = await readFile(openPath, 'utf8')

    await expect(recoverManagedRecorderTurns(root, process.env, {
      provider: 'pi',
      isLiveManagedRun: (candidate) => candidate === runId
    })).resolves.toEqual({ recovered: 0, pending: 0 })
    expect(await readFile(openPath, 'utf8')).toBe(before)
    // Unknown ownership is still fail closed; this is not permission to discard the turn.
    await expect(recoverManagedRecorderTurns(root, process.env, { provider: 'pi' }))
      .resolves.toEqual({ recovered: 0, pending: 1 })
  })

  // 真实故障：Provider 进程早已消失，open/quarantined 轮次没有 providerTurnId 也没有 canonical handoff，
  // 永远不会自己收口，却让 agent:start 永久报“精确记录仍有 N 轮待恢复”。
  it('主已不在的 provisional 轮次在授权后被弃掉，不再永久阻断', async () => {
    const root = await workspace()
    const prompt = '孤儿 provisional 轮次'
    await handleRecorderHook({
      provider: 'pi',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: { session_id: 'pi-session-orphan', prompt, timestamp: timing.startedAt },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: 'run-pi-orphan',
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex')
      }
    })

    // 默认保守：不知道 run 存活情况时继续 pending，不得删掉可能正在跑的轮次。
    await expect(recoverManagedRecorderTurns(root)).resolves.toEqual({ recovered: 0, pending: 1 })
    // run 还活着时不需要恢复，也不能弃掉。
    await expect(recoverManagedRecorderTurns(root, process.env, {
      abandonProvisional: true,
      isLiveManagedRun: (candidate) => candidate === 'run-pi-orphan'
    })).resolves.toEqual({ recovered: 0, pending: 0 })
    // 主已不在：弃掉并计入 recovered，再扫一次已经干净。
    await expect(recoverManagedRecorderTurns(root, process.env, {
      abandonProvisional: true,
      isLiveManagedRun: () => false
    })).resolves.toEqual({ recovered: 1, pending: 0 })
    await expect(recoverManagedRecorderTurns(root)).resolves.toEqual({ recovered: 0, pending: 0 })
    await expect(recorderHasOpenTurn(join(root, '.scry'))).resolves.toBe(false)
  })

  it('已观测到 Provider turn 证据的轮次不会被弃掉，仍然 fail closed', async () => {
    const root = await workspace()
    const prompt = '已有 Provider 证据的轮次'
    const sessionId = 'pi-session-evidence'
    await handleRecorderHook({
      provider: 'pi',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: { session_id: sessionId, prompt, timestamp: timing.startedAt },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: 'run-pi-evidence',
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex')
      }
    })
    const openPath = join(root, '.scry', 'runtime', 'pi', safeKey(sessionId), 'open.json')
    const open = JSON.parse(await readFile(openPath, 'utf8'))
    await writeFile(openPath, JSON.stringify({ ...open, providerTurnId: 'pi-user-entry-evidence' }))

    await expect(recoverManagedRecorderTurns(root, process.env, {
      abandonProvisional: true,
      isLiveManagedRun: () => false
    })).resolves.toEqual({ recovered: 0, pending: 1 })
    await expect(recorderHasOpenTurn(join(root, '.scry'))).resolves.toBe(true)
  })

  it('Pi prompt preflight rejection cancels only the exact provisional managed lifecycle', async () => {
    const root = await workspace()
    const runId = 'run-pi-preflight-rejected'
    const prompt = '/skill:rate-workflow 85781174 理解prd后停下'
    const promptHash = createHash('sha256').update(prompt).digest('hex')
    await handleRecorderHook({
      provider: 'pi',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: { session_id: 'pi-session-rejected', prompt, timestamp: timing.startedAt },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: runId,
        SCRY_MANAGED_PROMPT_HASH: promptHash
      }
    })

    await expect(recorderHasOpenTurn(join(root, '.scry'))).resolves.toBe(true)
    await expect(recorderPendingHealth(join(root, '.scry'))).resolves.toMatchObject({ pendingCount: 1 })
    await expect(cancelManagedRecorderTurn({
      workspace: root,
      provider: 'pi',
      sessionId: 'pi-session-rejected',
      runId: 'other-run',
      promptHash
    })).rejects.toThrow('identity differs')
    await expect(cancelManagedRecorderTurn({
      workspace: root,
      provider: 'pi',
      sessionId: 'pi-session-rejected',
      runId,
      promptHash
    })).resolves.toMatchObject({ status: 'cancelled', generation: 1 })
    await expect(recorderHasOpenTurn(join(root, '.scry'))).resolves.toBe(false)
    await expect(recorderPendingHealth(join(root, '.scry'))).resolves.toMatchObject({ pendingCount: 0 })
    await expect(recoverManagedRecorderTurns(root)).resolves.toEqual({ recovered: 0, pending: 0 })
    await expect(cancelManagedRecorderTurn({
      workspace: root,
      provider: 'pi',
      sessionId: 'pi-session-rejected',
      runId,
      promptHash
    })).resolves.toEqual({ status: 'not_found' })
  })

  it('OpenCode 用受信 managed 身份绑定 parent user ID 后准备并提交', async () => {
    const root = await workspace()
    const runId = 'run-opencode'
    const evidence = canonicalEvidence()
    const archiveFingerprint = stableHash({ runId, evidence, timing })
    await handleRecorderHook({
      provider: 'opencode',
      event: 'chat.message',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'opencode-session',
        prompt: '/expanded project command body',
        timestamp: timing.startedAt
      },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: runId,
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update('/rate-workflow 1').digest('hex')
      }
    })
    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'opencode',
      sessionId: 'opencode-session',
      runId,
      providerTurnId: 'parent-user-id',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })

    expect(prepared).toMatchObject({ status: 'prepared' })
    if (prepared.status !== 'prepared') return
    await expect(commitManagedRecorderTurn({
      workspace: root,
      provider: 'opencode',
      sessionId: 'opencode-session',
      runId,
      recordId: prepared.recordId,
      archiveFingerprint,
      providerTurnId: 'parent-user-id',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed'
    })).resolves.toMatchObject({ status: 'committed' })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record).toMatchObject({
      provider: { id: 'opencode' },
      providerTurnId: 'parent-user-id',
      status: 'completed'
    })
  })

  it.each(['failed', 'interrupted'] as const)('OpenCode %s 允许无 Provider turn id', async (status) => {
    const root = await workspace()
    const runId = `run-opencode-${status}`
    await handleRecorderHook({
      provider: 'opencode',
      event: 'chat.message',
      workspace: root,
      managed: true,
      payload: { session_id: 'opencode-session', prompt: '/rate-workflow 1', timestamp: timing.startedAt },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: runId,
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update('/rate-workflow 1').digest('hex')
      }
    })
    const evidence = aggregateTurnEvidence({ userText: '/rate-workflow 1', events: [], source: 'scry_provider_adapter' })

    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'opencode',
      sessionId: 'opencode-session',
      runId,
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status,
      archiveFingerprint: stableHash({ runId, evidence, timing })
    })).resolves.toMatchObject({ status: 'prepared' })
  })

  it('OpenCode completed 拒绝缺少 Provider turn id', async () => {
    const root = await workspace()
    const runId = 'run-opencode-completed-without-id'
    await handleRecorderHook({
      provider: 'opencode',
      event: 'chat.message',
      workspace: root,
      managed: true,
      payload: { session_id: 'opencode-session', prompt: '/rate-workflow 1', timestamp: timing.startedAt },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: runId,
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update('/rate-workflow 1').digest('hex')
      }
    })
    const evidence = canonicalEvidence()

    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'opencode',
      sessionId: 'opencode-session',
      runId,
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint: stableHash({ runId, evidence, timing })
    })).rejects.toThrow('requires an authoritative Provider turn id')
  })

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

  it('Claude 非 completed 轮次允许没有 assistant，并按 native root turn id 准备 canonical handoff', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'claude-session',
        turn_id: 'claude-root-turn',
        prompt: '/rate-workflow 1',
        timestamp: timing.startedAt
      }
    })
    await expect(handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'claude-session',
        turn_id: 'background-notification',
        prompt: '<task-notification>background agent finished</task-notification>',
        origin: { kind: 'task-notification' },
        timestamp: timing.startedAt
      }
    })).resolves.toMatchObject({
      status: 'recorded',
      reason: 'managed task continuation kept in canonical Scry turn'
    })
    const evidence = aggregateTurnEvidence({
      userText: '/rate-workflow 1',
      events: [{
        id: 'failed-result',
        ts: timing.completedAt,
        runId: 'run-claude',
        kind: 'harness',
        stage: 'result',
        durationMs: timing.durationMs,
        isError: true,
        text: 'interrupted'
      }],
      source: 'scry_provider_adapter'
    })

    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'claude',
      sessionId: 'claude-session',
      runId: 'run-claude',
      providerTurnId: 'claude-root-turn',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'interrupted',
      archiveFingerprint: stableHash({ runId: 'run-claude', evidence, timing })
    })).resolves.toMatchObject({ status: 'prepared' })
  })

  it('Claude hook 未暴露 turn id 时按 managed run 与 prompt hash 绑定 transcript promptId', async () => {
    const root = await workspace()
    const env = {
      ...process.env,
      SCRY_MANAGED_RUN_ID: 'run-claude-provisional',
      SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update('/rate-workflow 1').digest('hex')
    }
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'claude-provisional-session',
        prompt: '/rate-workflow 1',
        timestamp: timing.startedAt
      },
      env
    })

    const evidence = canonicalEvidence()
    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'claude',
      sessionId: 'claude-provisional-session',
      runId: 'run-claude-provisional',
      providerTurnId: 'transcript-prompt-id',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint: stableHash({ runId: 'run-claude-provisional', evidence, timing }),
      env
    })).resolves.toMatchObject({ status: 'prepared' })

    const open = JSON.parse(await readFile(join(
      root, '.scry', 'runtime', 'claude', safeKey('claude-provisional-session'), 'open.json'
    ), 'utf8')) as { providerTurnId?: string }
    expect(open.providerTurnId).toBe('transcript-prompt-id')
  })

  it('default recovery includes pending Claude managed turns', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'claude-session',
        turn_id: 'claude-root-turn',
        prompt: '/rate-workflow 1',
        timestamp: timing.startedAt
      }
    })

    await expect(recoverManagedRecorderTurns(root)).resolves.toEqual({ recovered: 0, pending: 1 })
  })

  it('Qoder hook 未暴露 promptId 时先去重 provisional open，再绑定 App 取得的 native turn ID', async () => {
    const root = await workspace()
    const managedPromptHash = createHash('sha256').update('/rate-workflow 1').digest('hex')
    const env = {
      ...process.env,
      SCRY_MANAGED_RUN_ID: 'run-qoder',
      SCRY_MANAGED_PROMPT_HASH: managedPromptHash
    }
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
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root, managed: true, payload: direct, env
    })).resolves.toMatchObject({ status: 'started' })
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root, managed: true, payload: bridge, env
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

  it('Qoder 极早中断可用唯一 managed provisional open 准备并提交无 Provider turn id 的记录', async () => {
    const root = await workspace()
    const env = {
      ...process.env,
      SCRY_MANAGED_RUN_ID: 'run-qoder-interrupted',
      SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update('/rate-workflow 1').digest('hex')
    }
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'qoder-session',
        prompt: '/expanded project command body',
        timestamp: timing.startedAt
      },
      env
    })
    const evidence = aggregateTurnEvidence({
      userText: '/rate-workflow 1',
      events: [],
      source: 'scry_provider_adapter'
    })
    const archiveFingerprint = stableHash({ runId: 'run-qoder-interrupted', evidence, timing })
    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'qoder',
      sessionId: 'qoder-session',
      runId: 'run-qoder-interrupted',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'interrupted',
      archiveFingerprint
    })

    expect(prepared).toMatchObject({ status: 'prepared' })
    if (prepared.status !== 'prepared') return
    const committed = await commitManagedRecorderTurn({
      workspace: root,
      provider: 'qoder',
      sessionId: 'qoder-session',
      runId: 'run-qoder-interrupted',
      recordId: prepared.recordId,
      archiveFingerprint,
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'interrupted'
    })
    const [record] = await listRecords(join(root, '.scry'))

    expect(committed.status).toBe('committed')
    expect(record).toMatchObject({ provider: { id: 'qoder' }, status: 'interrupted' })
    expect(record.providerTurnId).toBeUndefined()
  })

  it('Qoder 无 Provider turn id 时拒绝多个 managed provisional open', async () => {
    const root = await workspace()
    const env = {
      ...process.env,
      SCRY_MANAGED_RUN_ID: 'run-qoder-ambiguous',
      SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update('second').digest('hex')
    }
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: { session_id: 'qoder-session', prompt: 'expanded first', timestamp: timing.startedAt },
      env
    })
    const runtimeRoot = join(root, '.scry', 'runtime', 'qoder', safeKey('qoder-session'))
    const first = JSON.parse(await readFile(join(runtimeRoot, 'open.json'), 'utf8')) as Record<string, unknown>
    const pending = join(runtimeRoot, 'turns', '00000002', 'pending-open.json')
    await mkdir(join(pending, '..'), { recursive: true })
    await writeFile(pending, JSON.stringify({
      ...first,
      generation: 2,
      turnIndex: 2,
      prompt: 'expanded second'
    }))
    const evidence = aggregateTurnEvidence({ userText: 'second', events: [], source: 'scry_provider_adapter' })

    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'qoder',
      sessionId: 'qoder-session',
      runId: 'run-qoder-ambiguous',
      userText: 'second',
      evidence,
      timing,
      status: 'interrupted',
      archiveFingerprint: stableHash({ runId: 'run-qoder-ambiguous', evidence, timing })
    })).rejects.toThrow('Provider turn id differs from the open lifecycle identity')
  })

  it('Qoder 无 Provider turn id 时拒绝唯一但 prompt 不匹配的 provisional open', async () => {
    const root = await workspace()
    const env = {
      ...process.env,
      SCRY_MANAGED_RUN_ID: 'run-qoder-wrong-prompt',
      SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update('stale prompt').digest('hex')
    }
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'qoder-session',
        prompt: 'new prompt',
        timestamp: timing.startedAt
      },
      env
    })
    const evidence = aggregateTurnEvidence({ userText: 'new prompt', events: [], source: 'scry_provider_adapter' })

    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'qoder',
      sessionId: 'qoder-session',
      runId: 'run-qoder-wrong-prompt',
      userText: 'new prompt',
      evidence,
      timing,
      status: 'interrupted',
      archiveFingerprint: stableHash({ runId: 'run-qoder-wrong-prompt', evidence, timing })
    })).rejects.toThrow('Provider turn id differs from the open lifecycle identity')
  })

  it('managed identity 只接受受控环境，不采信 hook payload 伪造字段', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'qoder-session',
        prompt: 'prompt',
        scry_managed_run_id: 'forged-run',
        scry_managed_prompt_hash: 'a'.repeat(64),
        timestamp: timing.startedAt
      },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: 'bad\nrun',
        SCRY_MANAGED_PROMPT_HASH: 'not-a-hash'
      }
    })

    const open = JSON.parse(await readFile(join(
      root, '.scry', 'runtime', 'qoder', safeKey('qoder-session'), 'open.json'
    ), 'utf8')) as Record<string, unknown>
    expect(open.managedRunId).toBeUndefined()
    expect(open.managedPromptHash).toBeUndefined()
  })

  it('Qoder 无 Provider turn id 时拒绝唯一但开始时间过旧的 provisional open', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: { session_id: 'qoder-session', prompt: '/rate-workflow 1', timestamp: '2026-07-29T11:59:00.000Z' }
    })
    const evidence = aggregateTurnEvidence({ userText: '/rate-workflow 1', events: [], source: 'scry_provider_adapter' })

    await expect(prepareManagedRecorderTurn({
      workspace: root,
      provider: 'qoder',
      sessionId: 'qoder-session',
      runId: 'run-qoder-stale-open',
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'interrupted',
      archiveFingerprint: stableHash({ runId: 'run-qoder-stale-open', evidence, timing })
    })).rejects.toThrow('Provider turn id differs from the open lifecycle identity')
  })

  it('excludes a live native turn without a Scry run id, but keeps unmatched opens pending', async () => {
    const root = await workspace()
    await startManaged(root)
    const openPath = join(root, '.scry', 'runtime', 'codex', safeKey('session-1'), 'open.json')
    const before = await readFile(openPath, 'utf8')
    expect(JSON.parse(before).managedRunId).toBeUndefined()
    expect(await recoverManagedRecorderTurns(root, process.env, {
      abandonProvisional: true,
      isLiveManagedRun: (runId, native) => runId === undefined && native?.provider === 'codex' &&
        native.sessionId === 'session-1' && native.providerTurnId === 'turn-1'
    })).toEqual({ recovered: 0, pending: 0 })
    expect(await readFile(openPath, 'utf8')).toBe(before)
    expect(await recoverManagedRecorderTurns(root, process.env, {
      abandonProvisional: true,
      isLiveManagedRun: (_runId, native) => native?.providerTurnId === 'different-live-turn'
    })).toEqual({ recovered: 0, pending: 1 })
    expect(await readFile(openPath, 'utf8')).toBe(before)
    expect(await listRecords(join(root, '.scry'))).toHaveLength(0)
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
    expect(await recoverManagedRecorderTurns(root, process.env, {
      isLiveManagedRun: (candidate) => candidate === 'run-1'
    })).toEqual({ recovered: 0, pending: 0 })
    expect(await listRecords(join(root, '.scry'))).toHaveLength(0)
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
    const committedHandoff = JSON.stringify({ ...handoff, phase: 'archive_committed' })
    await writeFile(canonical, committedHandoff)
    expect(await recoverManagedRecorderTurns(root, process.env, {
      isLiveManagedRun: (candidate) => candidate === 'run-1'
    })).toEqual({ recovered: 0, pending: 0 })
    expect(await readFile(canonical, 'utf8')).toBe(committedHandoff)
    expect(await listRecords(join(root, '.scry'))).toHaveLength(0)

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

  it('Qoder 相同 prompt 的不同 managed run 不会被错误去重', async () => {
    const root = await workspace()
    const promptHash = createHash('sha256').update('same').digest('hex')
    const start = (runId: string) => handleRecorderHook({
      provider: 'qoder' as const,
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'qoder-session',
        prompt: 'same',
        timestamp: timing.startedAt
      },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: runId,
        SCRY_MANAGED_PROMPT_HASH: promptHash
      }
    })

    await expect(start('run-a')).resolves.toMatchObject({ status: 'started' })
    await expect(start('run-b')).resolves.toMatchObject({ status: 'started' })

    const runtimeRoot = join(root, '.scry', 'runtime', 'qoder', safeKey('qoder-session'))
    const open = JSON.parse(await readFile(join(runtimeRoot, 'open.json'), 'utf8')) as {
      generation: number
      managedRunId?: string
    }
    expect(open).toMatchObject({ generation: 2, managedRunId: 'run-b' })
    expect(await recoverManagedRecorderTurns(root, process.env, {
      isLiveManagedRun: (candidate) => candidate === 'run-a' || candidate === 'run-b'
    })).toEqual({ recovered: 0, pending: 0 })
    expect(await recoverManagedRecorderTurns(root, process.env, {
      isLiveManagedRun: (candidate) => candidate === 'run-b'
    })).toEqual({ recovered: 0, pending: 1 })
    await expect(readFile(join(runtimeRoot, 'turns', '00000001', 'pending-open.json'), 'utf8'))
      .resolves.toContain('run-a')
  })
})

describe('managed provider turn index', () => {
  const indexPath = (root: string): string =>
    join(root, '.scry', 'runtime', 'codex', safeKey('session-1'), 'provider-turn-index.json')

  async function startTurn(root: string, turnId: string, startedAt: string): Promise<void> {
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'session-1',
        turn_id: turnId,
        prompt: '/rate-workflow 1',
        timestamp: startedAt
      }
    })
  }

  async function commitTurn(root: string, turnId: string, runId: string): Promise<string> {
    const evidence = canonicalEvidence()
    const archiveFingerprint = stableHash({ runId, evidence, timing })
    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId,
      providerTurnId: turnId,
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })
    if (prepared.status !== 'prepared') throw new Error(`unexpected prepare status: ${prepared.status}`)
    const committed = await commitManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId,
      recordId: prepared.recordId,
      archiveFingerprint,
      providerTurnId: turnId,
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed'
    })
    if (committed.status !== 'committed') throw new Error(`unexpected commit status: ${committed.status}`)
    return prepared.recordId
  }

  function replay(root: string, turnId: string, runId: string, override: Partial<typeof timing> = {}) {
    const evidence = canonicalEvidence()
    const replayTiming = { ...timing, ...override }
    return prepareManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-1',
      runId,
      providerTurnId: turnId,
      userText: '/rate-workflow 1',
      evidence,
      timing: replayTiming,
      status: 'completed',
      archiveFingerprint: stableHash({ runId, evidence, timing: replayTiming })
    })
  }

  it('canonical commit 增量推进派生索引，使下一轮的否定判断不必全量解析 records', async () => {
    const root = await workspace()
    await startTurn(root, 'turn-1', timing.startedAt)
    const recordId = await commitTurn(root, 'turn-1', 'run-1')

    expect(JSON.parse(await readFile(indexPath(root), 'utf8'))).toEqual({
      schemaVersion: 1,
      stamp: { count: 1, maxSequence: 1 },
      providerTurnRecordIds: { 'turn-1': recordId }
    })

    // 索引同鲜且不含 turn-2 → 可信否定，仍然正常开出新一轮 handoff。
    await startTurn(root, 'turn-2', '2026-07-29T13:00:00.000Z')
    await expect(replay(root, 'turn-2', 'run-2')).resolves.toMatchObject({ status: 'prepared' })
  })

  it('索引命中时仍按权威记录判定重复与冲突', async () => {
    const root = await workspace()
    await startTurn(root, 'turn-1', timing.startedAt)
    await commitTurn(root, 'turn-1', 'run-1')

    await expect(replay(root, 'turn-1', 'run-1-replay')).resolves.toMatchObject({ status: 'duplicate' })
    await expect(replay(root, 'turn-1', 'run-1-conflict', {
      completedAt: '2026-07-29T12:00:09.000Z',
      durationMs: 9_000
    })).rejects.toThrow('existing record differs from canonical Scry turn')
  })

  it('索引 stamp 过期时回退权威全量扫描并重建，不把未见过的记录当成不存在', async () => {
    const root = await workspace()
    await startTurn(root, 'turn-1', timing.startedAt)
    const recordId = await commitTurn(root, 'turn-1', 'run-1')
    await writeFile(indexPath(root), JSON.stringify({
      schemaVersion: 1,
      stamp: { count: 99, maxSequence: 99 },
      providerTurnRecordIds: {}
    }))

    await expect(replay(root, 'turn-1', 'run-1-replay')).resolves.toMatchObject({ status: 'duplicate' })
    expect(JSON.parse(await readFile(indexPath(root), 'utf8'))).toEqual({
      schemaVersion: 1,
      stamp: { count: 1, maxSequence: 1 },
      providerTurnRecordIds: { 'turn-1': recordId }
    })
  })

  it('索引同鲜但映射不自洽时落回权威全量扫描', async () => {
    const root = await workspace()
    await startTurn(root, 'turn-1', timing.startedAt)
    const recordId = await commitTurn(root, 'turn-1', 'run-1')
    await writeFile(indexPath(root), JSON.stringify({
      schemaVersion: 1,
      stamp: { count: 1, maxSequence: 1 },
      providerTurnRecordIds: { 'turn-1': '0'.repeat(32) }
    }))

    await expect(replay(root, 'turn-1', 'run-1-replay')).resolves.toMatchObject({ status: 'duplicate' })
    expect(JSON.parse(await readFile(indexPath(root), 'utf8'))).toMatchObject({
      providerTurnRecordIds: { 'turn-1': recordId }
    })
  })
})

describe('提交通知投递位置', () => {
  const timing = {
    startedAt: '2026-07-29T12:00:00.000Z',
    completedAt: '2026-07-29T12:00:10.000Z',
    durationMs: 10_000
  }

  // 每条通知都要起一次仓库回调进程；这里用 sleep 模拟真实回调的秒级开销。
  async function slowCommitHook(root: string): Promise<{ path: string; capture: string }> {
    const path = join(root, 'slow-commit-hook.sh')
    const capture = join(root, 'slow-commit-hook.jsonl')
    await writeFile(path, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\nsleep 1.5\nexit 0\n`)
    await chmod(path, 0o700)
    return { path, capture }
  }

  async function ackedThrough(root: string): Promise<number | null> {
    try {
      const state = JSON.parse(
        await readFile(join(root, '.scry', 'notifications', 'commit-hooks', `${stableHash('explicit-environment-v1')}.json`), 'utf8')
      ) as { ackedThrough?: number }
      return state.ackedThrough ?? null
    } catch {
      return null
    }
  }

  async function commitOnce(
    root: string,
    runId: string,
    env: NodeJS.ProcessEnv,
    commitNotifications?: 'await' | 'detach'
  ): Promise<void> {
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: {
        session_id: 'session-notify',
        turn_id: runId,
        prompt: '/rate-workflow 1',
        timestamp: timing.startedAt
      },
      // hook 路径自己也会投递；这里只测 managed commit 的投递位置。
      deferDelivery: true
    })
    const evidence = canonicalEvidence()
    const archiveFingerprint = stableHash({ runId, evidence, timing })
    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-notify',
      runId,
      providerTurnId: runId,
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })
    if (prepared.status !== 'prepared') throw new Error(`unexpected prepare status: ${prepared.status}`)
    const committed = await commitManagedRecorderTurn({
      workspace: root,
      provider: 'codex',
      sessionId: 'session-notify',
      runId,
      recordId: prepared.recordId,
      archiveFingerprint,
      providerTurnId: runId,
      userText: '/rate-workflow 1',
      evidence,
      timing,
      status: 'completed',
      env,
      ...(commitNotifications ? { commitNotifications } : {})
    })
    expect(committed).toMatchObject({ status: 'committed' })
  }

  it('默认 await：CLI/recover 语义下投递完成后才返回', async () => {
    const root = await workspace()
    const hook = await slowCommitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }

    await commitOnce(root, 'run-await', env)
    await expect(ackedThrough(root)).resolves.toBe(1)
  }, 15_000)

  it('detach：轮次收口不等仓库回调，投递仍会发生', async () => {
    const root = await workspace()
    const hook = await slowCommitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }

    const startedAt = Date.now()
    await commitOnce(root, 'run-detach', env, 'detach')
    const settleMs = Date.now() - startedAt
    // 返回时慢回调还没跑完：这正是“7 秒的轮次显示成分钟级运行中”的修复点。
    await expect(ackedThrough(root)).resolves.toBeNull()
    expect(settleMs).toBeLessThan(1_500)

    for (let i = 0; i < 60 && (await ackedThrough(root)) === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await expect(ackedThrough(root)).resolves.toBe(1)
  })
})
