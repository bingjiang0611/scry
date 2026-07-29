import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { listRecords, stableHash } from '../core/turn-recorder/store'
import {
  canonicalTurnTiming,
  commitManagedTraceTurn,
  persistManagedTraceProgress,
  recoverManagedTraceProgress,
  recoverManagedTraceTurns,
  type ManagedTraceTurnCommitInput
} from './managed-turn-commit'
import { readTraceArchive } from './transcript-archive'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ workspace: string; userDataDir: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'scry-managed-main-workspace-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'scry-managed-main-user-data-'))
  roots.push(workspace, userDataDir)
  await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'managed-main-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  return { workspace, userDataDir }
}

function input(workspace: string, userDataDir: string): ManagedTraceTurnCommitInput {
  const events: TraceEvent[] = [
    {
      id: 'assistant',
      ts: '2026-07-29T12:00:05.000Z',
      runId: 'run-1',
      kind: 'model',
      stage: 'text_delta',
      text: '准确输出'
    },
    {
      id: 'result',
      ts: '2026-07-29T12:00:10.000Z',
      runId: 'run-1',
      kind: 'harness',
      stage: 'result',
      durationMs: 10_000,
      tokensIn: 10,
      tokensOut: 3
    }
  ]
  const timing = canonicalTurnTiming(events)
  if (!timing) throw new Error('fixture timing missing')
  const evidence = aggregateTurnEvidence({
    userText: '/rate-workflow 1',
    events,
    source: 'scry_provider_adapter'
  })
  return {
    userDataDir,
    cwd: workspace,
    sessionId: 'session-1',
    providerTurnId: 'turn-1',
    providerId: 'codex',
    runtimeProvider: 'codex_cli',
    timing,
    status: 'completed',
    turn: {
      runId: 'run-1',
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      items: events,
      turnEvidence: evidence,
      done: true,
      status: 'completed',
      ...timing,
      ts: Date.parse(timing.completedAt)
    }
  }
}

async function startManaged(workspace: string): Promise<void> {
  await handleRecorderHook({
    provider: 'codex',
    event: 'UserPromptSubmit',
    workspace,
    managed: true,
    payload: {
      session_id: 'session-1',
      turn_id: 'turn-1',
      // app-server 会把显式 skill 结构化；hook prompt 不一定保留原始 slash command。
      prompt: '1',
      timestamp: '2026-07-29T12:00:00.000Z'
    }
  })
}

