import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { handleRecorderHook } from './recorder.js'
import { commitNotificationStatus, drainCommitNotifications, redeliverLatestCommitNotification } from './store.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['drain', 'redeliver'] as const)('%s binds schema v2 to exact file bytes and a path relative to a custom dataRoot', async mode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-notification-')))
  roots.push(root)
  const dataRoot = join(root, '.custom-records')
  const env = { HOME: root, PATH: process.env.PATH }
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'notification-fixture',
    dataDir: '.custom-records', capture: { diff: false } }))
  for (const event of ['UserPromptSubmit', 'Stop']) await handleRecorderHook({ workspace: root, provider: 'pi', event, env,
    payload: { session_id: 'notification', prompt: 'private fixture prompt', ...(event === 'Stop' ? { assistant_response: 'done' } : {}) } })
  const [name] = await readdir(join(dataRoot, 'records'))
  const path = join(dataRoot, 'records', name)
  const record = JSON.parse(await readFile(path, 'utf8'))
  // Deliberately differ from the writer's JSON formatting. Hashing a parsed/re-serialized
  // object or its legacy-normalized read view must not pass the content-handoff contract.
  const bytes = Buffer.from(JSON.stringify(record, null, 4) + '\n\n')
  await writeFile(path, bytes)
  const capture = join(root, 'notification.json')
  const hook = join(root, 'capture.cjs')
  await writeFile(hook, `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(capture)}, fs.readFileSync(0))\n`, { mode: 0o700 })
  const hookEnv = { ...env, SCRY_RECORDER_COMMIT_HOOK: hook }
  if (mode === 'drain') await expect(drainCommitNotifications(dataRoot, hookEnv)).resolves.toMatchObject({ delivered: 1 })
  else await expect(redeliverLatestCommitNotification(dataRoot, hookEnv)).resolves.toMatchObject({ delivered: true })
  const notification = JSON.parse(await readFile(capture, 'utf8'))
  expect(notification).toEqual({ schemaVersion: 2, event: 'record-committed', workspace: root, provider: 'pi', sessionId: 'notification',
    recordId: record.recordId, sequence: 1, recordPath: `records/${name}`, sha256: createHash('sha256').update(bytes).digest('hex') })
  expect(JSON.stringify(notification)).not.toContain('private fixture prompt')
  expect(await readFile(join(dataRoot, notification.recordPath))).toEqual(bytes)
  expect((await commitNotificationStatus(dataRoot, hookEnv)).ackedThrough).toBe(mode === 'drain' ? 1 : null)
}, 15_000)
