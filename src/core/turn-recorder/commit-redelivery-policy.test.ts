import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleRecorderHook } from './recorder.js'
import { saveOutcome } from './commit-delivery-ledger.js'
import { COMMIT_NOTIFICATION_MAX_FAILURES } from './commit-delivery-state.js'
import { commitNotificationStatus, drainCommitNotifications, redeliverLatestCommitNotification } from './store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  root: string
  dataRoot: string
  calls: string
  hook: string
  env: NodeJS.ProcessEnv
  readCalls: () => Promise<number[]>
  fingerprint: (name: string) => NodeJS.ProcessEnv
}

async function fixture(exitCode = 0): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'scry-redelivery-policy-'))
  roots.push(root)
  const dataRoot = join(root, '.scry')
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'redelivery-policy-fixture',
    capture: { prompt: true, assistant: true, diff: false, toolOutput: 'summary', hooks: true }
  }))
  const calls = join(root, 'calls.jsonl')
  const hook = join(root, 'receiver.cjs')
  await writeFile(hook, `#!${process.execPath}
const fs = require('node:fs')
const n = JSON.parse(fs.readFileSync(0, 'utf8'))
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(n.sequence) + '\\n')
process.exit(${exitCode})
`)
  await chmod(hook, 0o700)
  const env = { HOME: root, XDG_STATE_HOME: join(root, 'state'), SCRY_GRANT_DIR: join(root, 'grants'),
    SCRY_RECORDER_COMMIT_HOOK: hook, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'redelivery-policy-v1' }
  return {
    root,
    dataRoot,
    calls,
    hook,
    env,
    readCalls: async () => {
      const text = await readFile(calls, 'utf8').catch(() => '')
      return text.trim() === '' ? [] : text.trim().split('\n').map(Number)
    },
    fingerprint: (name: string) => ({ ...env, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: name })
  }
}

async function commitTurns(f: Fixture, turns: number): Promise<void> {
  for (let turn = 1; turn <= turns; turn++) {
    for (const event of ['UserPromptSubmit', 'Stop']) {
      await handleRecorderHook({
        workspace: f.root, provider: 'pi', event, deferDelivery: true,
        payload: { session_id: 'session', turn_id: `turn-${turn}`, prompt: 'fixture', assistant_response: 'done' }
      }, f.env)
    }
  }
}

describe('latest commit redelivery', () => {
  it('leaves an acknowledged record alone', async () => {
    const f = await fixture()
    await commitTurns(f, 1)
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 1 })
    const acknowledged = await f.readCalls()
    expect(acknowledged).toEqual([1])

    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({
      delivered: false, sequence: 1, reason: 'already acknowledged; no redelivery'
    })
    expect(await f.readCalls()).toEqual(acknowledged)
  }, 20_000)

  it('retries an unacknowledged record once and then treats it as acknowledged', async () => {
    const f = await fixture()
    await commitTurns(f, 1)

    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: true, sequence: 1 })
    expect(await f.readCalls()).toEqual([1])

    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({
      delivered: false, reason: 'already acknowledged; no redelivery'
    })
    expect(await f.readCalls()).toEqual([1])
  }, 20_000)

  it('does not record a rejected callback as acknowledged', async () => {
    const f = await fixture(1)
    await commitTurns(f, 1)

    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: false, sequence: 1 })
    expect(await f.readCalls()).toEqual([1])
    const status = await commitNotificationStatus(f.dataRoot, f.env)
    expect(status).toMatchObject({ ackedThrough: null, failure: { sequence: 1, attempts: 1 } })
  }, 20_000)

  it('treats records that predate the hook fingerprint as acknowledged instead of backfilling them', async () => {
    const f = await fixture()
    await commitTurns(f, 2)
    await expect(drainCommitNotifications(f.dataRoot, f.fingerprint('redelivery-policy-v0'))).resolves.toMatchObject({ delivered: 2 })
    expect(await f.readCalls()).toEqual([1, 2])

    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({
      delivered: false, sequence: 2,
      reason: 'delivery has no checkpoint for this hook; existing records are treated as acknowledged'
    })
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 0 })
    expect(await f.readCalls()).toEqual([1, 2])
  }, 20_000)

  it('leaves scheduled retries and dead letters to the normal drain', async () => {
    const f = await fixture(1)
    await commitTurns(f, 1)
    const first = await redeliverLatestCommitNotification(f.dataRoot, f.env)
    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({
      delivered: false, sequence: 1, reason: 'scheduled retry; use normal notification drain'
    })
    expect(await f.readCalls()).toEqual([1])

    const recordId = first.recordId as string
    const failure = { sequence: 1, recordId, attempts: COMMIT_NOTIFICATION_MAX_FAILURES,
      lastFailureAt: new Date().toISOString(), reason: 'spawn_error' }
    await saveOutcome(f.dataRoot, 'redelivery-policy-v1', { sequence: 1, recordId, status: 'dead', failure })
    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({
      delivered: false, sequence: 1, reason: 'recorder dead letter; automatic redelivery disabled'
    })
    await saveOutcome(f.dataRoot, 'redelivery-policy-v1', { sequence: 1, recordId, status: 'retry', failure })
    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({
      delivered: false, sequence: 1, reason: 'recorder dead letter; automatic redelivery disabled'
    })
    expect(await f.readCalls()).toEqual([1])
    expect((await commitNotificationStatus(f.dataRoot, f.env)).ackedThrough).toBe(null)
  }, 20_000)

  it('still delivers records committed after a fingerprint change', async () => {
    const f = await fixture()
    await commitTurns(f, 1)
    await drainCommitNotifications(f.dataRoot, f.fingerprint('redelivery-policy-v0'))
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 0 })
    await commitTurns(f, 2)

    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: true, sequence: 2 })
    expect(await f.readCalls()).toEqual([1, 2])
  }, 20_000)
})