describe('managed trace turn coordinator', () => {
  it('archive 与 CLI record 复用同一 evidence 和 result timing', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    const request = input(workspace, userDataDir)

    await expect(commitManagedTraceTurn(request)).resolves.toMatchObject({ recorder: 'committed' })
    const archive = readTraceArchive({
      cwd: workspace,
      sessionId: 'session-1',
      providerId: 'codex',
      userDataDir
    })
    const [record] = await listRecords(join(workspace, '.scry'))

    expect(archive?.turns[0]).toMatchObject({
      startedAt: request.timing.startedAt,
      completedAt: request.timing.completedAt,
      durationMs: request.timing.durationMs
    })
    expect(record).toMatchObject({
      startedAt: request.timing.startedAt,
      completedAt: request.timing.completedAt,
      durationMs: request.timing.durationMs
    })
    const archiveEvidence = archive?.turns[0].turnEvidence
    expect(archiveEvidence).toBeDefined()
    for (const key of [
      'user',
      'assistant',
      'tools',
      'skills',
      'mcps',
      'hooks',
      'usage',
      'files',
      'diff',
      'dangerousOperations',
      'errors'
    ] as const) {
      expect(record[key]).toEqual(archiveEvidence?.[key])
    }
  })

  it.each([
    ['status', (request: ManagedTraceTurnCommitInput) => {
      request.turn.status = 'failed'
    }],
    ['startedAt', (request: ManagedTraceTurnCommitInput) => {
      request.turn.startedAt = '2026-07-29T11:59:59.000Z'
    }],
    ['completedAt', (request: ManagedTraceTurnCommitInput) => {
      request.turn.completedAt = '2026-07-29T12:00:11.000Z'
    }],
    ['durationMs', (request: ManagedTraceTurnCommitInput) => {
      request.turn.durationMs = 11_000
    }]
  ])('拒绝 archive 与 CLI 的 %s 元数据分叉', async (_field, mutate) => {
    const { workspace, userDataDir } = await fixture()
    const request = input(workspace, userDataDir)
    mutate(request)

    await expect(commitManagedTraceTurn(request)).rejects.toThrow(
      'managed recorder archive metadata differs from canonical CLI metadata'
    )
    await expect(persistManagedTraceProgress(request)).rejects.toThrow(
      'managed recorder archive metadata differs from canonical CLI metadata'
    )
  })

  it('成功后重放同一 canonical turn 保持幂等且不留下 pending journal', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    const request = input(workspace, userDataDir)

    await expect(commitManagedTraceTurn(request)).resolves.toMatchObject({ recorder: 'committed' })
    await expect(commitManagedTraceTurn(request)).resolves.toMatchObject({ recorder: 'committed' })

    expect(readTraceArchive({
      cwd: workspace,
      sessionId: 'session-1',
      providerId: 'codex',
      userDataDir
    })?.turns).toHaveLength(1)
    expect(await listRecords(join(workspace, '.scry'))).toHaveLength(1)
    expect(await recoverManagedTraceTurns(userDataDir, { cwd: workspace, waitMs: 0 })).toEqual({
      recovered: 0,
      pending: 0,
      errors: []
    })
  })

  it('同一 Provider turn 换本地 runId 重放也只保留一条 archive 与 record', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    const request = input(workspace, userDataDir)
    await commitManagedTraceTurn(request)

    const replay = input(workspace, userDataDir)
    replay.turn = {
      ...replay.turn,
      runId: 'run-replay',
      items: replay.turn.items.map((event) => ({ ...event, runId: 'run-replay' }))
    }
    await expect(commitManagedTraceTurn(replay)).resolves.toMatchObject({
      recorder: 'committed'
    })

    expect(readTraceArchive({
      cwd: workspace,
      sessionId: 'session-1',
      providerId: 'codex',
      userDataDir
    })?.turns).toHaveLength(1)
    expect(await listRecords(join(workspace, '.scry'))).toHaveLength(1)
    expect(await recoverManagedTraceTurns(userDataDir, { cwd: workspace, waitMs: 0 })).toEqual({
      recovered: 0,
      pending: 0,
      errors: []
    })
  })

  it('Provider 完成后的 durable progress 可在等待 diff 期间崩溃后恢复两端', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    const request = input(workspace, userDataDir)

    await persistManagedTraceProgress(request)
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: 'session-1',
      providerId: 'codex',
      userDataDir
    })).toBeNull()
    expect(await listRecords(join(workspace, '.scry'))).toHaveLength(0)

    await expect(recoverManagedTraceProgress(userDataDir, {
      cwd: workspace,
      waitMs: 100
    })).resolves.toEqual({
      recovered: 1,
      pending: 0,
      errors: []
    })
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: 'session-1',
      providerId: 'codex',
      userDataDir
    })?.turns).toHaveLength(1)
    expect(await listRecords(join(workspace, '.scry'))).toHaveLength(1)
    expect(await recoverManagedTraceProgress(userDataDir, { cwd: workspace })).toEqual({
      recovered: 0,
      pending: 0,
      errors: []
    })
  })

  it('open 尚未到达时先保留 prepared journal，后续恢复可完整补写两端', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = input(workspace, userDataDir)

    await expect(commitManagedTraceTurn(request, { waitMs: 0 })).rejects.toThrow('open identity')
    await startManaged(workspace)
    await expect(recoverManagedTraceTurns(userDataDir, { cwd: workspace, waitMs: 100 })).resolves.toEqual({
      recovered: 1,
      pending: 0,
      errors: []
    })

    expect(readTraceArchive({
      cwd: workspace,
      sessionId: 'session-1',
      providerId: 'codex',
      userDataDir
    })?.turns).toHaveLength(1)
    expect(await listRecords(join(workspace, '.scry'))).toHaveLength(1)
  })

  it('恢复拒绝 archive 与 CLI 元数据分叉的 journal，且两端都不提交', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = input(workspace, userDataDir)
    request.turn.status = 'failed'
    const journalRequest = {
      cwd: request.cwd,
      sessionId: request.sessionId,
      providerTurnId: request.providerTurnId,
      providerId: request.providerId,
      runtimeProvider: request.runtimeProvider,
      turn: request.turn,
      timing: request.timing,
      status: request.status
    }
    const root = join(userDataDir, 'managed-turn-commits')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'run-1.json'), JSON.stringify({
      schemaVersion: 1,
      phase: 'prepared',
      archiveFingerprint: stableHash(journalRequest),
      request: journalRequest
    }))

    const recovery = await recoverManagedTraceTurns(userDataDir, {
      cwd: workspace,
      waitMs: 0
    })
    expect(recovery).toMatchObject({
      recovered: 0,
      pending: 1,
      errors: expect.arrayContaining([
        expect.stringContaining('archive metadata differs from canonical CLI metadata')
      ])
    })
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: 'session-1',
      providerId: 'codex',
      userDataDir
    })).toBeNull()
    expect(await listRecords(join(workspace, '.scry'))).toHaveLength(0)
  })
})
