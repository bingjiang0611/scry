import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { drainCommitNotifications, listRecords, readHealth, safeKey, stableHash } from './store'
import { recorderSessionLock } from './runtime-state'

const faults = vi.hoisted(() => ({ finalize: false, pendingHealth: false }))
vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>()
  return {
    ...actual,
    commitRecord: (...args: Parameters<typeof actual.commitRecord>) => {
      if (faults.finalize && args[1].sessionId === 's1') throw new Error('injected s1 finalize failure')
      return actual.commitRecord(...args)
    }
  }
})
vi.mock('./runtime-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime-state')>()
  return {
    ...actual,
    recorderPendingHealth: (...args: Parameters<typeof actual.recorderPendingHealth>) => {
      if (faults.pendingHealth) throw new Error('injected recovery health failure')
      return actual.recorderPendingHealth(...args)
    }
  }
})

const roots: string[] = []
afterEach(async () => {
  faults.finalize = false
  faults.pendingHealth = false
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-recovery-isolation-'))
  roots.push(root)
  const capture = join(root, 'notifications.jsonl')
  const hook = join(root, 'commit-hook.sh')
  const failure = join(root, 'fail-hook')
  await writeFile(hook, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\nif [ -f ${JSON.stringify(failure)} ]; then exit 7; fi\n`)
  await chmod(hook, 0o700)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'recovery-fixture', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true },
    commitHook: { entry: 'commit-hook.sh', files: ['commit-hook.sh'] }
  }))
  const dataRoot = join(root, '.scry')
  const seed = async (provider: 'claude' | 'codex' | 'qoder', sessionId: string, deferDelivery = false) => {
    await handleRecorderHook({
      provider, event: 'UserPromptSubmit', workspace: root, env: {}, deferDelivery,
      payload: { session_id: sessionId, prompt: sessionId, timestamp: '2026-10-24T12:00:00.000Z' }
    })
    const path = join(dataRoot, 'runtime', provider, safeKey(sessionId), 'open.json')
    const open = JSON.parse(await readFile(path, 'utf8'))
    // Seed an observed terminal boundary; no elapsed-time inference or real Provider is involved.
    await writeFile(path, JSON.stringify({
      ...open, status: 'closing', closingAt: '2026-10-24T12:00:01.000Z',
      terminalAt: '2026-10-24T12:00:01.000Z', terminalAtSource: 'provider_terminal_event'
    }))
    return path
  }
  return { root, dataRoot, capture, hook, failure, seed }
}

async function notifications(path: string): Promise<Array<{ sessionId: string }>> {
  return (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
}

async function directorySnapshot(path: string): Promise<Array<[string, string]>> {
  return Promise.all((await readdir(path)).sort().map(async (name) => [name, await readFile(join(path, name), 'utf8')] as const))
}

describe('recorder recovery session isolation', () => {
  it('continues after S1 finalize fails, commits S2 and drains its trusted callback', async () => {
    const f = await fixture()
    // runtimeSessions visits Claude before Codex, independent of filesystem entry order.
    const first = await f.seed('claude', 's1')
    await f.seed('codex', 's2')
    faults.finalize = true
    await expect.soft(recoverRecorder(f.root, {})).resolves.toMatchObject({ recovered: 1, pending: 1 })
    expect.soft((await listRecords(f.dataRoot)).map((record) => record.sessionId)).toEqual(['s2'])
    expect(JSON.parse(await readFile(first, 'utf8')).status).toBe('closing')
    await expect.soft(notifications(f.capture)).resolves.toEqual([expect.objectContaining({ sessionId: 's2' })])
    expect(await readHealth(f.dataRoot)).toMatchObject({
      pendingCount: 1, droppedEvents: 0,
      lastError: { at: expect.any(String), message: expect.stringContaining('s1 finalize failure') }
    })
    expect(await readFile(join(f.dataRoot, 'logs', 'recorder.log'), 'utf8')).toContain('s1 finalize failure')
    faults.finalize = false
    await expect(recoverRecorder(f.root, {})).resolves.toMatchObject({ recovered: 1, pending: 0 })
    expect((await notifications(f.capture)).map((item) => item.sessionId)).toEqual(['s2', 's1'])
  })

  it('counts a live session lock deadline as pending and continues with S2', async () => {
    const f = await fixture()
    await f.seed('claude', 's1')
    await f.seed('codex', 's2')
    const lock = recorderSessionLock(f.dataRoot, 'claude', 's1')
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'held-by-test' }))
    await expect(recoverRecorder(f.root, {})).resolves.toMatchObject({ recovered: 1, pending: 1 })
    expect((await listRecords(f.dataRoot)).map((record) => record.sessionId)).toEqual(['s2'])
    expect(await notifications(f.capture)).toEqual([expect.objectContaining({ sessionId: 's2' })])
    expect((await readHealth(f.dataRoot)).droppedEvents).toBe(0)
  }, 15_000) // The production session-lock deadline is 10 seconds; do not shorten it in this test.

  it('drains already committed notifications even when the final health refresh throws', async () => {
    const f = await fixture()
    await f.seed('codex', 's2')
    faults.pendingHealth = true
    await expect(recoverRecorder(f.root, {})).rejects.toThrow('injected recovery health failure')
    expect((await listRecords(f.dataRoot)).map((record) => record.sessionId)).toEqual(['s2'])
    expect(await notifications(f.capture)).toEqual([expect.objectContaining({ sessionId: 's2' })])
  })

  it('scoped Qoder recovery leaves another session open, inbox, and notification untouched', async () => {
    const f = await fixture()
    await f.seed('qoder', 'notification-session')
    await expect(recoverRecorder(f.root, {})).resolves.toMatchObject({ recovered: 1, pending: 0 })
    const beforeNotifications = await readFile(f.capture, 'utf8')

    const otherOpen = await f.seed('qoder', 'other-session')
    await handleRecorderHook({
      provider: 'qoder', event: 'Stop', workspace: f.root, env: {}, queueOnly: true,
      payload: { session_id: 'other-session', timestamp: '2026-10-24T12:00:02.000Z' }
    })
    const otherInbox = join(f.dataRoot, 'runtime', 'qoder', safeKey('other-session'), 'inbox')
    const beforeOtherOpen = await readFile(otherOpen, 'utf8')
    const beforeOtherInbox = await Promise.all((await readdir(otherInbox)).map(async (name) => [name, await readFile(join(otherInbox, name), 'utf8')] as const))

    await f.seed('qoder', 'target-session')
    await expect(recoverRecorder(f.root, {}, undefined, { provider: 'qoder', sessionId: 'target-session' }))
      .resolves.toMatchObject({ recovered: 1, pending: 0 })

    expect((await listRecords(f.dataRoot)).map((record) => record.sessionId)).toEqual(['notification-session', 'target-session'])
    expect((await notifications(f.capture)).map((item) => item.sessionId)).toEqual(['notification-session', 'target-session'])
    expect(await readFile(otherOpen, 'utf8')).toBe(beforeOtherOpen)
    expect(await Promise.all((await readdir(otherInbox)).map(async (name) => [name, await readFile(join(otherInbox, name), 'utf8')] as const))).toEqual(beforeOtherInbox)
    expect(await readFile(f.capture, 'utf8')).not.toBe(beforeNotifications)
    expect((await listRecords(f.dataRoot)).some((record) => record.sessionId === 'other-session')).toBe(false)
    await expect(recoverRecorder(f.root, {}, undefined, { provider: 'qoder', sessionId: 'target-session' }))
      .resolves.toMatchObject({ recovered: 0, pending: 0 })
    expect((await notifications(f.capture)).map((item) => item.sessionId)).toEqual(['notification-session', 'target-session'])
  })

  it('scoped recovery skips a real other-session retry without changing its evidence or checkpoint', async () => {
    const f = await fixture()
    const fingerprint = 'scoped-retry'
    const env = { SCRY_RECORDER_COMMIT_HOOK: f.hook, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: fingerprint }
    await f.seed('qoder', 'other-session')
    await writeFile(f.failure, '')
    await expect(recoverRecorder(f.root, env)).resolves.toMatchObject({ recovered: 1 })
    const [otherRecord] = await listRecords(f.dataRoot)
    const outcomePath = join(f.dataRoot, 'notifications', 'delivery-outcomes', stableHash(fingerprint), `${String(otherRecord.sequence).padStart(20, '0')}.json`)
    const checkpointPath = join(f.dataRoot, 'notifications', 'commit-hooks', `${stableHash(fingerprint)}.json`)
    const beforeOutcome = await readFile(outcomePath, 'utf8')
    const beforeCheckpoint = await readFile(checkpointPath, 'utf8')

    const otherOpen = await f.seed('qoder', 'other-session', true)
    await handleRecorderHook({
      provider: 'qoder', event: 'Stop', workspace: f.root, env, queueOnly: true,
      payload: { session_id: 'other-session', timestamp: '2026-10-24T12:00:02.000Z' }
    })
    const otherInbox = join(f.dataRoot, 'runtime', 'qoder', safeKey('other-session'), 'inbox')
    const beforeOtherOpen = await readFile(otherOpen, 'utf8')
    const beforeOtherInbox = await directorySnapshot(otherInbox)
    await f.seed('qoder', 'target-session', true)
    await rm(f.failure)
    await expect(recoverRecorder(f.root, env, undefined, { provider: 'qoder', sessionId: 'target-session' }))
      .resolves.toMatchObject({ recovered: 1 })

    expect(await readFile(otherOpen, 'utf8')).toBe(beforeOtherOpen)
    expect(await directorySnapshot(otherInbox)).toEqual(beforeOtherInbox)
    expect(await readFile(outcomePath, 'utf8')).toBe(beforeOutcome)
    expect(await readFile(checkpointPath, 'utf8')).toBe(beforeCheckpoint)
    expect((await notifications(f.capture)).map((item) => item.sessionId)).toEqual(['other-session', 'target-session'])
    const afterTarget = await readFile(f.capture, 'utf8')
    await expect(recoverRecorder(f.root, env, undefined, { provider: 'qoder', sessionId: 'target-session' }))
      .resolves.toMatchObject({ recovered: 0 })
    expect(await readFile(f.capture, 'utf8')).toBe(afterTarget)
  })

  it('scoped recovery refuses legacy migration without changing the shared state', async () => {
    const f = await fixture()
    const fingerprint = 'scoped-legacy'
    const env = { SCRY_RECORDER_COMMIT_HOOK: f.hook, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: fingerprint }
    const legacyPath = join(f.dataRoot, 'notifications', 'commit-hook-state.json')
    await f.seed('qoder', 'target-session', true)
    await expect(recoverRecorder(f.root, env)).resolves.toMatchObject({ recovered: 1 })
    const checkpointPath = join(f.dataRoot, 'notifications', 'commit-hooks', `${stableHash(fingerprint)}.json`)
    const beforeCheckpoint = await readFile(checkpointPath, 'utf8')
    const original = JSON.stringify({ schemaVersion: 1, hookFingerprint: fingerprint, ackedThrough: 2 })
    await mkdir(join(f.dataRoot, 'notifications'), { recursive: true })
    await writeFile(legacyPath, original)

    await expect(drainCommitNotifications(f.dataRoot, env, { scope: { provider: 'qoder', sessionId: 'target-session' } }))
      .rejects.toThrow('manual unscoped migration')
    expect(await readFile(legacyPath, 'utf8')).toBe(original)
    expect(await readFile(checkpointPath, 'utf8')).toBe(beforeCheckpoint)
    expect((await notifications(f.capture)).map((item) => item.sessionId)).toEqual(['target-session'])

    await drainCommitNotifications(f.dataRoot, env)
    const migratedCheckpoint = await readFile(checkpointPath, 'utf8')
    expect(JSON.parse(migratedCheckpoint).queueVersion).toBe(2)
    expect(JSON.parse(migratedCheckpoint).ackedThrough).toBe(2)
    await expect(drainCommitNotifications(f.dataRoot, env, { scope: { provider: 'qoder', sessionId: 'target-session' } }))
      .resolves.toMatchObject({ delivered: 0 })
    expect(await readFile(legacyPath, 'utf8')).toBe(original)
    expect(await readFile(checkpointPath, 'utf8')).toBe(migratedCheckpoint)
  })

  it.each([false, true])('scoped recovery does not finalize an open marker with another identity (queued Stop: %s)', async (queueStop) => {
    const f = await fixture()
    const openPath = await f.seed('qoder', 'target-session')
    const otherOpen = await f.seed('qoder', 'other-session', true)
    const beforeOtherOpen = await readFile(otherOpen, 'utf8')
    const inbox = join(f.dataRoot, 'runtime', 'qoder', safeKey('target-session'), 'inbox')
    if (queueStop) {
      await handleRecorderHook({
        provider: 'qoder', event: 'Stop', workspace: f.root, env: {}, queueOnly: true,
        payload: { session_id: 'target-session', timestamp: '2026-10-24T12:00:02.000Z' }
      })
    }
    const beforeInbox = queueStop ? await directorySnapshot(inbox) : undefined
    const before = await readFile(openPath, 'utf8')
    await writeFile(openPath, JSON.stringify({ ...JSON.parse(before), sessionId: 'other-session' }))
    const mismatched = await readFile(openPath, 'utf8')

    await expect(recoverRecorder(f.root, {}, undefined, { provider: 'qoder', sessionId: 'target-session' }))
      .resolves.toMatchObject({ recovered: 0, pending: 1 })
    expect(await readFile(openPath, 'utf8')).toBe(mismatched)
    expect(await readFile(otherOpen, 'utf8')).toBe(beforeOtherOpen)
    if (queueStop) expect(await directorySnapshot(inbox)).toEqual(beforeInbox)
    expect(await listRecords(f.dataRoot)).toEqual([])
    expect(await readFile(join(f.dataRoot, 'logs', 'recorder.log'), 'utf8')).toContain('open identity differs')
  })

  it('scoped inbox recovery rejects a queued event with another session identity without quarantining it', async () => {
    const f = await fixture()
    await f.seed('qoder', 'target-session', true)
    await handleRecorderHook({
      provider: 'qoder', event: 'Stop', workspace: f.root, env: {}, queueOnly: true,
      payload: { session_id: 'target-session', timestamp: '2026-10-24T12:00:02.000Z' }
    })
    const inbox = join(f.dataRoot, 'runtime', 'qoder', safeKey('target-session'), 'inbox')
    const [name] = await readdir(inbox)
    const path = join(inbox, name)
    const before = await readFile(path, 'utf8')
    await writeFile(path, JSON.stringify({ ...JSON.parse(before), sessionId: 'other-session' }))
    const mismatched = await readFile(path, 'utf8')

    await expect(recoverRecorder(f.root, {}, undefined, { provider: 'qoder', sessionId: 'target-session' }))
      .resolves.toMatchObject({ recovered: 0, pending: 1 })
    expect(await readFile(path, 'utf8')).toBe(mismatched)
    expect(await readFile(join(f.dataRoot, 'logs', 'recorder.log'), 'utf8')).toContain('inbox identity differs')
  })

  it('scoped delivery rejects a damaged canonical record instead of treating it as another session', async () => {
    const f = await fixture()
    const fingerprint = 'scoped-corrupt'
    const env = { SCRY_RECORDER_COMMIT_HOOK: f.hook, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: fingerprint }
    await f.seed('qoder', 'target-session', true)
    await writeFile(f.failure, '')
    await expect(recoverRecorder(f.root, env)).resolves.toMatchObject({ recovered: 1 })
    const [record] = await listRecords(f.dataRoot)
    const recordPath = join(f.dataRoot, 'records', `${String(record.sequence).padStart(20, '0')}-${record.recordId}.json`)
    const checkpointPath = join(f.dataRoot, 'notifications', 'commit-hooks', `${stableHash(fingerprint)}.json`)
    const beforeCheckpoint = await readFile(checkpointPath, 'utf8')
    const outcome = JSON.parse(await readFile(join(f.dataRoot, 'notifications', 'delivery-outcomes', stableHash(fingerprint), `${String(record.sequence).padStart(20, '0')}.json`), 'utf8'))
    outcome.failure.lastFailureAt = '2000-01-01T00:00:00.000Z'
    await writeFile(join(f.dataRoot, 'notifications', 'delivery-outcomes', stableHash(fingerprint), `${String(record.sequence).padStart(20, '0')}.json`), JSON.stringify(outcome))
    await writeFile(recordPath, '{broken canonical record')

    await expect(drainCommitNotifications(f.dataRoot, env, { scope: { provider: 'qoder', sessionId: 'target-session' } }))
      .rejects.toThrow()
    expect(await readFile(checkpointPath, 'utf8')).toBe(beforeCheckpoint)
  })
})
