import assert from 'node:assert/strict'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { initWorkspace } from '../dist/init.js'
import { enqueueWakeup, runQueueWorker } from '../dist/queue.js'
import { localUploadStatus, runUpload } from '../dist/uploader.js'
import {
  clearTransportCooldown,
  completeClaudeTurn,
  env,
  waitForDrain,
  workspace
} from './fixtures/integration-fixture.mjs'

test('transport failure keeps the durable outbox and a later flush drains it', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const log = join(root, 'transport.log')
  const testEnv = env(log)
  const initialized = await initWorkspace(root, 'claude', testEnv)
  await completeClaudeTurn(initialized.workspace, testEnv, 'retry-session', 'retry.txt')

  const failed = await runUpload(initialized.workspace, { env: { ...testEnv, FAKE_TRANSPORT_MODE: 'fail' } })
  assert.equal(failed.uploaded, 0)
  assert.ok(failed.deferredUntilMs > Date.now(), 'an unrecognised failure must schedule a retry')
  const afterFailure = await localUploadStatus(initialized.workspace)
  assert.equal(afterFailure.outboxPending, 1)
  assert.equal(afterFailure.deadLetterRecords, 0)

  // Retry after the recorded backoff instead of waiting on the wall clock.
  const outbox = join(initialized.workspace, '.scry/upload/outbox')
  const name = (await readdir(outbox)).find(entry => entry.endsWith('.json'))
  const envelope = JSON.parse(await readFile(join(outbox, name)))
  envelope.localRetry.notBeforeMs = 0
  await writeFile(join(outbox, name), JSON.stringify(envelope))
  await clearTransportCooldown(initialized.workspace)

  const result = await runUpload(initialized.workspace, { env: testEnv })
  assert.equal(result.uploaded, 1)
  assert.equal(result.pending, 0)
  assert.equal((await localUploadStatus(initialized.workspace)).lastError, undefined)
})

test('bounded queue retries preserve payload across exhaustion, cooldown, and worker restart', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const log = join(root, 'transport.log')
  const testEnv = env(log)
  const { workspace: canonicalRoot } = await initWorkspace(root, 'claude', testEnv)
  await completeClaudeTurn(canonicalRoot, testEnv, 'automatic-retry-session', 'automatic-retry.txt')

  const jobsDirectory = join(canonicalRoot, '.scry/upload/jobs')
  const outboxDirectory = join(canonicalRoot, '.scry/upload/outbox')
  await writeFile(join(jobsDirectory, 'wakeup-recovery.json'), '{corrupted')
  await Promise.all(Array.from({ length: 10 }, () => enqueueWakeup(canonicalRoot, testEnv)))
  const jobs = (await readdir(jobsDirectory)).filter((name) => name.endsWith('.json'))
  assert.equal(jobs.length, 2) // one callback identity and one coalesced discovery job
  assert.equal(jobs.filter((name) => name === 'wakeup-recovery.json').length, 1)
  const invalid = (await readdir(join(jobsDirectory, 'dead-letter'))).find((name) =>
    name.startsWith('invalid-')
  )
  assert.equal(await readFile(join(jobsDirectory, 'dead-letter', invalid), 'utf8'), '{corrupted')

  const failing = { ...testEnv, FAKE_TRANSPORT_MODE: 'fail' }
  await runQueueWorker(canonicalRoot, failing, { once: true })
  let status = await localUploadStatus(canonicalRoot)
  assert.equal(status.outboxPending, 1)
  assert.equal(status.jobsPending, 2)
  const recordJobPath = join(
    jobsDirectory,
    jobs.find((name) => name.startsWith('record-'))
  )
  const failedJob = JSON.parse(await readFile(recordJobPath, 'utf8'))
  assert.equal(failedJob.attempts, 0)
  // Transient transport cooldown is local state and never consumes the durable
  // job retry budget or dead-letters its custody bytes.
  assert.equal(status.deadLetterJobs, 1)

  const jobPath = join(jobsDirectory, 'wakeup-recovery.json')
  const outboxPath = join(
    outboxDirectory,
    (await readdir(outboxDirectory)).find((name) => name.endsWith('.json'))
  )
  const envelope = JSON.parse(await readFile(outboxPath, 'utf8'))
  envelope.localRetry = { kind: 'report_timeout', attempts: 1, notBeforeMs: Date.now() + 60_000 }
  await writeFile(outboxPath, JSON.stringify(envelope))
  let retryJob = JSON.parse(await readFile(jobPath, 'utf8'))
  retryJob.notBeforeMs = 0
  await writeFile(jobPath, JSON.stringify(retryJob))
  const callsBeforeCooldown = await readFile(log, 'utf8')

  await runQueueWorker(canonicalRoot, testEnv, { once: true })
  status = await localUploadStatus(canonicalRoot)
  assert.equal(status.outboxPending, 1)
  assert.equal(status.jobsPending, 2)
  assert.equal(status.timeoutRecords, 1)
  assert.equal(typeof status.nextRetryAt, 'string')
  // The workspace cooldown gates this background wakeup before any request is
  // made; the record's own retry time is still reported separately.
  assert.equal(await readFile(log, 'utf8'), callsBeforeCooldown)
  retryJob = JSON.parse(await readFile(jobPath, 'utf8'))
  assert.ok(retryJob.notBeforeMs >= Date.now())
  assert.equal(retryJob.attempts, 0)
  assert.equal(await readFile(join(outboxPath), 'utf8').then(JSON.parse).then(value => value.recordId), envelope.recordId)

  envelope.localRetry = undefined
  await writeFile(outboxPath, JSON.stringify(envelope))
  await clearTransportCooldown(canonicalRoot)
  retryJob = JSON.parse(await readFile(jobPath, 'utf8'))
  retryJob.notBeforeMs = 0
  await writeFile(jobPath, JSON.stringify(retryJob))
  retryJob = JSON.parse(await readFile(recordJobPath, 'utf8'))
  retryJob.notBeforeMs = 0
  await writeFile(recordJobPath, JSON.stringify(retryJob))
  await runQueueWorker(canonicalRoot, testEnv, { once: true })
  await runQueueWorker(canonicalRoot, testEnv, { once: true })
  status = await localUploadStatus(canonicalRoot)
  assert.equal(status.outboxPending, 0)
  assert.equal(status.jobsPending, 0)
  assert.equal(status.deadLetterJobs, 1)
})

