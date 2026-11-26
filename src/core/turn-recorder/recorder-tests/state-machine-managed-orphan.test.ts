import { readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { listRecords, safeKey, readHealth } from '../store'
import { recorderOpenTurns, recorderQuarantinedOpenTurns } from '../runtime-state'
import { workspace, commitHook, commitAckPath } from './fixture.test'

async function managedWorkspace(): Promise<string> {
  const root = await workspace()
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  return root
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DEAD_PID = 999_999

function payloadOf(session: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: session, timestamp: new Date().toISOString(), ...extra }
}

async function startManaged(root: string, session: string, turnId = 'turn-1'): Promise<void> {
  await handleRecorderHook({
    provider: 'codex',
    event: 'UserPromptSubmit',
    workspace: root,
    managed: true,
    payload: payloadOf(session, { turn_id: turnId, prompt: 'record the managed turn' })
  })
}

async function stopManaged(root: string, session: string, turnId = 'turn-1'): Promise<void> {
  await handleRecorderHook({
    provider: 'codex',
    event: 'Stop',
    workspace: root,
    managed: true,
    payload: payloadOf(session, { turn_id: turnId })
  })
}

function openPathOf(root: string, session: string): string {
  return join(root, '.scry', 'runtime', 'codex', safeKey(session), 'open.json')
}

async function backdateSession(root: string, session: string, minutes: number): Promise<void> {
  const at = new Date(Date.now() - minutes * MINUTE)
  const sessionDir = join(root, '.scry', 'runtime', 'codex', safeKey(session))
  await utimes(join(sessionDir, 'open.json'), at, at)
  const turns = await readdir(join(sessionDir, 'turns')).catch(() => [] as string[])
  for (const turn of turns) {
    const turnDir = join(sessionDir, 'turns', turn)
    await utimes(turnDir, at, at).catch(() => undefined)
    const eventsDir = join(turnDir, 'events')
    for (const name of await readdir(eventsDir).catch(() => [] as string[])) {
      await utimes(join(eventsDir, name), at, at)
    }
  }
}

async function setHost(root: string, session: string, host: Array<{ pid: number }> | undefined): Promise<void> {
  const path = openPathOf(root, session)
  const open = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  if (host) open.host = host
  else delete open.host
  await writeFile(path, JSON.stringify(open))
}

export function registerManagedOrphanSuite(): void {
  it('托管的 open 轮次无人接管：按 interrupted 加 partial 封存，不再让会话永久失记', async () => {
    const root = await managedWorkspace()
    await startManaged(root, 'orphan-open')
    await setHost(root, 'orphan-open', [{ pid: DEAD_PID }])
    await backdateSession(root, 'orphan-open', 35)

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0, expired: 1 })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('interrupted')
    expect(records[0].termination?.value?.reason).toBe('expired')
    expect(records[0].termination?.omissionReason).toContain('no supervisor managed this turn any more')
    expect(records[0].assistant.status).toBe('unavailable')
    expect(records[0].usage.status).toBe('unavailable')
    await expect(recorderOpenTurns(join(root, '.scry'))).resolves.toEqual([])
    expect((await readHealth(join(root, '.scry'))).recoveredRecords).toBe(1)

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toHaveLength(1)
  }, 40_000)

  it('托管的 closing 轮次无人封存：按 completed 加 partial 封存，并如实标注托管方缺席', async () => {
    const root = await managedWorkspace()
    await startManaged(root, 'orphan-closing')
    await stopManaged(root, 'orphan-closing')
    await setHost(root, 'orphan-closing', [{ pid: DEAD_PID }])
    await backdateSession(root, 'orphan-closing', 31)

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0, expired: 1 })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.status).toBe('completed')
    expect(record.termination?.value?.reason).toBe('expired')
    expect(record.termination?.omissionReason).toContain('waiting for its supervisor to seal it')
    expect(record.assistant.status).toBe('unavailable')
    expect(record.transcript?.status).toBe('unavailable')
  }, 40_000)

  it('旧版 App 还在托管：最近活动未过期时不打断，托管轮次保持原样', async () => {
    const root = await managedWorkspace()
    await startManaged(root, 'orphan-live')
    await setHost(root, 'orphan-live', [{ pid: process.pid }])

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 1, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
    const [turn] = await recorderOpenTurns(join(root, '.scry'))
    expect(turn).toMatchObject({ sessionId: 'orphan-live', status: 'open', managed: true })

    await backdateSession(root, 'orphan-live', 35)
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 1, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
  }, 40_000)

  it('过期封存之后，同一会话的非托管开场能正常开轮并提交自己的记录', async () => {
    const root = await managedWorkspace()
    await startManaged(root, 'orphan-then-next')
    await setHost(root, 'orphan-then-next', [{ pid: DEAD_PID }])
    await backdateSession(root, 'orphan-then-next', 35)

    const started = await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payloadOf('orphan-then-next', { turn_id: 'turn-2', prompt: 'start the next turn' })
    })
    expect(started).toMatchObject({ status: 'started' })
    await handleRecorderHook({
      provider: 'codex',
      event: 'Stop',
      workspace: root,
      payload: payloadOf('orphan-then-next', { turn_id: 'turn-2' })
    })

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(2)
    expect(records[0].status).toBe('interrupted')
    expect(records[1].status).toBe('completed')
    expect(records[1].generation).toBeGreaterThan(records[0].generation)
    expect(records[1].user.value?.text).toBe('start the next turn')
  }, 40_000)

  it('隔离项超过保留窗口：按 interrupted 加 partial 封存，并从隔离索引移除', async () => {
    const root = await managedWorkspace()
    await startManaged(root, 'orphan-quarantine')
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: payloadOf('orphan-quarantine', { turn_id: 'turn-2', prompt: 'replace the managed turn' })
    })
    const sessionDir = join(root, '.scry', 'runtime', 'codex', safeKey('orphan-quarantine'))
    await expect(recorderQuarantinedOpenTurns(sessionDir)).resolves.toHaveLength(1)
    await expect(recoverRecorder(root)).resolves.toMatchObject({ recovered: 0, expired: 0 })
    await rm(openPathOf(root, 'orphan-quarantine'), { force: true })

    const pendingTurns = await readdir(join(sessionDir, 'turns'))
    const at = new Date(Date.now() - 25 * HOUR)
    for (const turn of pendingTurns) {
      const path = join(sessionDir, 'turns', turn, 'pending-open.json')
      const quarantined = await readFile(path, 'utf8').catch(() => undefined)
      if (!quarantined) continue
      await utimes(path, at, at)
      await writeFile(path, JSON.stringify({ ...JSON.parse(quarantined), quarantinedAt: at.toISOString() }))
    }

    await expect(recoverRecorder(root)).resolves.toMatchObject({ recovered: 1, expired: 1 })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('interrupted')
    expect(records[0].termination?.omissionReason).toContain('replaced by a managed successor')
    await expect(recorderQuarantinedOpenTurns(sessionDir)).resolves.toEqual([])
  }, 40_000)

  it('隔离项还在保留窗口内：不收尾，等它自己的保留期结束', async () => {
    const root = await managedWorkspace()
    await startManaged(root, 'orphan-recent')
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: payloadOf('orphan-recent', { turn_id: 'turn-2', prompt: 'replace the managed turn' })
    })
    const sessionDir = join(root, '.scry', 'runtime', 'codex', safeKey('orphan-recent'))

    await expect(recoverRecorder(root)).resolves.toMatchObject({ recovered: 0, expired: 0 })
    await expect(recorderQuarantinedOpenTurns(sessionDir)).resolves.toHaveLength(1)
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
  }, 40_000)

  it('降级封存的记录只投递一次提交回调', async () => {
    const root = await managedWorkspace()
    await startManaged(root, 'orphan-delivery')
    await setHost(root, 'orphan-delivery', [{ pid: DEAD_PID }])
    await backdateSession(root, 'orphan-delivery', 35)
    const hook = await commitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }

    await recoverRecorder(root, env)
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(1)
    await expect(readFile(commitAckPath(root), 'utf8')).resolves.toContain('"ackedThrough":1')

    await recoverRecorder(root, env)
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(1)
  }, 40_000)
}