import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { handleRecorderHook, redeliverRecorderCommitNotification } from '../recorder'
import { listRecords, readHealth, safeKey } from '../store'
import { launchClientSourcePath } from '../launch-client'
import { commitHook, completeTurn, payload, workspace } from './fixture.test'

const SESSION = 'redelivery-and-source'

async function commitWorkspaceRecord(root: string, env: NodeJS.ProcessEnv): Promise<string> {
  await handleRecorderHook({
    provider: 'claude',
    event: 'UserPromptSubmit',
    workspace: root,
    env,
    payload: payload(SESSION, { prompt: 'record one turn' })
  })
  await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, env, payload: payload(SESSION) })
  const [record] = await listRecords(join(root, '.scry'))
  return record.recordId
}

export function registerRedeliverySuite(): void {
  it('daemon start posts the latest committed record again, exactly once per start', async () => {
    const root = await workspace()
    const hook = await commitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }
    const recordId = await commitWorkspaceRecord(root, env)
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(1)

    await expect(redeliverRecorderCommitNotification(root, env)).resolves.toMatchObject({ delivered: true, recordId })
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(2)

    await redeliverRecorderCommitNotification(root, env)
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(3)
    const deliveries = (await readFile(hook.capture, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { recordId: string; sequence: number })
    expect(deliveries.every((delivery) => delivery.recordId === recordId)).toBe(true)
  }, 40_000)

  it('redelivery stays quiet without a configured commit hook', async () => {
    const root = await workspace()
    await completeTurn(root, SESSION)
    const redelivery = await redeliverRecorderCommitNotification(root, { ...process.env, SCRY_RECORDER_COMMIT_HOOK: '' })
    expect(redelivery).toMatchObject({ delivered: false, reason: 'commit hook is not configured' })
  }, 40_000)

  it('redelivery never bypasses an already scheduled retry', async () => {
    const root = await workspace()
    const failing = await commitHook(root, 1)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: failing.path }
    await commitWorkspaceRecord(root, env)
    const retry = await redeliverRecorderCommitNotification(root, env)
    expect(retry.delivered).toBe(false)
    await expect(redeliverRecorderCommitNotification(root, env)).resolves.toMatchObject({
      delivered: false, reason: 'scheduled retry; use normal notification drain'
    })
  }, 40_000)

  it('records the launch client only in the local source tag, never in the record or its upload', async () => {
    const root = await workspace()
    const hook = await commitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path, SCRY_LAUNCH_CLIENT: 'scry-app' }
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      env,
      payload: payload(SESSION, { prompt: 'record one turn' })
    })
    const sessionDir = join(root, '.scry', 'runtime', 'claude', safeKey(SESSION))
    const open = JSON.parse(await readFile(join(sessionDir, 'open.json'), 'utf8')) as Record<string, unknown>
    expect(open.launchClient).toBe('scry-app')

    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, env, payload: payload(SESSION) })
    const [record] = await listRecords(join(root, '.scry'))
    expect(JSON.stringify(record)).not.toContain('scry-app')
    const source = JSON.parse(await readFile(launchClientSourcePath(join(root, '.scry'), record.recordId), 'utf8'))
    expect(source).toMatchObject({
      schemaVersion: 1, recordId: record.recordId, provider: 'claude', sessionId: SESSION, client: 'scry-app'
    })
    const delivered = await readFile(hook.capture, 'utf8')
    expect(delivered).not.toContain('scry-app')
  }, 40_000)

  it('drops a launch client that is not a lowercase identifier, without failing the turn', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_LAUNCH_CLIENT: 'Scry App/1.0' }
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      env,
      payload: payload(SESSION, { prompt: 'record one turn' })
    })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, env, payload: payload(SESSION) })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.status).toBe('completed')
    await expect(readFile(launchClientSourcePath(join(root, '.scry'), record.recordId), 'utf8')).rejects.toThrow()
    expect((await readHealth(join(root, '.scry'))).lastError).toBeUndefined()
  }, 40_000)

  it('keeps the launch client off managed turns, which the App never tags', async () => {
    const root = await workspace()
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      workspaceId: 'fixture',
      dataDir: '.scry',
      repositories: { mode: 'workspace-only' },
      capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
    }))
    const env = { ...process.env, SCRY_LAUNCH_CLIENT: 'scry-app' }
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      env,
      managed: true,
      payload: payload(SESSION, { turn_id: 'turn-1', prompt: 'managed turn' })
    })
    const sessionDir = join(root, '.scry', 'runtime', 'codex', safeKey(SESSION))
    await expect(readdir(sessionDir)).resolves.toContain('open.json')
    const open = JSON.parse(await readFile(join(sessionDir, 'open.json'), 'utf8')) as Record<string, unknown>
    expect(open.launchClient).toBeUndefined()
  }, 40_000)
}