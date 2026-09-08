import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { recorderSessionRoot, recorderStatePath } from '../core/turn-recorder/runtime-state'
import { listRecords, safeKey, stableHash } from '../core/turn-recorder/store'
import { readTraceArchive } from './transcript-archive'
import { commitManagedTraceTurn, persistManagedTraceProgress, recoverManagedTraceProgress, recoverManagedTraceTurns, type ManagedTraceTurnCommitInput } from './managed-turn-commit'
import type { TraceEvent } from '../shared/trace'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(): Promise<ManagedTraceTurnCommitInput> {
  const root = await mkdtemp(join(tmpdir(), 'scry-qoder-interruption-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  const userDataDir = join(root, 'userData')
  await mkdir(cwd)
  await writeFile(join(cwd, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'interruption-test', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  const timing = { startedAt: '2026-09-08T11:15:34.170Z', completedAt: '2026-09-08T11:15:36.436Z', durationMs: 2266 }
  const items: TraceEvent[] = [{ id: 'controls', runId: 'run-early-stop', ts: timing.startedAt, kind: 'harness', stage: 'runtime:controls' }]
  return {
    cwd, userDataDir, sessionId: 'resumed-native-session', providerId: 'qoder', runtimeProvider: 'qoder_cli',
    status: 'interrupted', timing,
    turn: {
      runId: 'run-early-stop', userText: 'test prompt', items, done: true, status: 'interrupted', ...timing,
      ts: Date.parse(timing.completedAt),
      turnEvidence: aggregateTurnEvidence({ userText: 'test prompt', events: items, source: 'scry_provider_adapter' })
    }
  }
}

function addEvent(request: ManagedTraceTurnCommitInput, event: Partial<TraceEvent>): void {
  request.turn.items.push({ id: 'event', runId: request.turn.runId, ts: request.timing.completedAt, kind: 'harness', stage: 'unknown', ...event })
  request.turn.turnEvidence = aggregateTurnEvidence({ userText: request.turn.userText, events: request.turn.items, source: 'scry_provider_adapter' })
}

describe('Qoder stop before native recorder open', () => {
  it('preserves an interrupted attempt in both stores without inventing a Provider ID, output or usage', async () => {
    const request = await fixture()
    await expect(commitManagedTraceTurn(request, { waitMs: 0 })).resolves.toMatchObject({ recorder: 'committed' })
    const [record] = await listRecords(join(request.cwd, '.scry'))
    expect(record).toMatchObject({ status: 'interrupted', durationMs: 2266, generation: 1, turnIndex: 1 })
    expect(record.providerTurnId).toBeUndefined()
    expect(record.assistant.value?.text).toBeUndefined()
    expect(record.usage.status).toBe('unavailable')
    expect(record.termination).toMatchObject({ status: 'partial', quality: 'estimated', source: ['scry_run_boundary'] })
    expect(record.termination?.omissionReason).toContain('no Provider lifecycle start')
    const archive = readTraceArchive(request)
    expect(archive?.turns[0]).toMatchObject({ status: 'interrupted', durationMs: 2266 })
    expect(record.user).toEqual(archive?.turns[0].turnEvidence?.user)
    expect(record.diff).toEqual(archive?.turns[0].turnEvidence?.diff)
    await expect(commitManagedTraceTurn(request, { waitMs: 0 })).resolves.toMatchObject({ recorder: 'committed' })
    expect(await listRecords(join(request.cwd, '.scry'))).toHaveLength(1)
  })

  it('reserves distinct generations for later attempts even after the session cache is lost', async () => {
    const request = await fixture()
    await commitManagedTraceTurn(request, { waitMs: 0 })
    await rm(recorderStatePath(recorderSessionRoot(join(request.cwd, '.scry'), 'qoder', request.sessionId)))
    const next = { ...request, turn: { ...request.turn, runId: 'run-next', items: request.turn.items.map((item) => ({ ...item, runId: 'run-next' })) } }
    await commitManagedTraceTurn(next, { waitMs: 0 })
    const records = await listRecords(join(request.cwd, '.scry'))
    expect(records.map((record) => record.generation).sort()).toEqual([1, 2])
    expect(records.map((record) => record.turnIndex).sort()).toEqual([1, 2])
    expect(new Set(records.map((record) => record.recordId)).size).toBe(2)
  })

  it('recovers the old stuck progress + prepared journal once, then admits the next recovery', async () => {
    const request = await fixture()
    // The screenshot's rich journal includes both local diff finalizers, not just
    // the controls-only early progress snapshot. Neither is a Provider lifecycle.
    for (const stage of ['turn_diff', 'session_diff']) {
      addEvent(request, { stage, turnDiff: {
        version: 1, status: 'captured', files: [], beforeAt: request.timing.startedAt,
        afterAt: request.timing.completedAt, captureMs: 1, cleanup: 'ok'
      } })
    }
    await persistManagedTraceProgress(request)
    const artifact = JSON.parse(await readFile(join(request.userDataDir, 'managed-turn-progress', `${safeKey(request.turn.runId)}.json`), 'utf8'))
    const journalRoot = join(request.userDataDir, 'managed-turn-commits')
    await mkdir(journalRoot, { recursive: true })
    await writeFile(join(journalRoot, `${safeKey(request.turn.runId)}.json`), JSON.stringify({
      schemaVersion: 1, phase: 'prepared', request: artifact.request, archiveFingerprint: stableHash(artifact.request)
    }))
    await expect(recoverManagedTraceTurns(request.userDataDir, { waitMs: 0 })).resolves.toEqual({ recovered: 1, pending: 0, errors: [] })
    await expect(recoverManagedTraceProgress(request.userDataDir, { waitMs: 0 })).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
    await expect(recoverManagedTraceTurns(request.userDataDir, { waitMs: 0 })).resolves.toEqual({ recovered: 0, pending: 0, errors: [] })
    expect(await listRecords(join(request.cwd, '.scry'))).toHaveLength(1)
  })

  it.each([
    { kind: 'model' as const, stage: 'text_delta', text: 'observed output' },
    { kind: 'tool' as const, stage: 'tool_result', tool: 'Read' },
    { kind: 'hook' as const, stage: 'hook_started' },
    { kind: 'harness' as const, stage: 'result' },
    { kind: 'harness' as const, stage: 'runtime:unknown' }
  ])('keeps missing lifecycle pending when $kind/$stage was observed', async (event) => {
    const request = await fixture()
    addEvent(request, event)
    await expect(commitManagedTraceTurn(request, { waitMs: 0 })).rejects.toThrow('open identity')
    expect(await listRecords(join(request.cwd, '.scry'))).toHaveLength(0)
  })

  it('never replaces another run’s open lifecycle', async () => {
    const request = await fixture()
    await handleRecorderHook({
      workspace: request.cwd, provider: 'qoder', event: 'UserPromptSubmit', managed: true,
      payload: { session_id: request.sessionId, prompt: 'different prompt', timestamp: request.timing.startedAt }
    })
    await expect(commitManagedTraceTurn(request, { waitMs: 0 })).rejects.toThrow('differs from the open lifecycle')
    expect(await listRecords(join(request.cwd, '.scry'))).toHaveLength(0)
  })

  it('does not recover a completed turn or a turn with native identity from a host-only trace', async () => {
    const request = await fixture()
    request.providerTurnId = request.turn.providerTurnId = 'native-turn'
    await expect(commitManagedTraceTurn(request, { waitMs: 0 })).rejects.toThrow('open identity')
    const completed = await fixture()
    completed.status = completed.turn.status = 'completed'
    await expect(commitManagedTraceTurn(completed, { waitMs: 0 })).rejects.toThrow('authoritative Provider turn id')
  })
})
