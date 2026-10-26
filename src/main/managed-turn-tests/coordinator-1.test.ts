import { readFile, writeFile, readdir, mkdir, chmod } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { aggregateTurnEvidence } from '../../core/turn-recorder/aggregate'
import { readRecorderContent } from '../../core/turn-recorder/content-store'
import { listRecords } from '../../core/turn-recorder/store'
import { persistManagedTraceProgress, commitManagedTraceTurn, recoverManagedTraceTurns, canonicalOrObservedTurnTiming, type ManagedTraceTurnCommitInput, recoverManagedTraceProgress, managedRecoveryScopes } from '../managed-turn-commit'
import { readTraceArchive } from '../transcript-archive'
import { fixture, startManaged, input, startManagedOpenCode, asOpenCode, notificationLine } from './fixture.test'

export function registerSuite1(): void {

  it('default full progress, journal recovery, archive and canonical records retain raw bodies', async () => {
    const { workspace, userDataDir } = await fixture()
    const path = join(workspace, 'scry.config.json')
    const config = JSON.parse(await readFile(path, 'utf8'))
    delete config.capture.toolOutput
    await writeFile(path, JSON.stringify(config))
    await startManaged(workspace)
    const request = input(workspace, userDataDir)
    const rawOutput = `${'正文😀'.repeat(4_000)}\npassword=MANAGED_OUTPUT_SECRET\nfinished`
    request.turn.items.push(
      { id: 'tool', runId: 'run-1', ts: '2026-07-29T12:00:01.000Z', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 't', input: { token: 'MANAGED_INPUT_SECRET', command: 'echo ok' } },
      { id: 'output', runId: 'run-1', ts: '2026-07-29T12:00:02.000Z', kind: 'tool', stage: 'tool_result', toolUseId: 't', output: rawOutput }
    )
    request.turn.turnEvidence = aggregateTurnEvidence({ userText: request.turn.userText, events: request.turn.items })
    const scan = async (dir: string): Promise<string> => {
      const entries = await readdir(dir, { withFileTypes: true })
      return (await Promise.all(entries.map((entry) => entry.isDirectory() ? scan(join(dir, entry.name)) : readFile(join(dir, entry.name), 'utf8')))).join('\n')
    }
    await persistManagedTraceProgress(request)
    expect(await scan(userDataDir)).toMatch(/MANAGED_(INPUT|OUTPUT)_SECRET/)
    config.capture.toolOutput = 'summary'
    await writeFile(path, JSON.stringify(config))
    await persistManagedTraceProgress(request)
    expect(await scan(userDataDir)).toMatch(/MANAGED_(INPUT|OUTPUT)_SECRET/)
    await expect(commitManagedTraceTurn(request, { waitMs: 0, removeArtifact: async () => { throw new Error('simulated interruption') } })).rejects.toThrow('simulated interruption')
    expect(await scan(userDataDir)).toMatch(/MANAGED_(INPUT|OUTPUT)_SECRET/)
    expect(await scan(join(workspace, '.scry'))).toMatch(/MANAGED_(INPUT|OUTPUT)_SECRET/)
    config.capture.toolOutput = 'full-redacted'
    config.capture.toolContentFieldBytes = 10
    config.capture.toolContentTurnBytes = 20
    await writeFile(path, JSON.stringify(config))
    await recoverManagedTraceTurns(userDataDir, { cwd: workspace, waitMs: 0 })
    await commitManagedTraceTurn(request, { waitMs: 0 })
    const records = await listRecords(join(workspace, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].tools.value![0].outputContent?.content).not.toContain('finished')
    expect(records[0].tools.value![0].outputContent!.savedBytes).toBeGreaterThan(0)
    expect(records[0].tools.value![0].outputContent!.savedBytes).toBeLessThanOrEqual(8 * 1024)
    const outputRef = records[0].tools.value![0].outputContent!.contentRef!
    await expect(readRecorderContent(join(workspace, '.scry'), outputRef)).resolves.toBe(rawOutput)
  })

  it('managed 记录透出终止时间来源，并在缺 Provider result 时降级为观测边界', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    const request = input(workspace, userDataDir)
    await commitManagedTraceTurn(request, { waitMs: 0 })
    const [canonical] = await listRecords(join(workspace, '.scry'))
    expect(canonical.termination).toMatchObject({
      status: 'available',
      quality: 'exact',
      value: { reason: 'provider_terminal', completedAtSource: 'provider_terminal_event' }
    })
    // 重放同一轮必须给出同一份来源，否则崩溃恢复会改写既有证据。
    await commitManagedTraceTurn(request, { waitMs: 0 })
    expect((await listRecords(join(workspace, '.scry')))[0].termination).toEqual(canonical.termination)

    const observed = await fixture()
    await startManaged(observed.workspace)
    const withoutResult = input(observed.workspace, observed.userDataDir)
    withoutResult.turn.items = withoutResult.turn.items.filter((event) => event.stage !== 'result')
    await commitManagedTraceTurn(withoutResult, { waitMs: 0 })
    expect((await listRecords(join(observed.workspace, '.scry')))[0].termination).toMatchObject({
      status: 'partial',
      quality: 'estimated',
      value: { reason: 'run_ended', completedAtSource: 'recorder_observed_terminal' }
    })
  })

  it('仅非 completed 轮次可在缺 Provider result 时使用 App 观测边界', () => {
    const observed = {
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:03.000Z',
      durationMs: 3_000
    }

    expect(canonicalOrObservedTurnTiming([], 'qoder', 'failed', observed)).toEqual(observed)
    expect(canonicalOrObservedTurnTiming([], 'qoder', 'interrupted', observed)).toEqual(observed)
    expect(canonicalOrObservedTurnTiming([], 'opencode', 'failed', observed)).toEqual(observed)
    expect(canonicalOrObservedTurnTiming([], 'opencode', 'interrupted', observed)).toEqual(observed)
    expect(canonicalOrObservedTurnTiming([], 'qoder', 'completed', observed)).toBeNull()
    expect(canonicalOrObservedTurnTiming([], 'opencode', 'completed', observed)).toBeNull()
    expect(canonicalOrObservedTurnTiming([], 'codex', 'failed', observed)).toBeNull()
  })

  it('Claude 优先使用完整 App 观测边界，其他 provider 仍使用 result timing', () => {
    const events = [{
      kind: 'harness',
      stage: 'result',
      ts: '2026-07-29T12:00:10.000Z',
      durationMs: 2_000
    }]
    const observed = {
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:10.000Z',
      durationMs: 10_000
    }

    expect(canonicalOrObservedTurnTiming(events, 'claude', 'completed', observed)).toEqual(observed)
    expect(canonicalOrObservedTurnTiming(events, 'codex', 'completed', observed)).toEqual({
      startedAt: '2026-07-29T12:00:08.000Z',
      completedAt: '2026-07-29T12:00:10.000Z',
      durationMs: 2_000
    })
  })

  it('非 Claude 多 result timing 保留 continuation 间隔', () => {
    const events = [
      { kind: 'harness', stage: 'result', ts: '2026-07-29T12:00:10.000Z', durationMs: 10_000 },
      { kind: 'harness', stage: 'result', ts: '2026-07-29T12:00:30.000Z', durationMs: 5_000 }
    ]

    expect(canonicalOrObservedTurnTiming(events, 'qoder', 'completed')).toEqual({
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:30.000Z',
      durationMs: 30_000
    })
  })

  it('OpenCode 使用 opencode_server 提交 live canonical turn', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManagedOpenCode(workspace)
    const request = asOpenCode(input(workspace, userDataDir))

    await expect(commitManagedTraceTurn(request)).resolves.toMatchObject({ recorder: 'committed' })
    expect(readTraceArchive({
      cwd: workspace,
      sessionId: request.sessionId,
      providerId: 'opencode',
      userDataDir
    })?.runtimeProvider).toBe('opencode_server')
    const [record] = await listRecords(join(workspace, '.scry'))
    expect(record).toMatchObject({ provider: { id: 'opencode' }, providerTurnId: 'turn-1' })
  })

  it('OpenCode 拒绝错误 runtime provider', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = asOpenCode(input(workspace, userDataDir))
    request.runtimeProvider = 'codex_cli'

    await expect(commitManagedTraceTurn(request)).rejects.toThrow(
      'managed recorder Provider id differs from runtime provider'
    )
  })

  it('OpenCode failed 无 Provider turn id 时可用 observed timing 直接提交并从 progress 恢复', async () => {
    const failedRequest = (workspace: string, userDataDir: string): ManagedTraceTurnCommitInput => {
      const request = asOpenCode(input(workspace, userDataDir))
      request.providerTurnId = undefined
      request.status = 'failed'
      request.turn = {
        ...request.turn,
        providerTurnId: undefined,
        status: 'failed',
        items: [],
        turnEvidence: aggregateTurnEvidence({
          userText: request.turn.userText,
          events: [],
          source: 'scry_provider_adapter'
        })
      }
      return request
    }

    const live = await fixture()
    await startManagedOpenCode(live.workspace)
    await expect(commitManagedTraceTurn(failedRequest(live.workspace, live.userDataDir)))
      .resolves.toMatchObject({ recorder: 'committed' })

    const recovered = await fixture()
    await startManagedOpenCode(recovered.workspace)
    await persistManagedTraceProgress(failedRequest(recovered.workspace, recovered.userDataDir))
    await expect(recoverManagedTraceProgress(recovered.userDataDir, {
      cwd: recovered.workspace,
      providerId: 'opencode',
      waitMs: 100
    })).resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
    const [record] = await listRecords(join(recovered.workspace, '.scry'))
    expect(record).toMatchObject({ provider: { id: 'opencode' }, status: 'failed' })
    expect(record.providerTurnId).toBeUndefined()
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

  it('managed commit 只使用显式授予的 commitHook capability 唤醒 uploader', async () => {
    const { workspace, userDataDir } = await fixture()
    const hookDir = join(userDataDir, 'trusted-hook')
    const hook = join(hookDir, 'record-committed.sh')
    const capture = join(workspace, 'record-committed.jsonl')
    await mkdir(hookDir, { recursive: true })
    await writeFile(hook, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\n`)
    await chmod(hook, 0o700)
    await startManaged(workspace)

    await expect(commitManagedTraceTurn(input(workspace, userDataDir), {
      commitHookEnv: {
        ...process.env,
        SCRY_RECORDER_COMMIT_HOOK: hook,
        SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'test-grant-v1'
      }
    })).resolves.toMatchObject({ recorder: 'committed' })

    await expect(notificationLine(capture, workspace, 'test-grant-v1')).resolves.toMatchObject({
      schemaVersion: 2,
      event: 'record-committed',
      recordPath: expect.stringMatching(/^records\/\d{20}-[a-f0-9]+\.json$/),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      workspace,
      provider: 'codex',
      sessionId: 'session-1',
      sequence: 1
    })
  })

  it('冷启动 recovery scope 按 cwd/provider 去重且 capability env 不落入 progress', async () => {
    const { workspace, userDataDir } = await fixture()
    const request = input(workspace, userDataDir)
    await persistManagedTraceProgress(request)

    expect(await managedRecoveryScopes(userDataDir)).toEqual([{ cwd: workspace, providerId: 'codex' }])
    const progressDir = join(userDataDir, 'managed-turn-progress')
    const persisted = JSON.parse(await readFile(join(progressDir, readdirSync(progressDir)[0]!), 'utf8'))
    expect(JSON.stringify(persisted)).not.toContain('SCRY_RECORDER_COMMIT_HOOK')
  })

  it('冷启动 progress recovery 使用内存中的已授权 capability env', async () => {
    const { workspace, userDataDir } = await fixture()
    const hook = join(userDataDir, 'trusted-recovery-hook.sh')
    const capture = join(userDataDir, 'recovery-notification.jsonl')
    await writeFile(hook, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\n`)
    await chmod(hook, 0o700)
    await startManaged(workspace)
    await persistManagedTraceProgress(input(workspace, userDataDir))

    await expect(recoverManagedTraceProgress(userDataDir, {
      cwd: workspace,
      providerId: 'codex',
      waitMs: 0,
      commitHookEnv: {
        ...process.env,
        SCRY_RECORDER_COMMIT_HOOK: hook,
        SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'startup-grant-v1'
      }
    })).resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
    await expect(notificationLine(capture, workspace, 'startup-grant-v1')).resolves.toMatchObject({ workspace, provider: 'codex' })
  })
}
