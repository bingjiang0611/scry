import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fixture, custody, writeCanonical, logs, waitFor } from './fixtures/recovery-helpers.mjs'
import { enqueueWakeup, runQueueWorker } from '../dist/queue.js'
import { runUpload, setUploadPolicy, takeCustody, pruneAckedBodies, releaseDisabled } from '../dist/uploader.js'
import { acquireDirectoryLock } from '../dist/util.js'
import { pendingReceipts } from '../dist/custody/receipts.js'
import { renderLaunchAgent, renderSystemdService } from '../dist/scheduler.js'

const exec = promisify(execFile)

test('HTTP-date Retry-After defers another workspace without spending its job budget', async (t) => {
  const first = await fixture(t)
  const peer = await fixture(t, first.env)
  const firstRecord = await custody(first.root, 1)
  await custody(peer.root, 1)
  const retryAfter = new Date(Date.now() + 60_000).toUTCString()
  const result = await runUpload(first.root, { env: {
    ...first.env, RECOVERY_STATUS: '429', RECOVERY_RETRY_AFTER: retryAfter
  } })
  assert.equal(result.uploaded, 0)
  assert.ok(result.deferredUntilMs >= Date.parse(retryAfter))
  assert.equal(JSON.parse(await readFile(join(first.base, 'receipts', `${firstRecord.recordId}.json`))).status, 'pending')
  await enqueueWakeup(peer.root, peer.env)
  await runQueueWorker(peer.root, peer.env, { once: true })
  const job = JSON.parse(await readFile(join(peer.base, 'jobs', 'wakeup-recovery.json')))
  assert.equal(job.attempts, 0)
  assert.ok(job.notBeforeMs >= Date.parse(retryAfter))
  assert.equal(JSON.parse(await readFile(join(peer.base, 'health.json'))).status, 'deferred')
  assert.equal((await logs(first.env.RECOVERY_TRANSPORT_LOG)).filter(event => event.phase === 'start').length, 1)
})

test('disable remains authoritative when pending maintenance fails', async (t) => {
  const { root, base, env } = await fixture(t)
  await writeFile(join(base, 'outbox', 'broken.json'), '{invalid')
  await assert.rejects(setUploadPolicy(root, false, env))
  assert.equal(JSON.parse(await readFile(join(base, 'state.json'))).uploadEnabled, false)
  assert.deepEqual(await logs(env.RECOVERY_TRANSPORT_LOG), [])
})

test('interrupted ACK body retirement permits replay and resumes without deleting unconfirmed bytes', async (t) => {
  const { root, base } = await fixture(t)
  const acked = await custody(root, 1)
  const pending = await custody(root, 2)
  const rejected = await custody(root, 3)
  const old = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString()
  const receiptPath = join(base, 'receipts', `${acked.recordId}.json`)
  const receipt = JSON.parse(await readFile(receiptPath))
  await writeFile(receiptPath, JSON.stringify({ ...receipt, status: 'uploaded', remoteStatus: 'inserted',
    finishedAt: old, bodyPruneStartedAt: new Date().toISOString() }))
  const rejectedPath = join(base, 'receipts', `${rejected.recordId}.json`)
  const rejectedReceipt = JSON.parse(await readFile(rejectedPath))
  await writeFile(rejectedPath, JSON.stringify({ ...rejectedReceipt, status: 'dead_letter', finishedAt: old }))
  // Simulate a crash between unlink and the completion marker, then caller cleanup.
  await rm(join(base, 'outbox', 'committed', acked.filename))
  await rm(join(root, '.scry', 'records', acked.filename))
  const replay = await takeCustody(root, { sequence: 1, recordId: acked.recordId, sha256: receipt.sha256 })
  assert.equal(replay.status, 'uploaded')
  await assert.rejects(takeCustody(root, { sequence: 1, recordId: acked.recordId, sha256: '0'.repeat(64) }),
    { code: 'notification_digest_mismatch' })
  assert.equal(await pruneAckedBodies(root), 1)
  assert.ok(JSON.parse(await readFile(receiptPath)).bodyPrunedAt)
  for (const record of [pending, rejected]) {
    assert.equal(await readFile(join(base, 'outbox', 'committed', record.filename), 'utf8'), record.raw)
    assert.equal(await readFile(join(root, '.scry', 'records', record.filename), 'utf8'), record.raw)
  }
})

