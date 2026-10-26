import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { it, expect } from 'vitest'
import { aggregateTurnEvidence } from '../../core/turn-recorder/aggregate'
import { handleRecorderHook } from '../../core/turn-recorder/recorder'
import { listRecords } from '../../core/turn-recorder/store'
import { commitManagedTraceTurn, recoverManagedTraceProgress, recoverManagedTraceTurns, persistManagedTraceProgress, managedSessionRunIds, deleteManagedTurnArtifacts, type ManagedTraceTurnCommitInput } from '../managed-turn-commit'
import { traceArchivePath, readTraceArchive, deleteTranscriptCopies } from '../transcript-archive'
import { fixture, startManaged, input } from './fixture.test'

export function registerSuite2(): void {


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

  it('keeps malformed attributed journals visible to scoped recovery without overwriting them', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = input(workspace, userDataDir)
    const journal = join(userDataDir, 'managed-turn-commits', 'malformed.json')
    await mkdir(dirname(journal), { recursive: true })
    const bytes = JSON.stringify({ schemaVersion: 1, request: {
      cwd: workspace, sessionId: request.sessionId, providerId: request.providerId
    } })
    await writeFile(journal, bytes)

    await expect(recoverManagedTraceTurns(userDataDir, {
      cwd: workspace, providerId: request.providerId
    })).resolves.toEqual({
      recovered: 0, pending: 1, errors: ['invalid managed turn journal: malformed.json']
    })
    expect(await readFile(journal, 'utf8')).toBe(bytes)
    await expect(recoverManagedTraceTurns(userDataDir, { cwd: '/another-repo' })).resolves.toEqual({
      recovered: 0, pending: 0, errors: []
    })
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

  it.each([false, true])('Qoder 极早中断与 Scry 墙钟可持久化（已有 prompt hook=%s）', async (hasHook) => {
    const { workspace, userDataDir } = await fixture()
    if (hasHook) await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace,
      managed: true,
      payload: {
        session_id: 'qoder-session',
        prompt: '/rate-workflow 1',
        timestamp: '2026-07-29T12:00:00.000Z'
      }
    })
    const request = input(workspace, userDataDir)
    request.sessionId = 'qoder-session'
    request.providerTurnId = undefined
    request.providerId = 'qoder'
    request.runtimeProvider = 'qoder_cli'
    request.status = 'interrupted'
    request.turn = {
      ...request.turn,
      providerTurnId: undefined,
      status: 'interrupted',
      items: [{
        id: 'turn-wall:run-1', runId: 'run-1', kind: 'harness', stage: 'runtime:turn_wall',
        ts: '2026-07-29T12:00:10.000Z', durationMs: 10000,
        input: { startedAt: '2026-07-29T12:00:00.000Z', boundary: 'provider_settled' }
      }]
    }
    request.turn.turnEvidence = aggregateTurnEvidence({
      userText: request.turn.userText,
      events: request.turn.items,
      source: 'scry_provider_adapter'
    })

    await expect(persistManagedTraceProgress(request)).resolves.toBeUndefined()
    await expect(commitManagedTraceTurn(request)).resolves.toMatchObject({ recorder: 'committed' })
    const [record] = await listRecords(join(workspace, '.scry'))
    const [turn] = readTraceArchive({
      cwd: workspace,
      sessionId: 'qoder-session',
      providerId: 'qoder',
      userDataDir
    })?.turns ?? []

    expect(record).toMatchObject({ provider: { id: 'qoder' }, status: 'interrupted' })
    expect(record.providerTurnId).toBeUndefined()
    expect(turn).toMatchObject({ runId: 'run-1', status: 'interrupted' })
    expect(turn.providerTurnId).toBeUndefined()
    expect(turn.items).toContainEqual(request.turn.items[0])
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

  it('fails closed when a turn frozen as managed reaches a disabled terminal mode', async () => {
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

    await expect(commitManagedTraceTurn(request, { requireManaged: true }))
      .rejects.toThrow('managed recorder mode changed after turn start')
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: request.sessionId,
      providerId: request.providerId,
      userDataDir
    })).toBeNull()
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
}