test('a corrupt outbox item is quarantined without blocking later recovery', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const testEnv = env(join(root, 'transport.log'))
  const initialized = await initWorkspace(root, 'claude', testEnv)
  const base = join(initialized.workspace, '.scry', 'upload')
  await writeFile(join(base, 'outbox', 'corrupt.json'), '{not-json')

  await runQueueWorker(initialized.workspace, testEnv, { once: true })
  const status = await localUploadStatus(initialized.workspace)
  const jobs = await Promise.all(
    (await readdir(join(base, 'jobs')))
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => JSON.parse(await readFile(join(base, 'jobs', name), 'utf8')))
  )
  assert.equal(status.outboxPending, 0, JSON.stringify(jobs.map((job) => job.lastError)))
  assert.equal(status.jobsPending, 0)
  assert.equal(status.deadLetterRecords, 1)
  const quarantined = (await readdir(join(base, 'dead-letter'))).find((name) => name.endsWith('corrupt.json'))
  assert.equal(await readFile(join(base, 'dead-letter', quarantined), 'utf8'), '{not-json')
})

test('detached worker recovers from a temporary outage without manual flush', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const log = join(root, 'transport.log')
  const remainingFailures = join(root, 'failures-left')
  const testEnv = env(log)
  const initialized = await initWorkspace(root, 'claude', testEnv)
  const canonicalRoot = initialized.workspace
  await completeClaudeTurn(canonicalRoot, testEnv, 'background-retry-session', 'background-retry.txt')
  await writeFile(remainingFailures, '2\n')

  const spawnedEnv = { ...testEnv, FAKE_TRANSPORT_FAILS_LEFT_FILE: remainingFailures }
  delete spawnedEnv.SCRY_UPLOADER_NO_SPAWN
  await enqueueWakeup(canonicalRoot, spawnedEnv)

  const status = await waitForDrain(canonicalRoot, 1)
  assert.equal(status?.outboxPending, 0)
  assert.equal(status?.jobsPending, 0)
  assert.equal(status?.deadLetterJobs, 0)
  assert.equal(Number(await readFile(remainingFailures, 'utf8')), 0)
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 3)
})

test('lost success response is retried with the same identity and accepted as duplicate', async (t) => {
  const root = await workspace()
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const log = join(root, 'transport.log')
  const committed = join(root, 'remote-committed-records')
  const testEnv = env(log)
  const initialized = await initWorkspace(root, 'claude', testEnv)
  await completeClaudeTurn(
    initialized.workspace,
    testEnv,
    'ambiguous-success-session',
    'ambiguous-success.txt'
  )

  const spawnedEnv = { ...testEnv, FAKE_TRANSPORT_COMMITTED_FILE: committed }
  delete spawnedEnv.SCRY_UPLOADER_NO_SPAWN
  await enqueueWakeup(initialized.workspace, spawnedEnv)

  const status = await waitForDrain(initialized.workspace, 1)
  assert.equal(status?.outboxPending, 0)
  assert.equal(status?.jobsPending, 0)
  assert.equal(status?.deadLetterRecords, 0)
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].decoded[0].recordId, calls[1].decoded[0].recordId)
  assert.equal((await readFile(committed, 'utf8')).trim(), calls[0].decoded[0].recordId)
})

test('a detached retry worker does not recreate a deleted Git workspace', async (t) => {
  const root = await workspace()
  const removed = `${root}-removed`
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(removed, { recursive: true, force: true })
  })
  const log = join(root, 'transport.log')
  const testEnv = env(log)
  const initialized = await initWorkspace(root, 'claude', testEnv)
  await completeClaudeTurn(
    initialized.workspace,
    testEnv,
    'deleted-workspace-session',
    'deleted-workspace.txt'
  )

  const spawnedEnv = { ...testEnv, FAKE_TRANSPORT_MODE: 'fail' }
  delete spawnedEnv.SCRY_UPLOADER_NO_SPAWN
  await enqueueWakeup(initialized.workspace, spawnedEnv)
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = await localUploadStatus(initialized.workspace)
    if (Number(status.retryingJobs) > 0) break
    await delay(100)
  }
  // Atomically remove the active path. Concurrent recursive rm can itself fail
  // with ENOTEMPTY while a writer creates a temp file, before deletion occurs.
  await rename(root, removed)
  await delay(2_500)
  await assert.rejects(() => stat(root), { code: 'ENOENT' })
})
