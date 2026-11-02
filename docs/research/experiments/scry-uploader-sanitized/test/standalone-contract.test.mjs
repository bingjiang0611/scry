import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  initializeUploadState,
  localUploadStatus,
  releaseDisabled,
  runUpload,
  setUploadPolicy,
  takeCustody,
  uploadRoot
} from '../dist/uploader.js'
import { notifyRecordCommit, validateNotification } from '../dist/queue.js'
import { run } from '../dist/util.js'

const fakeTransport = fileURLToPath(new URL('./fixtures/fake-transport.mjs', import.meta.url))
const id = (letter) => letter.repeat(32)

async function workspace(dataDir = '.scry') {
  const root = await mkdtemp(join(tmpdir(), 'scry-uploader-contract-'))
  await mkdir(join(root, '.git'))
  await writeFile(
    join(root, 'scry.config.json'),
    JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture', dataDir })
  )
  await mkdir(join(root, dataDir, 'records'), { recursive: true })
  // These custody unit fixtures are not complete recorder records. Export is a
  // separate boundary; real recorder/export integration stays in integration.test.
  const scry = join(root, 'fixture-scry')
  await writeFile(
    scry,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const after = Number(args[args.indexOf('--after') + 1])
console.log(JSON.stringify({ records: [], nextCursor: after, snapshotMaxSequence: 0, hasMore: false }))
`
  )
  await chmod(scry, 0o700)
  return root
}
function record(root, sequence, recordId, extra = {}) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      sequence,
      recordId,
      workspace: { id: 'fixture', root },
      sessionId: 'session',
      provider: 'pi',
      ...extra
    })
  )
}
function env(log, extra = {}) {
  return {
    ...process.env,
    TRANSPORT_CLI_PATH: fakeTransport,
    HOME: join(log, '..', '.home'),
    XDG_STATE_HOME: join(log, '..', '.state'),
    FAKE_TRANSPORT_LOG: log,
    SCRY_CLI_PATH: join(log, '..', 'fixture-scry'),
    SCRY_UPLOADER_NO_SPAWN: '1',
    ...extra
  }
}
async function setup(root) {
  await initializeUploadState(root, 0)
  return join(root, 'transport.log')
}

await chmod(fakeTransport, 0o700)

test('v2 notification custody is byte exact and replay is idempotent after source removal', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const recordId = id('a')
  const raw = record(root, 1, recordId)
  const name = `00000000000000000001-${recordId}.json`
  await writeFile(join(root, '.scry/records', name), raw)
  const event = {
    schemaVersion: 2,
    event: 'record-committed',
    workspace: root,
    provider: 'pi',
    sessionId: 'session',
    recordId,
    sequence: 1,
    recordPath: `records/${name}`,
    sha256: (await import('node:crypto')).createHash('sha256').update(raw).digest('hex')
  }
  assert.equal(validateNotification(event, root).recordPath, event.recordPath)
  await notifyRecordCommit(root, event, {
    ...process.env,
    SCRY_UPLOADER_NO_SPAWN: '1'
  })
  await unlink(join(root, '.scry/records', name))
  const log = await setup(root)
  const result = await runUpload(root, {
    env: env(log),
    mode: 'wakeup',
    expected: { sequence: 1, recordId, provider: 'pi', sessionId: 'session' }
  })
  assert.equal(result.uploaded, 1)
  const receipt = JSON.parse(await readFile(join(uploadRoot(root), 'receipts', `${recordId}.json`)))
  assert.equal(receipt.status, 'uploaded')
  assert.equal(receipt.remoteStatus, 'inserted')
  const sent = JSON.parse((await readFile(log, 'utf8')).trim()).decoded[0]
  assert.deepEqual(sent, JSON.parse(raw.toString('utf8')))
  await notifyRecordCommit(root, event, {
    ...process.env,
    SCRY_UPLOADER_NO_SPAWN: '1'
  })
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1)
})

test('disabled custody is retained and explicit release is local-only before upload', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const recordId = id('b')
  const name = `00000000000000000001-${recordId}.json`
  const raw = record(root, 1, recordId)
  await writeFile(join(root, '.scry/records', name), raw)
  await setup(root)
  const event = {
    schemaVersion: 2,
    event: 'record-committed',
    workspace: root,
    provider: 'pi',
    sessionId: 'session',
    recordId,
    sequence: 1,
    recordPath: `records/${name}`,
    sha256: (await import('node:crypto')).createHash('sha256').update(raw).digest('hex')
  }
  await notifyRecordCommit(root, event, {
    ...process.env,
    SCRY_TURN_UPLOAD_ENABLED: '0',
    SCRY_UPLOADER_NO_SPAWN: '1'
  })
  let receipt = JSON.parse(await readFile(join(uploadRoot(root), 'receipts', `${recordId}.json`)))
  assert.equal(receipt.status, 'skipped_disabled')
  const log = join(root, 'transport.log')
  const held = await runUpload(root, {
    env: env(log, { SCRY_TURN_UPLOAD_ENABLED: '0' }),
    mode: 'wakeup'
  })
  assert.equal(held.uploaded, 0)
  await setUploadPolicy(root, true, env(log))
  await releaseDisabled(root, recordId)
  receipt = JSON.parse(await readFile(join(uploadRoot(root), 'receipts', `${recordId}.json`)))
  assert.equal(receipt.status, 'pending')
  const released = await runUpload(root, { env: env(log), mode: 'wakeup' })
  assert.equal(released.uploaded, 1)
})

test('unsupported custody schema is dead-lettered with metadata only and later records continue', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const bad = id('c')
  const good = id('d')
  const badName = `00000000000000000001-${bad}.json`
  const goodName = `00000000000000000002-${good}.json`
  await writeFile(
    join(root, '.scry/records', badName),
    JSON.stringify({
      schemaVersion: 99,
      secret: 'do-not-copy',
      sequence: 1,
      recordId: bad
    })
  )
  await writeFile(join(root, '.scry/records', goodName), record(root, 2, good))
  await setup(root)
  for (const [recordId, sequence, name] of [
    [bad, 1, badName],
    [good, 2, goodName]
  ])
    await notifyRecordCommit(
      root,
      {
        schemaVersion: 2,
        event: 'record-committed',
        workspace: root,
        provider: 'pi',
        sessionId: 'session',
        recordId,
        sequence,
        recordPath: `records/${name}`,
        sha256: (await import('node:crypto'))
          .createHash('sha256')
          .update(await readFile(join(root, '.scry/records', name)))
          .digest('hex')
      },
      { ...process.env, SCRY_UPLOADER_NO_SPAWN: '1' }
    )
  const log = join(root, 'transport.log')
  const result = await runUpload(root, { env: env(log), mode: 'wakeup' })
  assert.equal(result.uploaded, 1)
  const dead = JSON.parse(await readFile(join(uploadRoot(root), 'dead-letter', badName)))
  assert.equal(dead.reason, 'unsupported_schema_version')
  assert.equal(JSON.stringify(dead).includes('do-not-copy'), false)
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1)
})

test('legacy main and per-record lock files fail closed until explicit migration', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  await setup(root)
  await mkdir(join(uploadRoot(root), 'receipts'), { recursive: true })
  await writeFile(join(uploadRoot(root), 'lock'), 'legacy-lock-owner')
  await assert.rejects(
    () =>
      takeCustody(root, {
        schemaVersion: 1,
        event: 'record-committed',
        workspace: root,
        provider: 'pi',
        sessionId: 'session',
        recordId: id('a'),
        sequence: 1
      }),
    { code: 'legacy_store_requires_migration' }
  )
  assert.equal(await readFile(join(uploadRoot(root), 'lock'), 'utf8'), 'legacy-lock-owner')
})

test('legacy flock lock file is never removed by standalone preparation', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  await setup(root)
  await mkdir(uploadRoot(root), { recursive: true })
  await writeFile(join(uploadRoot(root), 'lock'), 'legacy-lock-owner')
  await (await import('../dist/uploader.js')).prepareUploadRoot(root)
  assert.equal(await readFile(join(uploadRoot(root), 'lock'), 'utf8'), 'legacy-lock-owner')
})

test('legacy redacted outbox remains uploadable without being converted to raw none', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const recordId = id('f')
  const redacted = JSON.stringify({
    schemaVersion: 1,
    sequence: 1,
    recordId,
    workspace: { id: 'fixture', root: '<workspace>' }
  })
  await setup(root)
  await mkdir(join(uploadRoot(root), 'outbox'), { recursive: true })
  await writeFile(
    join(uploadRoot(root), 'outbox', `00000000000000000001-${recordId}.json`),
    JSON.stringify({
      version: 1,
      sequence: 1,
      recordId,
      workspaceId: 'fixture',
      redactionVersion: 'agent-turn-v1',
      recordBytes: Buffer.byteLength(redacted),
      record: redacted
    })
  )
  const log = join(root, 'transport.log')
  const result = await runUpload(root, { env: env(log), mode: 'wakeup' })
  assert.equal(result.uploaded, 1)
  const sent = JSON.parse((await readFile(log, 'utf8')).trim()).decoded[0]
  assert.equal(sent.workspace.root, '<workspace>')
})

test('custom dataDir and old enqueuedThrough do not skip unacknowledged custody', async (t) => {
  const root = await workspace('custom-store')
  t.after(() => rm(root, { recursive: true, force: true }))
  const recordId = id('e')
  const name = `00000000000000000001-${recordId}.json`
  const raw = record(root, 1, recordId)
  await writeFile(join(root, 'custom-store/records', name), raw)
  await initializeUploadState(root, 999)
  await notifyRecordCommit(
    root,
    {
      schemaVersion: 1,
      event: 'record-committed',
      workspace: root,
      provider: 'pi',
      sessionId: 'session',
      recordId,
      sequence: 1
    },
    { ...process.env, SCRY_UPLOADER_NO_SPAWN: '1' }
  )
  const log = join(root, 'transport.log')
  const result = await runUpload(root, { env: env(log), mode: 'wakeup' })
  assert.equal(result.uploaded, 1)
  assert.equal(
    (await readdir(join(root, 'custom-store', 'upload', 'receipts'))).some((name) =>
      name.startsWith(recordId)
    ),
    true
  )
  assert.equal((await readdir(join(root, '.scry')).catch(() => [])).includes('upload'), false)
})
