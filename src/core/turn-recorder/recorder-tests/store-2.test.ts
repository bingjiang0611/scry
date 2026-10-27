import { mkdir, writeFile, readdir, readFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect, vi } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { commitNotificationStatus, drainCommitNotifications, listRecords, commitRecord, redeliverLatestCommitNotification, safeKey, readHealth, exportRecords, verifyStore } from '../store'
import { workspace, completeTurn, commitHook, commitAckPath, payload } from './fixture.test'

export function registerSuite14(): void {


  it('legacy ACK migration survives old App writes without rewriting its shared file', async () => {
    const root = await workspace()
    await completeTurn(root, 'migration-a')
    await completeTurn(root, 'migration-b')
    const hook = await commitHook(root)
    const dataRoot = join(root, '.scry')
    const directory = join(dataRoot, 'notifications')
    const legacyPath = join(directory, 'commit-hook-state.json')
    const a = { PATH: '/usr/bin:/bin', SCRY_RECORDER_COMMIT_HOOK: hook.path, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'cli-bundle' }
    const b = { ...a, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'sha256:old-app' }
    await mkdir(directory, { recursive: true })
    const original = JSON.stringify({ schemaVersion: 1, hookFingerprint: 'cli-bundle', ackedThrough: 2 })
    await writeFile(legacyPath, original)
    await expect(commitNotificationStatus(dataRoot, a)).resolves.toEqual({ ackedThrough: 2, notifyBacklog: 0 })
    expect(await readdir(directory)).toEqual(['commit-hook-state.json'])
    await expect(drainCommitNotifications(dataRoot, a)).resolves.toMatchObject({ delivered: 0, pending: 0 })
    expect(await readFile(legacyPath, 'utf8')).toBe(original)

    // An old App remains free to own the v1 file; it must not erase the CLI checkpoint.
    const appState = JSON.stringify({ schemaVersion: 1, hookFingerprint: 'sha256:old-app', ackedThrough: 1 })
    await writeFile(legacyPath, appState)
    await expect(commitNotificationStatus(dataRoot, a)).resolves.toEqual({ ackedThrough: 2, notifyBacklog: 0 })
    await expect(drainCommitNotifications(dataRoot, a)).resolves.toMatchObject({ delivered: 0, pending: 0 })
    expect(await readFile(legacyPath, 'utf8')).toBe(appState)
    await expect(drainCommitNotifications(dataRoot, b)).resolves.toMatchObject({ delivered: 1, pending: 0 })
    expect(await readFile(legacyPath, 'utf8')).toBe(appState)
    await expect(commitNotificationStatus(dataRoot, a)).resolves.toEqual({ ackedThrough: 2, notifyBacklog: 0 })
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('same-identity legacy progress is merged monotonically, never borrowed by another bundle', async () => {
    const root = await workspace()
    await completeTurn(root, 'monotonic-a')
    await completeTurn(root, 'monotonic-b')
    const hook = await commitHook(root)
    const dataRoot = join(root, '.scry')
    const env = { PATH: '/usr/bin:/bin', SCRY_RECORDER_COMMIT_HOOK: hook.path, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: '../opaque/bundle' }
    await drainCommitNotifications(dataRoot, env, { maxRecords: 1 })
    const legacyPath = join(dataRoot, 'notifications', 'commit-hook-state.json')
    const legacy = (ackedThrough: number) => JSON.stringify({ schemaVersion: 1, hookFingerprint: env.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT, ackedThrough })
    await writeFile(legacyPath, legacy(2))
    await expect(drainCommitNotifications(dataRoot, env)).resolves.toMatchObject({ delivered: 0, pending: 0 })
    await writeFile(legacyPath, legacy(1))
    await expect(commitNotificationStatus(dataRoot, env)).resolves.toEqual({ ackedThrough: 2, notifyBacklog: 0 })
    await expect(commitNotificationStatus(dataRoot, { ...env, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'new-bundle' }))
      .resolves.toEqual({ ackedThrough: null, notifyBacklog: 2 })
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('concurrent same and different identities do not duplicate or erase acknowledged deliveries', async () => {
    const root = await workspace()
    await completeTurn(root, 'concurrent-a')
    await completeTurn(root, 'concurrent-b')
    const hook = await commitHook(root)
    const dataRoot = join(root, '.scry')
    const a = { PATH: '/usr/bin:/bin', SCRY_RECORDER_COMMIT_HOOK: hook.path, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'a' }
    const b = { ...a, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'b' }
    const results = await Promise.all([a, b, a].map(env => drainCommitNotifications(dataRoot, env)))
    // The bounded lock may legitimately time out while another identity delivers.
    // Only that diagnosed contention may defer work to an explicit recovery drain.
    if (results.some(result => result.pending > 0)) {
      expect(await readFile(join(dataRoot, 'logs', 'recorder.log'), 'utf8')).toContain('lock timeout:')
    } else {
      expect(results.map(result => result.delivered).sort()).toEqual([0, 2, 2])
    }
    const recovered = []
    for (const env of [a, b]) recovered.push(await drainCommitNotifications(dataRoot, env))
    expect(recovered.every(result => result.pending === 0)).toBe(true)
    expect([...results, ...recovered].every(result => result.truncated === false)).toBe(true)
    expect([...results, ...recovered].map(result => result.delivered).sort()).toEqual([0, 0, 0, 2, 2])
    for (const env of [a, b]) {
      await expect(commitNotificationStatus(dataRoot, env)).resolves.toEqual({ ackedThrough: 2, notifyBacklog: 0 })
    }
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(4)
    await expect(access(join(dataRoot, 'notifications', 'commit-hook-state.json'))).rejects.toThrow()
  })

  it('retains pending notifications on a live lock deadline and delivers them once on explicit recovery', async () => {
    const root = await workspace()
    await completeTurn(root, 'lock-contention')
    const hook = await commitHook(root)
    const dataRoot = join(root, '.scry')
    const env = { PATH: '/usr/bin:/bin', SCRY_RECORDER_COMMIT_HOOK: hook.path }
    const lockDir = join(dataRoot, 'locks', 'commit-notification.lock')
    await mkdir(lockDir, { recursive: true })
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'live-test-owner' }))
    // Advance the lock deadline, not callback timers; no sleep or real 2s wait.
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 2_001)
    try {
      await expect(drainCommitNotifications(dataRoot, env)).resolves.toEqual({ delivered: 0, pending: 1, truncated: false })
      expect(await readFile(join(dataRoot, 'logs', 'recorder.log'), 'utf8')).toContain('lock timeout:')
      await expect(commitNotificationStatus(dataRoot, env)).resolves.toEqual({ ackedThrough: null, notifyBacklog: 1 })
      await expect(access(hook.capture)).rejects.toThrow()
      expect(JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')).token).toBe('live-test-owner')
    } finally {
      clock.mockRestore()
      await rm(lockDir, { recursive: true })
    }
    await expect(drainCommitNotifications(dataRoot, env)).resolves.toEqual({ delivered: 1, pending: 0, truncated: false })
    await expect(drainCommitNotifications(dataRoot, env)).resolves.toEqual({ delivered: 0, pending: 0, truncated: false })
    await expect(commitNotificationStatus(dataRoot, env)).resolves.toEqual({ ackedThrough: 1, notifyBacklog: 0 })
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('migration preserves known ACK but a failing callback cannot advance either file', async () => {
    const root = await workspace()
    await completeTurn(root, 'migration-fail-a')
    await completeTurn(root, 'migration-fail-b')
    const hook = await commitHook(root, 7)
    const dataRoot = join(root, '.scry')
    const directory = join(dataRoot, 'notifications')
    await mkdir(directory, { recursive: true })
    const original = JSON.stringify({ schemaVersion: 1, hookFingerprint: 'migration', ackedThrough: 1 })
    const legacyPath = join(directory, 'commit-hook-state.json')
    await writeFile(legacyPath, original)
    const env = { PATH: '/usr/bin:/bin', SCRY_RECORDER_COMMIT_HOOK: hook.path, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'migration' }
    await expect(drainCommitNotifications(dataRoot, env)).resolves.toEqual({ delivered: 0, pending: 1, truncated: false })
    expect(JSON.parse(await readFile(commitAckPath(root, 'migration'), 'utf8')).ackedThrough).toBe(1)
    expect(await readFile(legacyPath, 'utf8')).toBe(original)
    await expect(commitNotificationStatus(dataRoot, env)).resolves.toMatchObject({
      ackedThrough: 1, notifyBacklog: 1, failure: { sequence: 2, attempts: 1 }
    })
  })

  it.each([
    { schemaVersion: 2, ackedThrough: 1 },
    { schemaVersion: 1, ackedThrough: -1 },
    { schemaVersion: 1, ackedThrough: 1.5 }
  ])('invalid legacy checkpoints never skip notifications: %j', async invalid => {
    const root = await workspace()
    await completeTurn(root, 'invalid-checkpoint')
    const hook = await commitHook(root)
    const dataRoot = join(root, '.scry')
    await mkdir(join(dataRoot, 'notifications'), { recursive: true })
    await writeFile(join(dataRoot, 'notifications', 'commit-hook-state.json'), JSON.stringify({
      ...invalid, hookFingerprint: 'explicit-environment-v1'
    }))
    const env = { PATH: '/usr/bin:/bin', SCRY_RECORDER_COMMIT_HOOK: hook.path }
    await expect(commitNotificationStatus(dataRoot, env)).resolves.toEqual({ ackedThrough: null, notifyBacklog: 1 })
    await expect(drainCommitNotifications(dataRoot, env)).resolves.toEqual({ delivered: 1, pending: 0, truncated: false })
  })

  it('duplicate commit 只重试既有未 ACK 通知，不创建第二条 sequence', async () => {
    const root = await workspace()
    await completeTurn(root, 'notify-duplicate')
    const [record] = await listRecords(join(root, '.scry'))
    const { sequence: _sequence, ...draft } = record
    const hook = await commitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }

    await expect(commitRecord(join(root, '.scry'), draft)).resolves.toMatchObject({ status: 'duplicate', record: { sequence: 1 } })
    await expect(drainCommitNotifications(join(root, '.scry'), env)).resolves.toEqual({ delivered: 1, pending: 0, truncated: false })
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
    await expect(drainCommitNotifications(join(root, '.scry'), env)).resolves.toEqual({ delivered: 0, pending: 0, truncated: false })
  })

  it('冷启动只重投最新正式 record，不改写已推进的 ACK', async () => {
    const root = await workspace()
    await completeTurn(root, 'redeliver-1')
    await completeTurn(root, 'redeliver-2')
    const hook = await commitHook(root)
    const env = {
      ...process.env,
      SCRY_RECORDER_COMMIT_HOOK: hook.path,
      SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'redelivery-test-v1'
    }
    await expect(drainCommitNotifications(join(root, '.scry'), env)).resolves.toEqual({ delivered: 2, pending: 0, truncated: false })
    const statePath = commitAckPath(root, 'redelivery-test-v1')
    const before = await readFile(statePath, 'utf8')
    await writeFile(hook.capture, '')

    await expect(redeliverLatestCommitNotification(join(root, '.scry'), env)).resolves.toMatchObject({
      delivered: true,
      sequence: 2
    })
    const notifications = (await readFile(hook.capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(notifications).toEqual([expect.objectContaining({ sessionId: 'redeliver-2', sequence: 2 })])
    expect(await readFile(statePath, 'utf8')).toBe(before)
  })

  it('recover 强制收敛 closing 运行态，不把它无限保留为 pending', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('recover-me', { prompt: 'recover' })
    })
    const open = join(root, '.scry', 'runtime', 'claude', safeKey('recover-me'), 'open.json')
    const state = JSON.parse(await readFile(open, 'utf8')) as Record<string, unknown>
    await writeFile(open, JSON.stringify({
      ...state,
      status: 'closing',
      closingAt: '2026-07-19T12:00:01.000Z'
    }))

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toMatchObject([
      { sessionId: 'recover-me', status: 'completed' }
    ])
    await expect(readHealth(join(root, '.scry'))).resolves.toMatchObject({ pendingCount: 0 })
  })

  it('跨 session 使用全局 sequence，分页 snapshot 不漏晚提交', async () => {
    const root = await workspace()
    await completeTurn(root, 'a')
    await completeTurn(root, 'b')
    const first = await exportRecords(join(root, '.scry'), { after: 0, limit: 1 })
    await completeTurn(root, 'a', 'late')
    const second = await exportRecords(join(root, '.scry'), { after: first.nextCursor, limit: 10, snapshotMaxSequence: first.snapshotMaxSequence })
    const nextSnapshot = await exportRecords(join(root, '.scry'), { after: second.nextCursor, limit: 10 })

    expect(first.records.map((record) => record.sequence)).toEqual([1])
    expect(first).toMatchObject({ nextCursor: 1, hasMore: true, snapshotMaxSequence: 2 })
    expect(second.records.map((record) => record.sequence)).toEqual([2])
    expect(nextSnapshot.records.map((record) => record.sequence)).toEqual([3])
  })

  it('序号只由正式记录决定：崩溃残留的 .tmp 不参与分配，也不覆盖旧记录', async () => {
    const root = await workspace()
    await completeTurn(root, 'a')
    await writeFile(join(root, '.scry', 'records', 'rename-before-crash.tmp'), '{"partial":true}')
    await completeTurn(root, 'b')
    expect((await listRecords(join(root, '.scry'))).map((record) => record.sequence)).toEqual([1, 2])
    await expect(verifyStore(join(root, '.scry'))).resolves.toEqual({ ok: true, records: 2, errors: [], archivedThrough: 0, maxSequence: 2 })
  })
}
