import { readdir, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { listRecords, stableHash } from '../../core/turn-recorder/store'
import { commitManagedTraceTurn, recoverManagedTraceTurns } from '../managed-turn-commit'
import { readTraceArchive } from '../transcript-archive'
import { fixture, input, startManaged, asClaude } from './fixture.test'

export function registerSuite4(): void {


  it('open 尚未到达时先保留 prepared journal，后续恢复可完整补写两端', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = input(workspace, userDataDir)

    await expect(commitManagedTraceTurn(request, { waitMs: 0 })).rejects.toThrow('open identity')
    const liveJournalFiles = await readdir(join(userDataDir, 'managed-turn-commits'))
    await expect(recoverManagedTraceTurns(userDataDir, {
      cwd: workspace,
      isLiveManagedRun: (candidate) => candidate === request.turn.runId
    })).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
    expect(await readdir(join(userDataDir, 'managed-turn-commits'))).toEqual(liveJournalFiles)
    expect(await listRecords(join(workspace, '.scry'))).toHaveLength(0)
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

  it('terminal canonical journal 可重建已丢失的 provisional lifecycle', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = input(workspace, userDataDir)

    await expect(commitManagedTraceTurn(request, { waitMs: 0 })).rejects.toThrow('open identity')
    await expect(recoverManagedTraceTurns(userDataDir, { cwd: workspace, waitMs: 100 })).resolves.toEqual({
      recovered: 1,
      pending: 0,
      errors: []
    })

    expect(readTraceArchive({
      cwd: workspace,
      sessionId: request.sessionId,
      providerId: request.providerId,
      userDataDir
    })?.turns).toHaveLength(1)
    await expect(listRecords(join(workspace, '.scry'))).resolves.toEqual([
      expect.objectContaining({ providerTurnId: request.providerTurnId })
    ])
  })

  it('Claude prepared journal 可在 open identity 到达后恢复两端', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = asClaude(input(workspace, userDataDir))

    await expect(commitManagedTraceTurn(request, { waitMs: 0 })).rejects.toThrow('open identity')
    await startManaged(workspace, 'claude')
    await expect(recoverManagedTraceTurns(userDataDir, {
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
}
