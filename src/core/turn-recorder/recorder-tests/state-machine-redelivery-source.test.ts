import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { applyHookEnvironment, decodeHookEnvironment, encodeHookEnvironment } from '../commit-environment'
import { listenRecorderDaemon, sendRecorderDaemonHook } from '../daemon'
import { recorderSocketPath } from '../daemon-transport'
import { listRecords, readHealth, safeKey } from '../store'
import { launchClientSourcePath } from '../launch-client'
import { commitHook, payload, workspace } from './fixture.test'

const SESSION = 'redelivery-and-source'

export function registerRedeliverySuite(): void {
  let grantDir: string | undefined
  let previousGrantDir: string | undefined

  beforeAll(async () => {
    grantDir = await mkdtemp(join(tmpdir(), 'scry-launch-client-grants-'))
    previousGrantDir = process.env.SCRY_GRANT_DIR
    process.env.SCRY_GRANT_DIR = grantDir
  })

  afterAll(async () => {
    if (previousGrantDir === undefined) delete process.env.SCRY_GRANT_DIR
    else process.env.SCRY_GRANT_DIR = previousGrantDir
    if (grantDir) await rm(grantDir, { recursive: true, force: true })
  })

  it('carries the launch client through the hook envelope and drops an inherited one', () => {
    const envelope = encodeHookEnvironment({ SCRY_LAUNCH_CLIENT: 'scry-app' }, { event: 'Stop' })
    expect(decodeHookEnvironment(envelope).env).toMatchObject({ SCRY_LAUNCH_CLIENT: 'scry-app' })
    expect(applyHookEnvironment({ SCRY_LAUNCH_CLIENT: 'scry-app', PATH: '/bin' }, {}))
      .toEqual({ PATH: '/bin' })
    expect(applyHookEnvironment({ PATH: '/bin' }, { SCRY_LAUNCH_CLIENT: 'codelens' }))
      .toMatchObject({ SCRY_LAUNCH_CLIENT: 'codelens' })
  })

  it('tags a turn relayed by a daemon with the client that sent the hook', async () => {
    const root = await workspace()
    const socketPath = recorderSocketPath(root)
    const daemon = await listenRecorderDaemon({ workspace: root, socketPath })
    try {
      const env = { ...process.env, SCRY_LAUNCH_CLIENT: 'scry-app', SCRY_RECORDER_SOCKET: socketPath }
      await sendRecorderDaemonHook({
        provider: 'claude', event: 'UserPromptSubmit', workspace: root, env,
        payload: payload('daemon-source', { prompt: 'relayed by the daemon' })
      })
      const sessionDir = join(root, '.scry', 'runtime', 'claude', safeKey('daemon-source'))
      const open = JSON.parse(await readFile(join(sessionDir, 'open.json'), 'utf8')) as Record<string, unknown>
      expect(open.launchClient).toBe('scry-app')
    } finally {
      await daemon.close()
    }
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