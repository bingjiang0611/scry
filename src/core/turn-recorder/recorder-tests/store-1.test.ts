import { mkdir, writeFile, rm, readdir, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect, vi } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { listRecords, readHealth, safeKey, resetRecordStoreIndex, recordStoreIndexStats, drainCommitNotifications, redeliverLatestCommitNotification, commitNotificationStatus } from '../store'
import { resolveCommitHookActivation, commitHookEnv } from '../commit-hook-grant'
import { resolveRecorderLocation } from '../config'
import { recorderSessionLock, HOOK_LOCK_WAIT_MS, SESSION_LOCK_WAIT_MS } from '../runtime-state'
import { workspace, payload, completeTurn, commitHook, commitAckPath } from './fixture.test'

export function registerSuite13(): void {

  it('session 锁超时时把 hook 持久排队，下一个持锁者按到达顺序、到达时间重放而不是丢弃', async () => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    const lock = recorderSessionLock(dataRoot, 'pi', 'busy-session')
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'held-by-peer' }))
    const prompt = { session_id: 'busy-session', prompt: 'queued while busy' }
    const before = Date.now()
    const queued = await handleRecorderHook({ provider: 'pi', event: 'UserPromptSubmit', workspace: root, payload: prompt })
    expect(queued).toMatchObject({ status: 'pending', reason: 'session busy; event queued for replay' })
    // The hook must queue well inside the Provider's 10s hook timeout, not wait out the session lock.
    expect(Date.now() - before).toBeLessThan(HOOK_LOCK_WAIT_MS + 2_000)
    expect(HOOK_LOCK_WAIT_MS + 2_000).toBeLessThan(SESSION_LOCK_WAIT_MS)
    expect(await listRecords(dataRoot)).toHaveLength(0)
    await rm(lock, { recursive: true, force: true })

    const stop = await handleRecorderHook({ provider: 'pi', event: 'Stop', workspace: root, payload: { session_id: 'busy-session', timestamp: new Date(Date.now() + 1_000).toISOString() } })
    expect(stop.status).toBe('committed')
    const [record] = await listRecords(dataRoot)
    expect(record.user.value).toMatchObject({ text: 'queued while busy' })
    // The replayed start keeps the time the hook arrived: not when it was replayed, and not
    // when the lock wait expired HOOK_LOCK_WAIT_MS later and the hook was queued.
    expect(Date.parse(record.startedAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(record.startedAt)).toBeLessThan(before + 1_000)
    expect(await readHealth(dataRoot)).toMatchObject({ droppedEvents: 0 })
    expect(await readdir(join(dataRoot, 'runtime', 'pi', safeKey('busy-session'), 'inbox'))).toEqual([])
  }, 30_000)

  it('排队的终态 hook 没有后续 hook 时由 recover 应用', async () => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    await handleRecorderHook({ provider: 'pi', event: 'UserPromptSubmit', workspace: root, payload: payload('busy-stop', { prompt: 'run' }) })
    const lock = recorderSessionLock(dataRoot, 'pi', 'busy-stop')
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'held-by-peer' }))
    const queued = await handleRecorderHook({ provider: 'pi', event: 'Stop', workspace: root, payload: payload('busy-stop', { timestamp: '2026-07-19T12:00:05.000Z' }) })
    expect(queued.status).toBe('pending')
    await rm(lock, { recursive: true, force: true })

    await recoverRecorder(root)
    const [record] = await listRecords(dataRoot)
    expect(record.completedAt).toBe('2026-07-19T12:00:05.000Z')
    expect(await readHealth(dataRoot)).toMatchObject({ droppedEvents: 0 })
  }, 30_000)

  it('同进程重复读取复用可重建文件名索引，正式写入后按目录 stamp 失效', async () => {
    const root = await workspace()
    await completeTurn(root, 'index-1')
    const dataRoot = join(root, '.scry')
    resetRecordStoreIndex()

    await listRecords(dataRoot)
    expect(recordStoreIndexStats()).toMatchObject({ hits: 0, misses: 1, entries: 1 })
    await listRecords(dataRoot)
    expect(recordStoreIndexStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 })

    await completeTurn(root, 'index-2')
    await listRecords(dataRoot)
    expect(recordStoreIndexStats().misses).toBe(2)
    await expect(listRecords(dataRoot)).resolves.toHaveLength(2)
  })

  it('records 作为 durable outbox，只向 callback 发送无敏感字段的提交通知', async () => {
    const root = await workspace()
    await completeTurn(root, 'notify-safe', 'do not leak this prompt')
    const hook = await commitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }

    await expect(drainCommitNotifications(join(root, '.scry'), env)).resolves.toEqual({ delivered: 1, pending: 0, truncated: false })
    const notification = JSON.parse((await readFile(hook.capture, 'utf8')).trim()) as Record<string, unknown>
    expect(notification).toEqual({
      schemaVersion: 2,
      event: 'record-committed',
      recordPath: expect.stringMatching(/^records\/\d{20}-[a-f0-9]+\.json$/),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      workspace: root,
      provider: 'claude',
      sessionId: 'notify-safe',
      recordId: expect.any(String),
      sequence: 1
    })
    expect(JSON.stringify(notification)).not.toContain('do not leak this prompt')
    await expect(readFile(commitAckPath(root), 'utf8'))
      .resolves.toContain('"ackedThrough":1')
  })

  it('callback 失败时保留未 ACK sequence，成功重试后推进 ACK', async () => {
    const root = await workspace()
    await completeTurn(root, 'notify-retry')
    const failed = await commitHook(root, 1)
    const base = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: failed.path }

    await expect(drainCommitNotifications(join(root, '.scry'), base))
      .resolves.toEqual({ delivered: 0, pending: 1, truncated: false })
    // VE2 stores per-sequence failures separately; visited progress is not an ACK.
    expect(JSON.parse(await readFile(commitAckPath(root), 'utf8'))).toMatchObject({ ackedThrough: 0, processedThrough: 1, queueVersion: 2 })
    const pending = await commitNotificationStatus(join(root, '.scry'), base)
    expect(pending).toMatchObject({ failure: { sequence: 1, attempts: 1, nextRetryAt: expect.any(String) } })
    const hook = await commitHook(root)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(pending.failure!.nextRetryAt!))
    try {
      await expect(drainCommitNotifications(join(root, '.scry'), {
        ...base, SCRY_RECORDER_COMMIT_HOOK: hook.path
      })).resolves.toEqual({ delivered: 1, pending: 0, truncated: false })
    } finally { clock.mockRestore() }
    await expect(readFile(commitAckPath(root), 'utf8'))
      .resolves.toContain('"ackedThrough":1')
  })

  it.each([
    {
      name: 'nonzero exit',
      source: '#!/bin/sh\ncat >/dev/null\nprintf do-not-log-secret >&2\nexit 7\n',
      expected: { reason: 'exit', exitCode: 7, signal: null }
    },
    {
      name: 'signal',
      source: '#!/bin/sh\ncat >/dev/null\nkill -TERM "$$"\n',
      expected: { reason: 'signal', exitCode: null, signal: 'SIGTERM' }
    },
    {
      name: 'spawn error',
      source: '#!/scry-missing-interpreter\n',
      expected: { reason: 'spawn_error', errorCode: 'ENOENT' }
    }
  ])('callback diagnostics preserve pending work: $name', async ({ source, expected }) => {
    const root = await workspace()
    await completeTurn(root, 'diagnostic')
    const hook = await commitHook(root)
    await writeFile(hook.path, source)
    const env = { PATH: '/usr/bin:/bin', SCRY_RECORDER_COMMIT_HOOK: hook.path }
    const dataRoot = join(root, '.scry')

    await expect(drainCommitNotifications(dataRoot, env))
      .resolves.toEqual({ delivered: 0, pending: 1, truncated: false })
    await expect(redeliverLatestCommitNotification(dataRoot, env))
      .resolves.toMatchObject({ delivered: false, reason: 'scheduled retry; use normal notification drain' })
    await expect(commitNotificationStatus(dataRoot, env))
      .resolves.toMatchObject({ ackedThrough: 0, notifyBacklog: 1, failure: { sequence: 1, attempts: 1, ...expected } })
    const log = await readFile(join(dataRoot, 'logs', 'recorder.log'), 'utf8')
    const diagnostics = log.trim().split('\n').map(line => JSON.parse(line.split('; diagnostic=')[1]))
    // The cold-start path must not create a second failure during backoff.
    expect(diagnostics).toHaveLength(1)
    for (const diagnostic of diagnostics) {
      expect(diagnostic).toMatchObject({ acknowledged: false, recorderPid: process.pid, ...expected })
    }
    expect(log).not.toContain('do-not-log-secret')
    expect(log).not.toContain(root)
  })

  it('callback diagnostics distinguish the real deadline from an ordinary signal', async () => {
    const root = await workspace()
    await completeTurn(root, 'diagnostic-timeout')
    const hook = await commitHook(root)
    // Deliberately block this owned callback to exercise the unchanged 10-second production deadline.
    await writeFile(hook.path, '#!/bin/sh\ncat >/dev/null\nexec sleep 60\n')
    const dataRoot = join(root, '.scry')
    await expect(drainCommitNotifications(dataRoot, {
      PATH: '/usr/bin:/bin', SCRY_RECORDER_COMMIT_HOOK: hook.path
    })).resolves.toEqual({ delivered: 0, pending: 1, truncated: false })
    const log = await readFile(join(dataRoot, 'logs', 'recorder.log'), 'utf8')
    expect(JSON.parse(log.trim().split('; diagnostic=')[1]))
      .toMatchObject({ acknowledged: false, reason: 'timeout', signal: 'SIGTERM', recorderPid: process.pid })
    expect(JSON.parse(await readFile(commitAckPath(root), 'utf8'))).toMatchObject({ ackedThrough: 0, processedThrough: 1 })
    expect(await commitNotificationStatus(dataRoot, { SCRY_RECORDER_COMMIT_HOOK: hook.path })).toMatchObject({
      failure: { sequence: 1, attempts: 1, reason: 'timeout', nextRetryAt: expect.any(String) }
    })
  }, 20_000)

  it('通知身份不一致只使 ACK 不适用，不能解释同一身份下 callback 不 ACK', async () => {
    const root = await workspace()
    await completeTurn(root, 'identity-1')
    await completeTurn(root, 'identity-2')
    const hook = await commitHook(root)
    const failure = join(root, 'fail-callback')
    const hookSource = `#!/bin/sh\ncat >> ${JSON.stringify(hook.capture)}\n[ ! -f ${JSON.stringify(failure)} ] || exit 7\nexit 0\n`
    await writeFile(hook.path, hookSource)
    const configPath = join(root, 'scry.config.json')
    await writeFile(configPath, JSON.stringify({
      ...JSON.parse(await readFile(configPath, 'utf8')),
      commitHook: { entry: 'commit-hook.sh', files: ['commit-hook.sh'] }
    }))
    const location = await resolveRecorderLocation(root)
    if (!location.valid) throw new Error('invalid fixture config')
    const env = { PATH: '/usr/bin:/bin', SCRY_GRANT_DIR: join(root, 'grants') }
    const activate = () => resolveCommitHookActivation(root, location.config, env)
    const configured = commitHookEnv(await activate(), env)
    const dataRoot = join(root, '.scry')
    const statePath = commitAckPath(root, configured.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT)

    await expect(drainCommitNotifications(dataRoot, configured, { maxRecords: 1 }))
      .resolves.toEqual({ delivered: 1, pending: 1, truncated: true })
    const saved = await readFile(statePath, 'utf8')
    const hosted = { ...env, SCRY_RECORDER_COMMIT_HOOK: hook.path }
    await expect(resolveCommitHookActivation(root, location.config, hosted))
      .resolves.toEqual({ status: 'host-provided' })
    await expect(commitNotificationStatus(dataRoot, hosted))
      .resolves.toEqual({ ackedThrough: null, notifyBacklog: 2 })
    expect(await readFile(statePath, 'utf8')).toBe(saved)

    const restored = commitHookEnv(await activate(), env)
    await expect(commitNotificationStatus(dataRoot, restored))
      .resolves.toEqual({ ackedThrough: 1, notifyBacklog: 1 })
    await writeFile(failure, '')
    expect(commitHookEnv(await activate(), env)).toEqual(restored)
    await expect(drainCommitNotifications(dataRoot, restored))
      .resolves.toEqual({ delivered: 0, pending: 1, truncated: false })
    const failedState = await readFile(statePath, 'utf8')
    expect(JSON.parse(failedState)).toMatchObject({ ...JSON.parse(saved), processedThrough: 2 })
    expect(await commitNotificationStatus(dataRoot, restored)).toMatchObject({ failure: { sequence: 2, attempts: 1 } })

    await appendFile(hook.path, '# changed bundle identity\n')
    const changed = commitHookEnv(await activate(), env)
    expect(changed.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT)
      .not.toBe(restored.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT)
    await expect(commitNotificationStatus(dataRoot, changed))
      .resolves.toEqual({ ackedThrough: null, notifyBacklog: 2 })
    expect(await readFile(statePath, 'utf8')).toBe(failedState)
  })

  it('independent hook identities retain their own ACK across successful alternating deliveries', async () => {
    const root = await workspace()
    await completeTurn(root, 'identity-a')
    await completeTurn(root, 'identity-b')
    const hook = await commitHook(root)
    const dataRoot = join(root, '.scry')
    const a = { PATH: '/usr/bin:/bin', SCRY_RECORDER_COMMIT_HOOK: hook.path, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'cli-bundle' }
    const b = { ...a, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'sha256:app-bundle' }
    await expect(drainCommitNotifications(dataRoot, a)).resolves.toMatchObject({ delivered: 2, pending: 0 })
    await expect(drainCommitNotifications(dataRoot, b, { maxRecords: 1 })).resolves.toMatchObject({ delivered: 1, pending: 1 })
    await expect(commitNotificationStatus(dataRoot, a)).resolves.toEqual({ ackedThrough: 2, notifyBacklog: 0 })
    await expect(commitNotificationStatus(dataRoot, b)).resolves.toEqual({ ackedThrough: 1, notifyBacklog: 1 })
    await expect(drainCommitNotifications(dataRoot, a)).resolves.toMatchObject({ delivered: 0, pending: 0 })
    await expect(drainCommitNotifications(dataRoot, b)).resolves.toMatchObject({ delivered: 1, pending: 0 })
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(4)
  })
}