test('native lock is released by caller death without replacing its inode', async (t) => {
  const { root, env } = await fixture(t)
  const lock = join(root, 'crash.lock')
  const moduleUrl = new URL('../dist/util.js', import.meta.url).href
  const program = `import { acquireDirectoryLock } from ${JSON.stringify(moduleUrl)};
    await acquireDirectoryLock(process.argv[1]); process.stdout.write('held'); process.exit(0)`
  assert.equal((await exec(process.execPath, ['--input-type=module', '-e', program, lock], { env })).stdout, 'held')
  const inode = (await stat(`${lock}.native`, { bigint: true })).ino
  let release
  await waitFor(async () => {
    try {
      release = await acquireDirectoryLock(lock)
      return true
    } catch (error) {
      if (error.message === 'upload worker is already running') return false
      throw error
    }
  })
  await release()
  assert.equal((await stat(`${lock}.native`, { bigint: true })).ino, inode)
})

test('service definitions preserve argv and never persist credential environment values', async (t) => {
  const { root } = await fixture(t)
  const env = { HOME: '/home/example&name', PATH: '/bin/$literal', TRANSPORT_SERVICE_TOKEN: 'fixture-secret' }
  const node = '/tools/node with space'
  const cli = "/installed/quote'&<%$/cli.js"
  const plist = renderLaunchAgent(node, cli, env)
  assert.equal(plist.includes('fixture-secret'), false)
  if (process.platform === 'darwin') {
    const path = join(root, 'service.plist')
    await writeFile(path, plist)
    const parsed = JSON.parse((await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path])).stdout)
    assert.deepEqual(parsed.ProgramArguments, [node, cli, '_recover'])
    assert.deepEqual(parsed.EnvironmentVariables, { HOME: env.HOME, PATH: env.PATH })
    assert.equal(parsed.StartInterval, 60)
  }
  const unit = renderSystemdService(node, cli, env)
  assert.ok(unit.includes('%%$$/cli.js'))
  assert.ok(unit.includes('Environment="PATH=/bin/$literal"'))
  assert.equal(unit.includes('fixture-secret'), false)
})

test('recovery honors a recorder upload opt-out even when its notification never ran', async (t) => {
  const { root, env, base } = await fixture(t)
  const held = await writeCanonical(root, 1)
  const allowed = await writeCanonical(root, 2)
  const directory = join(root, '.scry', 'record-environments')
  await mkdir(directory)
  await writeFile(join(directory, `${held.recordId}.json`), JSON.stringify({
    schemaVersion: 1, recordId: held.recordId, values: { SCRY_TURN_UPLOAD_ENABLED: '0' }
  }))
  assert.equal((await runUpload(root, { env })).uploaded, 1)
  const ids = (await logs(env.RECOVERY_TRANSPORT_LOG)).filter(event => event.phase === 'start').flatMap(event => event.ids)
  assert.deepEqual(ids, [allowed.recordId])
  assert.equal(JSON.parse(await readFile(join(base, 'receipts', `${held.recordId}.json`))).status, 'skipped_disabled')
})

test('pending-index cleanup cannot erase a simultaneous explicit release', async (t) => {
  const { root, base } = await fixture(t)
  const record = await custody(root, 1)
  const receiptPath = join(base, 'receipts', `${record.recordId}.json`)
  const receipt = JSON.parse(await readFile(receiptPath))
  await writeFile(receiptPath, JSON.stringify({ ...receipt, status: 'skipped_disabled' }))
  await writeFile(join(base, 'pending-index.json'), JSON.stringify({ version: 1 }))
  const original = fs.promises.readFile
  let interleaved = false
  fs.promises.readFile = async (...args) => {
    const value = await original(...args)
    if (String(args[0]) === receiptPath && !interleaved) {
      interleaved = true
      await releaseDisabled(root, record.recordId)
    }
    return value
  }
  syncBuiltinESMExports()
  try {
    const pending = await pendingReceipts(base)
    assert.equal(interleaved, true)
    assert.deepEqual(pending.map(item => item.recordId), [record.recordId])
    await stat(join(base, 'pending-receipts', record.recordId))
  } finally {
    fs.promises.readFile = original
    syncBuiltinESMExports()
  }
})
