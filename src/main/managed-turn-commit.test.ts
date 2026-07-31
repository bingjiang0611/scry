import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { listRecords, stableHash } from '../core/turn-recorder/store'
import {
  canonicalOrObservedTurnTiming,
  canonicalTurnTiming,
  commitManagedTraceTurn,
  deleteManagedTurnArtifacts,
  managedSessionRunIds,
  persistManagedTraceProgress,
  recoverManagedTraceProgress,
  recoverManagedTraceTurns,
  type ManagedTraceTurnCommitInput
} from './managed-turn-commit'
import { deleteTranscriptCopies, readTraceArchive, traceArchivePath, upsertTraceArchiveTurn } from './transcript-archive'

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
      id: 'response',
      ts: '2026-07-29T12:00:05.500Z',
      runId: 'run-1',
      kind: 'model',
      stage: 'response_completed',
      messageId: 'response-1',
      durationMs: 5_500,
      runtimeMetadata: {
        timingSource: 'observed',
        timingBoundary: 'turn_or_activity_end'
      }
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

function withCapturedDiff(request: ManagedTraceTurnCommitInput): ManagedTraceTurnCommitInput {
  const diff: TraceEvent = {
    id: 'diff',
    ts: request.timing.completedAt,
    runId: request.turn.runId,
    kind: 'harness',
    stage: 'turn_diff',
    turnDiff: {
      version: 1,
      beforeAt: request.timing.startedAt,
      afterAt: request.timing.completedAt,
      captureMs: 1,
      status: 'captured',
      cleanup: 'ok',
      files: []
    }
  }
  const items = [...request.turn.items, diff]
  return {
    ...request,
    turn: {
      ...request.turn,
      items,
      turnEvidence: aggregateTurnEvidence({
        userText: request.turn.userText,
        events: items,
        source: 'scry_provider_adapter'
      })
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
  it('仅非 completed 轮次可在缺 Provider result 时使用 App 观测边界', () => {
    const observed = {
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:03.000Z',
      durationMs: 3_000
    }

    expect(canonicalOrObservedTurnTiming([], 'qoder', 'failed', observed)).toEqual(observed)
    expect(canonicalOrObservedTurnTiming([], 'qoder', 'interrupted', observed)).toEqual(observed)
    expect(canonicalOrObservedTurnTiming([], 'qoder', 'completed', observed)).toBeNull()
    expect(canonicalOrObservedTurnTiming([], 'codex', 'failed', observed)).toBeNull()
  })

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
      'modelTiming',
      'files',
      'diff',
      'dangerousOperations',
      'errors'
    ] as const) {
      expect(record[key]).toEqual(archiveEvidence?.[key])
    }
  })

  it('500-turn legacy monolith 后仍以 segment 提交下一轮且不留下 recovery dead-end', async () => {
    const { workspace, userDataDir } = await fixture()
    const legacy = traceArchivePath(userDataDir, workspace, 'session-1', 'codex')
    await mkdir(dirname(legacy), { recursive: true })
    await writeFile(legacy, JSON.stringify({
      version: 3,
      cwd: workspace,
      sessionId: 'session-1',
      providerId: 'codex',
      runtimeProvider: 'codex_cli',
      turns: Array.from({ length: 500 }, (_, index) => ({
        runId: `legacy-${index}`,
        providerTurnId: `legacy-turn-${index}`,
        userText: `legacy ${index}`,
        items: [],
        done: true,
        status: 'completed',
        ts: index
      }))
    }))
    await startManaged(workspace)

    await expect(commitManagedTraceTurn(input(workspace, userDataDir))).resolves.toMatchObject({ recorder: 'committed' })
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: 'session-1',
      providerId: 'codex',
      userDataDir
    })?.turns).toHaveLength(501)
    await expect(recoverManagedTraceProgress(userDataDir, { cwd: workspace, providerId: 'codex', waitMs: 0 }))
      .resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
    await expect(recoverManagedTraceTurns(userDataDir, { cwd: workspace, providerId: 'codex', waitMs: 0 }))
      .resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
  })

  it('session deletion can discover and remove pending managed progress plus its atomic temp', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = input(workspace, userDataDir)
    await persistManagedTraceProgress(request)
    const root = join(userDataDir, 'managed-turn-progress')
    const progress = join(root, readdirSync(root).find((name) => name.endsWith('.json'))!)
    const temp = `${progress}.123.00000000-0000-4000-8000-000000000000.tmp`
    writeFileSync(temp, 'partial sensitive turn')

    expect(managedSessionRunIds(userDataDir, {
      cwd: workspace,
      sessionId: request.sessionId,
      providerId: request.providerId
    })).toEqual(['run-1'])
    await expect(deleteManagedTurnArtifacts(userDataDir, new Set(['run-1']))).resolves.toEqual({ failed: [] })
    expect(existsSync(progress)).toBe(false)
    expect(existsSync(temp)).toBe(false)
    await expect(recoverManagedTraceProgress(userDataDir, { cwd: workspace, providerId: 'codex', waitMs: 0 }))
      .resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
  })

  it('unattributable malformed artifacts warn globally without blocking an unrelated scoped run', async () => {
    const { userDataDir } = await fixture()
    const progress = join(userDataDir, 'managed-turn-progress', 'malformed.json')
    const journal = join(userDataDir, 'managed-turn-commits', 'malformed.json')
    await mkdir(dirname(progress), { recursive: true })
    await mkdir(dirname(journal), { recursive: true })
    await writeFile(progress, '{"schemaVersion":1}')
    await writeFile(journal, '{"schemaVersion":1}')

    await expect(recoverManagedTraceProgress(userDataDir)).resolves.toEqual({
      recovered: 0,
      pending: 1,
      errors: ['invalid managed turn progress: malformed.json']
    })
    await expect(recoverManagedTraceTurns(userDataDir)).resolves.toEqual({
      recovered: 0,
      pending: 1,
      errors: ['invalid managed turn journal: malformed.json']
    })
    await expect(recoverManagedTraceProgress(userDataDir, { cwd: '/another-repo' })).resolves.toEqual({
      recovered: 0,
      pending: 0,
      errors: []
    })
    await expect(recoverManagedTraceTurns(userDataDir, { cwd: '/another-repo' })).resolves.toEqual({
      recovered: 0,
      pending: 0,
      errors: []
    })
    expect(existsSync(progress)).toBe(true)
    expect(existsSync(journal)).toBe(true)
  })

  it('deletion waits for an in-flight managed commit and cannot be followed by archive resurrection', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = input(workspace, userDataDir)
    const commit = commitManagedTraceTurn(request, { waitMs: 2_000 })
    const journalRoot = join(userDataDir, 'managed-turn-commits')
    const hasJournal = (): boolean => {
      try { return readdirSync(journalRoot).some((name) => name.endsWith('.json')) } catch { return false }
    }
    for (let attempt = 0; attempt < 100 && !hasJournal(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(hasJournal()).toBe(true)

    let deletionFinished = false
    const deletion = deleteManagedTurnArtifacts(userDataDir, new Set(['run-1'])).then((result) => {
      expect(result).toEqual({ failed: [] })
      deleteTranscriptCopies({
        cwd: workspace,
        sessionId: request.sessionId,
        providerId: request.providerId,
        userDataDir
      })
      deletionFinished = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(deletionFinished).toBe(false)

    await startManaged(workspace)
    await commit
    await deletion
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: request.sessionId,
      providerId: request.providerId,
      userDataDir
    })).toBeNull()
    await expect(recoverManagedTraceProgress(userDataDir, { cwd: workspace, providerId: 'codex', waitMs: 0 }))
      .resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
    await expect(recoverManagedTraceTurns(userDataDir, { cwd: workspace, providerId: 'codex', waitMs: 0 }))
      .resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
  })

  it('Qoder failed turn 可用 unavailable assistant 与 canonical timing 提交同一份 evidence', async () => {
    const { workspace, userDataDir } = await fixture()
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace,
      managed: true,
      payload: {
        session_id: 'qoder-session',
        promptId: 'qoder-turn',
        prompt: '/rate-workflow 1',
        timestamp: '2026-07-29T12:00:00.000Z'
      }
    })
    const request = input(workspace, userDataDir)
    request.sessionId = 'qoder-session'
    request.providerTurnId = 'qoder-turn'
    request.providerId = 'qoder'
    request.runtimeProvider = 'qoder_cli'
    request.status = 'failed'
    request.turn = {
      ...request.turn,
      providerTurnId: 'qoder-turn',
      status: 'failed',
      items: request.turn.items.filter((event) => event.kind !== 'model')
    }
    request.turn.turnEvidence = aggregateTurnEvidence({
      userText: request.turn.userText,
      events: request.turn.items,
      source: 'scry_provider_adapter'
    })

    await expect(commitManagedTraceTurn(request)).resolves.toMatchObject({ recorder: 'committed' })
    const archive = readTraceArchive({
      cwd: workspace,
      sessionId: 'qoder-session',
      providerId: 'qoder',
      userDataDir
    })
    const [record] = await listRecords(join(workspace, '.scry'))

    expect(archive?.turns[0].turnEvidence).toEqual(expect.objectContaining({
      assistant: expect.objectContaining({ status: expect.not.stringMatching(/^available$/) })
    }))
    expect(record).toMatchObject({ provider: { id: 'qoder' }, status: 'failed' })
    expect(record.assistant).toEqual(archive?.turns[0].turnEvidence?.assistant)
  })

  it('recorder disabled 时 Qoder failure 无 Provider turn id 仍写入 Scry archive', async () => {
    const { workspace, userDataDir } = await fixture()
    await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: false,
      workspaceId: 'managed-main-fixture',
      dataDir: '.scry',
      repositories: { mode: 'workspace-only' },
      capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
    }))
    const request = input(workspace, userDataDir)
    request.providerId = 'qoder'
    request.runtimeProvider = 'qoder_cli'
    request.providerTurnId = ''
    request.status = 'failed'
    request.turn = {
      ...request.turn,
      providerTurnId: undefined,
      status: 'failed'
    }

    await expect(commitManagedTraceTurn(request)).resolves.toEqual({ recorder: 'disabled' })
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: request.sessionId,
      providerId: 'qoder',
      userDataDir
    })?.turns).toEqual([expect.objectContaining({ runId: 'run-1', status: 'failed' })])
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

  it.each([1, 2])('canonical commit 后第 %i 个 artifact cleanup 崩溃仍由 rich journal 单调恢复', async (failAt) => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    const base = input(workspace, userDataDir)
    const rich = withCapturedDiff(input(workspace, userDataDir))
    await persistManagedTraceProgress(base)
    let removals = 0

    await expect(commitManagedTraceTurn(rich, {
      removeArtifact: async (path) => {
        removals++
        if (removals === failAt) throw new Error(`simulated cleanup crash ${failAt}`)
        await rm(path, { force: true })
      }
    })).rejects.toThrow(`simulated cleanup crash ${failAt}`)

    await expect(recoverManagedTraceTurns(userDataDir, { cwd: workspace, waitMs: 100 })).resolves.toEqual({
      recovered: 1,
      pending: 0,
      errors: []
    })
    await expect(recoverManagedTraceProgress(userDataDir, { cwd: workspace, waitMs: 0 })).resolves.toEqual({
      recovered: 0,
      pending: 0,
      errors: []
    })
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: rich.sessionId,
      providerId: rich.providerId,
      userDataDir
    })?.turns[0].items).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'turn_diff' })]))
    const records = await listRecords(join(workspace, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].diff).toEqual(rich.turn.turnEvidence?.diff)
  })

  it('disabled recovery discards stale progress without overwriting a richer committed archive', async () => {
    const { workspace, userDataDir } = await fixture()
    const base = input(workspace, userDataDir)
    const rich = withCapturedDiff(input(workspace, userDataDir))
    await persistManagedTraceProgress(base)
    expect(upsertTraceArchiveTurn({
      cwd: rich.cwd,
      sessionId: rich.sessionId,
      providerId: rich.providerId,
      runtimeProvider: rich.runtimeProvider,
      userDataDir,
      turn: rich.turn
    })).toBe(true)
    await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: false,
      workspaceId: 'managed-main-fixture',
      dataDir: '.scry',
      repositories: { mode: 'workspace-only' },
      capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
    }))

    await expect(recoverManagedTraceProgress(userDataDir, { cwd: workspace, waitMs: 0 })).resolves.toEqual({
      recovered: 1,
      pending: 0,
      errors: []
    })
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: rich.sessionId,
      providerId: rich.providerId,
      userDataDir
    })?.turns[0].items).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'turn_diff' })]))
  })

  it('progress recovery 按 provider 过滤', async () => {
    const { workspace, userDataDir } = await fixture()
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace,
      managed: true,
      payload: {
        session_id: 'qoder-session',
        promptId: 'qoder-turn',
        prompt: '/rate-workflow 1',
        timestamp: '2026-07-29T12:00:00.000Z'
      }
    })
    const request = input(workspace, userDataDir)
    request.sessionId = 'qoder-session'
    request.providerTurnId = 'qoder-turn'
    request.providerId = 'qoder'
    request.runtimeProvider = 'qoder_cli'
    request.turn = { ...request.turn, providerTurnId: 'qoder-turn' }
    await persistManagedTraceProgress(request)

    await expect(recoverManagedTraceProgress(userDataDir, {
      cwd: workspace,
      providerId: 'codex',
      waitMs: 0
    })).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
    await expect(recoverManagedTraceProgress(userDataDir, {
      cwd: workspace,
      providerId: 'qoder',
      waitMs: 100
    })).resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
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
