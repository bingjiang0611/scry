import { readdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { aggregateTurnEvidence } from '../../core/turn-recorder/aggregate'
import { handleRecorderHook } from '../../core/turn-recorder/recorder'
import { listRecords } from '../../core/turn-recorder/store'
import { commitManagedTraceTurn, recoverManagedTraceTurns, persistManagedTraceProgress, recoverManagedTraceProgress, type ManagedTraceTurnCommitInput } from '../managed-turn-commit'
import { readTraceArchive, upsertTraceArchiveTurn } from '../transcript-archive'
import { fixture, startManaged, input, asClaude, withCapturedDiff, disabledCaptureConfig } from './fixture.test'

export function registerSuite3(): void {


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
    const liveProgressFiles = await readdir(join(userDataDir, 'managed-turn-progress'))
    await expect(recoverManagedTraceProgress(userDataDir, {
      cwd: workspace,
      isLiveManagedRun: (candidate) => candidate === request.turn.runId
    })).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
    expect(await readdir(join(userDataDir, 'managed-turn-progress'))).toEqual(liveProgressFiles)
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

  it('Claude durable progress 可在崩溃后恢复 archive 与 CLI record', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace, 'claude')
    const request = asClaude(input(workspace, userDataDir))

    await persistManagedTraceProgress(request)
    await expect(recoverManagedTraceProgress(userDataDir, {
      cwd: workspace,
      providerId: 'claude',
      waitMs: 100
    })).resolves.toEqual({ recovered: 1, pending: 0, errors: [] })

    expect(readTraceArchive({
      cwd: workspace,
      sessionId: request.sessionId,
      providerId: 'claude',
      userDataDir
    })?.turns).toHaveLength(1)
    expect(await listRecords(join(workspace, '.scry'))).toEqual([
      expect.objectContaining({ provider: { id: 'claude' } })
    ])
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

  it('keeps the large v1 intent immutable and recovers honestly when the phase sidecar is corrupt', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    const request = input(workspace, userDataDir)
    request.turn.userText = 'fixed-large-payload-'.repeat(10_000)
    request.turn.turnEvidence = aggregateTurnEvidence({
      userText: request.turn.userText,
      events: request.turn.items,
      source: 'scry_provider_adapter'
    })

    await expect(commitManagedTraceTurn(request, {
      removeArtifact: async () => { throw new Error('simulated post-commit cleanup crash') }
    })).rejects.toThrow('simulated post-commit cleanup crash')

    const journalName = (await readdir(join(userDataDir, 'managed-turn-commits'))).find((name) => name.endsWith('.json'))!
    const journalPath = join(userDataDir, 'managed-turn-commits', journalName)
    const statePath = join(userDataDir, 'managed-turn-journal-state', journalName)
    const immutableIntent = await readFile(journalPath)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(immutableIntent.byteLength / 10)

    await writeFile(statePath, JSON.stringify({ ...state, phase: 'archive_committed', archiveFingerprint: 'wrong' }))
    expect(await readFile(journalPath)).toEqual(immutableIntent)
    await expect(recoverManagedTraceTurns(userDataDir, { cwd: workspace, waitMs: 100 })).resolves.toEqual({
      recovered: 1,
      pending: 0,
      errors: []
    })
    expect(existsSync(journalPath)).toBe(false)
    expect(existsSync(statePath)).toBe(false)
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

  it('disabled direct commit reuses the protection read and keeps a richer archive', async () => {
    // summary capture leaves no pinned policy in progress, so protection reads the archive and
    // the disabled branch decides dominance from that same read.
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
    await writeFile(join(workspace, 'scry.config.json'), disabledCaptureConfig(false, 'summary'))

    await expect(commitManagedTraceTurn(base)).resolves.toEqual({ recorder: 'disabled' })
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: rich.sessionId,
      providerId: rich.providerId,
      userDataDir
    })?.turns[0].items).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'turn_diff' })]))
  })

  it('disabled direct commit still reads the archive when progress pins the policy', async () => {
    // full capture pins the policy in progress, so protection skips the archive. The disabled
    // branch must then read it itself and refuse to overwrite a conflicting committed turn.
    const { workspace, userDataDir } = await fixture()
    await writeFile(join(workspace, 'scry.config.json'), disabledCaptureConfig(true, 'full'))
    const base = input(workspace, userDataDir)
    await persistManagedTraceProgress(base)
    const [progressFile] = await readdir(join(userDataDir, 'managed-turn-progress'))
    const persisted = JSON.parse(await readFile(join(userDataDir, 'managed-turn-progress', progressFile!), 'utf8')) as { request: ManagedTraceTurnCommitInput }
    expect(persisted.request.turn.toolContentPolicy).toBeTruthy()
    expect(upsertTraceArchiveTurn({
      cwd: base.cwd,
      sessionId: base.sessionId,
      providerId: base.providerId,
      runtimeProvider: base.runtimeProvider,
      userDataDir,
      turn: { ...base.turn, userText: 'different prompt' }
    })).toBe(true)
    await writeFile(join(workspace, 'scry.config.json'), disabledCaptureConfig(false, 'full'))

    await expect(commitManagedTraceTurn(base)).rejects.toThrow('conflicts with committed archive')
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: base.sessionId,
      providerId: base.providerId,
      userDataDir
    })?.turns[0].userText).toBe('different prompt')
  })

  it('managed commit rejects an archived Provider turn with different content', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = input(workspace, userDataDir)
    expect(upsertTraceArchiveTurn({
      cwd: request.cwd,
      sessionId: request.sessionId,
      providerId: request.providerId,
      runtimeProvider: request.runtimeProvider,
      userDataDir,
      turn: { ...request.turn, userText: 'different prompt' }
    })).toBe(true)
    await startManaged(workspace)

    await expect(commitManagedTraceTurn(request)).rejects.toThrow('collision')
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
}
